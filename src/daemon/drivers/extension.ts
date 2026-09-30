import type WebSocket from 'ws'
import type { Driver, TabInfo, GroupInfo, CdpEventHandler } from '../types.ts'
import { BxError, withTimeout } from '../../common/util.ts'

/**
 * 插件模式：浏览器里的 bx 插件通过 ws 连到 daemon。
 * 插件把 chrome.tabs / chrome.tabGroups 暴露出来，并用 chrome.debugger 转发 CDP。
 */
export class ExtensionDriver implements Driver {
  kind = 'extension' as const
  private seq = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; method: string }>()
  private cdpHandlers: CdpEventHandler[] = []
  private goneHandlers: ((id: string, reason: string) => void)[] = []
  private closeHandlers: (() => void)[] = []

  name: string
  info: Record<string, any>
  private ws: WebSocket
  constructor(name: string, ws: WebSocket, info: Record<string, any>) {
    this.name = name
    this.ws = ws
    this.info = info
    ws.on('message', d => this.onMessage(String(d)))
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new BxError('BROWSER_GONE', `浏览器 ${name} 的插件断开了`))
      this.closeHandlers.forEach(h => h())
    })
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw)
    if (msg.type === 'ping') return this.ws.send(JSON.stringify({ type: 'pong' }))
    if (msg.type === 'event') {
      if (msg.kind === 'cdp') this.cdpHandlers.forEach(h => h(String(msg.tabId), msg.method, msg.params))
      else if (msg.kind === 'detached' || msg.kind === 'tabRemoved')
        this.goneHandlers.forEach(h => h(String(msg.tabId), msg.reason || msg.kind))
      return
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new BxError(msg.error.code || 'EXT_ERROR', `${p.method}: ${msg.error.message}`, msg.error.hint))
      else p.resolve(msg.result)
    }
  }

  private call(method: string, params: any = {}, timeout = 60_000): Promise<any> {
    const id = ++this.seq
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
    this.ws.send(JSON.stringify({ id, method, params }))
    return withTimeout(p, timeout, method)
  }

  private toTab = (t: any): TabInfo => ({
    nativeId: String(t.id),
    windowId: t.windowId,
    active: t.active,
    groupId: t.groupId >= 0 ? t.groupId : undefined,
    title: t.title || '',
    url: t.url || t.pendingUrl || '',
  })

  async listTabs() {
    return (await this.call('tabs.list')).map(this.toTab)
  }
  async openTab(url: string, opts: { background?: boolean; windowId?: number }) {
    return this.toTab(await this.call('tabs.open', { url, active: !opts.background, windowId: opts.windowId }))
  }
  async closeTab(id: string) {
    await this.call('tabs.close', { tabId: Number(id) })
  }
  async activateTab(id: string) {
    await this.call('tabs.activate', { tabId: Number(id) })
  }

  groups = {
    list: (): Promise<GroupInfo[]> => this.call('groups.list'),
    create: (ids: string[], opts: { title?: string; color?: string }): Promise<GroupInfo> =>
      this.call('groups.create', { tabIds: ids.map(Number), ...opts }),
    update: (groupId: number, opts: any): Promise<GroupInfo> => this.call('groups.update', { groupId, ...opts }),
    ungroup: async (ids: string[]) => {
      await this.call('groups.ungroup', { tabIds: ids.map(Number) })
    },
  }

  send(id: string, method: string, params: any = {}) {
    return this.call('cdp.send', { tabId: Number(id), method, params })
  }
  async detach(id: string) {
    await this.call('cdp.detach', { tabId: Number(id) }).catch(() => {})
  }
  /** 插件自带的一些能力（不需要 debugger） */
  ext(method: string, params: any = {}) {
    return this.call(method, params)
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
    this.ws.close()
  }
}
