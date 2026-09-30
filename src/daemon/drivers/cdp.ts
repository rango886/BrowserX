import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { Driver, TabInfo, CdpEventHandler } from '../types.ts'
import { BxError, sleep, withTimeout } from '../../common/util.ts'
import { BX_HOME, ensureDir, type LaunchOpts } from '../../common/paths.ts'

/** 直连 CDP：适合 bx 自己启动的专用浏览器 / 无头浏览器 */
export class CdpDriver implements Driver {
  kind = 'cdp' as const
  info: Record<string, any> = {}
  private ws!: WebSocket
  private seq = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; method: string }>()
  private sessions = new Map<string, string>() // targetId -> sessionId
  private sessionTargets = new Map<string, string>() // sessionId -> targetId
  private attaching = new Map<string, Promise<string>>()
  private cdpHandlers: CdpEventHandler[] = []
  private goneHandlers: ((id: string, reason: string) => void)[] = []
  private closeHandlers: (() => void)[] = []
  child?: ReturnType<typeof spawn>

  name: string
  endpoint: string
  constructor(name: string, endpoint: string) {
    this.name = name
    this.endpoint = endpoint
  }

  async connect() {
    let wsUrl = this.endpoint
    if (!wsUrl.startsWith('ws')) {
      const base = wsUrl.replace(/\/$/, '')
      const res = await fetch(base + '/json/version').catch(() => null)
      if (!res) throw new BxError('CDP_UNREACHABLE', `连不上 ${base}`, '确认浏览器启动时带了 --remote-debugging-port')
      const v: any = await res.json()
      wsUrl = v.webSocketDebuggerUrl
      this.info = { product: v.Browser, endpoint: base }
    }
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res())
      this.ws.once('error', rej)
    })
    this.ws.on('message', d => this.onMessage(String(d)))
    this.ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new BxError('BROWSER_GONE', `浏览器 ${this.name} 断开了`))
      this.closeHandlers.forEach(h => h())
    })
    await this.raw('Target.setDiscoverTargets', { discover: true })
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw)
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new BxError('CDP_ERROR', `${p.method}: ${msg.error.message}`))
      else p.resolve(msg.result)
      return
    }
    const { method, params, sessionId } = msg
    if (method === 'Target.detachedFromTarget') {
      const tid = this.sessionTargets.get(params.sessionId)
      if (tid) {
        this.sessions.delete(tid)
        this.sessionTargets.delete(params.sessionId)
        this.goneHandlers.forEach(h => h(tid, 'detached'))
      }
      return
    }
    if (method === 'Target.targetDestroyed') {
      this.goneHandlers.forEach(h => h(params.targetId, 'closed'))
      return
    }
    if (sessionId) {
      const tid = this.sessionTargets.get(sessionId)
      if (tid) this.cdpHandlers.forEach(h => h(tid, method, params))
    }
  }

  private raw(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = ++this.seq
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
    this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    return withTimeout(p, 60_000, method)
  }

  private async sessionFor(targetId: string): Promise<string> {
    const s = this.sessions.get(targetId)
    if (s) return s
    let p = this.attaching.get(targetId)
    if (!p) {
      p = this.raw('Target.attachToTarget', { targetId, flatten: true }).then(r => {
        this.sessions.set(targetId, r.sessionId)
        this.sessionTargets.set(r.sessionId, targetId)
        return r.sessionId as string
      })
      this.attaching.set(targetId, p)
      p.finally(() => this.attaching.delete(targetId)).catch(() => {})
    }
    return p
  }

  async listTabs(): Promise<TabInfo[]> {
    const { targetInfos } = await this.raw('Target.getTargets')
    return targetInfos
      .filter((t: any) => t.type === 'page' && !t.url.startsWith('devtools://'))
      .map((t: any) => ({ nativeId: t.targetId, title: t.title, url: t.url }))
  }

  async openTab(url: string, opts: { background?: boolean }) {
    const { targetId } = await this.raw('Target.createTarget', { url: url || 'about:blank', background: !!opts.background })
    const tabs = await this.listTabs()
    return tabs.find(t => t.nativeId === targetId) || { nativeId: targetId, title: '', url }
  }

  async closeTab(id: string) {
    await this.raw('Target.closeTarget', { targetId: id })
  }

  async activateTab(id: string) {
    await this.raw('Target.activateTarget', { targetId: id })
  }

  async send(id: string, method: string, params: any = {}) {
    const sid = await this.sessionFor(id)
    return this.raw(method, params, sid)
  }

  async detach(id: string) {
    const sid = this.sessions.get(id)
    if (sid) await this.raw('Target.detachFromTarget', { sessionId: sid }).catch(() => {})
  }

  async closeBrowser() {
    await this.raw('Browser.close').catch(() => {})
  }

  onCdpEvent(h: CdpEventHandler) {
    this.cdpHandlers.push(h)
  }
  onTabGone(h: (id: string, reason: string) => void) {
    this.goneHandlers.push(h)
  }
  onClose(h: () => void) {
    this.closeHandlers.push(h)
  }
  async close() {
    this.ws?.close()
  }
}

/** 找一个可用的 Chrome / Edge */
export function findChrome(): string {
  const cands = [
    process.env.BX_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[]
  const hit = cands.find(p => fs.existsSync(p))
  if (!hit) throw new BxError('NO_CHROME', '找不到 Chrome', '设置环境变量 BX_CHROME 指向浏览器可执行文件')
  return hit
}

/** 启动一个专用浏览器（独立 profile，登录状态会保存在 ~/.bx/profiles/<name>）。已经在运行就直接连上 */
export async function launchBrowser(name: string, opts: LaunchOpts = {}): Promise<CdpDriver> {
  const profile = opts.profile || ensureDir(path.join(BX_HOME, 'profiles', name))
  const stateFile = path.join(profile, 'bx-launch.json')
  // 已经在运行？Chrome 会把调试端口写在 profile/DevToolsActivePort
  const ports: number[] = []
  try {
    ports.push(Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]))
  } catch {}
  try {
    ports.push(JSON.parse(fs.readFileSync(stateFile, 'utf8')).port)
  } catch {}
  for (const p of ports.filter(Boolean)) {
    const ok = await fetch(`http://127.0.0.1:${p}/json/version`).then(r => r.ok, () => false)
    if (ok) {
      const d = new CdpDriver(name, `http://127.0.0.1:${p}`)
      await d.connect()
      d.info.launched = { port: p, profile, reused: true }
      return d
    }
  }
  const exe = opts.executable || findChrome()
  const portFile = path.join(profile, 'DevToolsActivePort')
  try {
    fs.unlinkSync(portFile)
  } catch {}
  const args = [
    `--remote-debugging-port=${opts.port || 0}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(opts.headless ? ['--headless=new'] : []),
    ...(opts.args || []),
    'about:blank',
  ]
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    let port = opts.port
    if (!port) {
      try {
        port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0])
      } catch {
        continue
      }
    }
    const endpoint = `http://127.0.0.1:${port}`
    const ok = await fetch(endpoint + '/json/version').then(r => r.ok, () => false)
    if (ok) {
      const d = new CdpDriver(name, endpoint)
      d.child = child
      await d.connect()
      d.info.launched = { executable: exe, profile, headless: !!opts.headless, pid: child.pid }
      fs.writeFileSync(stateFile, JSON.stringify({ port, pid: child.pid, executable: exe, headless: !!opts.headless }))
      return d
    }
  }
  throw new BxError('LAUNCH_FAILED', `浏览器启动失败: ${exe}`, `可能这个 profile 正被另一个浏览器占用：${profile}`)
}
