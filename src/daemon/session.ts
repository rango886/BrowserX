import type { Driver } from './types.ts'
import { BxError, globToRegExp, sleep } from '../common/util.ts'

export interface NetEntry {
  id: number
  requestId: string
  url: string
  method: string
  type: string
  status?: number
  mime?: string
  size?: number
  failed?: string
  fromCache?: boolean
  start: number
  duration?: number
  postData?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  done: boolean
}

export interface Route {
  id: number
  pattern: string
  action: 'abort' | 'fulfill' | 'continue'
  status?: number
  body?: string
  contentType?: string
  headers?: Record<string, string>
  hits: number
}

type Waiter = { match: (e: NetEntry) => boolean; resolve: (e: NetEntry) => void }

/**
 * 一个标签页的会话：负责这个标签相关的所有状态
 * - 已开启的 CDP domain（按需开启，尽量少开，降低被检测的概率）
 * - snapshot 分配的元素编号（ref → backendNodeId）
 * - 弹窗、控制台、网络记录、拦截规则、注入脚本
 */
export class TabSession {
  enabled = new Set<string>()
  private enabling = new Map<string, Promise<void>>()

  // ---- 元素编号 ----
  refs = new Map<string, number>() // e12 -> backendNodeId
  nodeRefs = new Map<number, string>() // backendNodeId -> e12
  refSeq = 0
  navCount = 0

  // ---- 事件记录 ----
  dialogs: { type: string; message: string; url: string; at: number; handled: string }[] = []
  dialogPolicy: 'accept' | 'dismiss' = 'accept'
  console: { level: string; text: string; at: number; url?: string }[] = []
  net = new Map<string, NetEntry>()
  netOrder: NetEntry[] = []
  netSeq = 0
  netWaiters: Waiter[] = []
  routes: Route[] = []
  routeSeq = 0
  inits: { id: string; source: string; label: string }[] = []
  loading = false
  mainFrameId = ''
  lastUrl = ''

  driver: Driver
  nativeId: string
  shortId: string
  constructor(driver: Driver, nativeId: string, shortId: string) {
    this.driver = driver
    this.nativeId = nativeId
    this.shortId = shortId
  }

  send(method: string, params: any = {}) {
    return this.driver.send(this.nativeId, method, params)
  }

  async ensure(domain: 'Page' | 'Network' | 'Runtime' | 'DOM' | 'Fetch') {
    if (this.enabled.has(domain)) return
    let p = this.enabling.get(domain)
    if (!p) {
      p = (async () => {
        if (domain === 'Fetch') await this.syncFetch()
        else await this.send(`${domain}.enable`, domain === 'Network' ? { maxPostDataSize: 65536 } : {})
        if (domain === 'Page') {
          const { frameTree } = await this.send('Page.getFrameTree')
          this.mainFrameId = frameTree.frame.id
        }
        this.enabled.add(domain)
      })()
      this.enabling.set(domain, p)
      p.finally(() => this.enabling.delete(domain)).catch(() => {})
    }
    return p
  }

  /** 调试连接断了（比如用户点了"取消调试"），状态要重来 */
  reset() {
    this.enabled.clear()
    this.clearRefs()
  }

  clearRefs() {
    this.refs.clear()
    this.nodeRefs.clear()
  }

  refFor(backendNodeId: number) {
    let r = this.nodeRefs.get(backendNodeId)
    if (!r) {
      r = 'e' + ++this.refSeq
      this.nodeRefs.set(backendNodeId, r)
      this.refs.set(r, backendNodeId)
    }
    return r
  }

  resolveRef(ref: string): number {
    const id = this.refs.get(ref.replace(/^@/, ''))
    if (id === undefined) {
      if (this.refs.size === 0)
        throw new BxError('STALE_REF', `编号 ${ref} 无效：当前页面还没有 snapshot，或页面已经跳转`, '先执行 `bx snapshot` 获取新编号')
      throw new BxError('UNKNOWN_REF', `编号 ${ref} 不存在`, '执行 `bx snapshot` 查看当前可用编号')
    }
    return id
  }

  // ---------------- 事件处理 ----------------
  onEvent(method: string, p: any) {
    switch (method) {
      case 'Page.frameNavigated':
        if (!p.frame.parentId) {
          this.navCount++
          this.clearRefs()
          this.lastUrl = p.frame.url
          this.mainFrameId = p.frame.id
        }
        break
      case 'Page.frameStartedLoading':
        if (!this.mainFrameId || p.frameId === this.mainFrameId) this.loading = true
        break
      case 'Page.frameStoppedLoading':
        if (!this.mainFrameId || p.frameId === this.mainFrameId) this.loading = false
        break
      case 'Page.loadEventFired':
        this.loading = false
        break
      case 'Page.javascriptDialogOpening': {
        const accept = p.type === 'beforeunload' || this.dialogPolicy === 'accept'
        this.dialogs.push({ type: p.type, message: p.message, url: p.url, at: Date.now(), handled: accept ? 'accepted' : 'dismissed' })
        if (this.dialogs.length > 50) this.dialogs.shift()
        this.send('Page.handleJavaScriptDialog', { accept, promptText: p.defaultPrompt || '' }).catch(() => {})
        break
      }
      case 'Runtime.consoleAPICalled':
        this.pushConsole(p.type, p.args.map(fmtRemote).join(' '), p.stackTrace?.callFrames?.[0]?.url)
        break
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails
        this.pushConsole('exception', d.exception?.description || d.text, d.url)
        break
      }
      case 'Network.requestWillBeSent': {
        const e: NetEntry = {
          id: ++this.netSeq,
          requestId: p.requestId,
          url: p.request.url,
          method: p.request.method,
          type: (p.type || 'other').toLowerCase(),
          start: Date.now(),
          postData: p.request.postData,
          requestHeaders: p.request.headers,
          done: false,
        }
        // 重定向：同一个 requestId 会再来一次
        const old = this.net.get(p.requestId)
        if (old) old.done = true
        this.net.set(p.requestId, e)
        this.netOrder.push(e)
        if (this.netOrder.length > 1000) {
          const x = this.netOrder.shift()!
          if (this.net.get(x.requestId) === x) this.net.delete(x.requestId)
        }
        break
      }
      case 'Network.responseReceived': {
        const e = this.net.get(p.requestId)
        if (e) {
          e.status = p.response.status
          e.mime = p.response.mimeType
          e.fromCache = p.response.fromDiskCache || p.response.fromServiceWorker
          e.responseHeaders = p.response.headers
          if (p.type) e.type = p.type.toLowerCase()
        }
        break
      }
      case 'Network.loadingFinished': {
        const e = this.net.get(p.requestId)
        if (e) {
          e.done = true
          e.size = p.encodedDataLength
          e.duration = Date.now() - e.start
          this.fireNetWaiters(e)
        }
        break
      }
      case 'Network.loadingFailed': {
        const e = this.net.get(p.requestId)
        if (e) {
          e.done = true
          e.failed = p.blockedReason ? `blocked:${p.blockedReason}` : p.errorText
          e.duration = Date.now() - e.start
          this.fireNetWaiters(e)
        }
        break
      }
      case 'Fetch.requestPaused':
        this.onRequestPaused(p).catch(() => {})
        break
    }
  }

  private pushConsole(level: string, text: string, url?: string) {
    this.console.push({ level, text: text.slice(0, 2000), at: Date.now(), url })
    if (this.console.length > 500) this.console.shift()
  }

  private fireNetWaiters(e: NetEntry) {
    const hit = this.netWaiters.filter(w => w.match(e))
    this.netWaiters = this.netWaiters.filter(w => !hit.includes(w))
    hit.forEach(w => w.resolve(e))
  }

  waitForResponse(pattern: string, timeout = 30000): Promise<NetEntry> {
    const re = pattern.includes('*') ? globToRegExp(pattern) : null
    const match = (e: NetEntry) => (re ? re.test(e.url) : e.url.includes(pattern)) && e.type !== 'preflight'
    return new Promise((resolve, reject) => {
      const w: Waiter = { match, resolve }
      this.netWaiters.push(w)
      setTimeout(() => {
        if (!this.netWaiters.includes(w)) return
        this.netWaiters = this.netWaiters.filter(x => x !== w)
        reject(new BxError('TIMEOUT', `等待匹配 ${pattern} 的请求超时 (${timeout}ms)`, '用 `bx net log` 看看实际发出了哪些请求'))
      }, timeout)
    })
  }

  async responseBody(e: NetEntry): Promise<{ body: string; base64: boolean }> {
    try {
      const r = await this.send('Network.getResponseBody', { requestId: e.requestId })
      return { body: r.body, base64: r.base64Encoded }
    } catch (err: any) {
      throw new BxError('NO_BODY', `拿不到请求 #${e.id} 的响应体：${err.message}`, '响应体只在页面跳转前保留；重定向和预检请求没有响应体')
    }
  }

  // ---------------- 请求拦截 ----------------
  async syncFetch() {
    if (this.routes.length === 0) {
      await this.send('Fetch.disable').catch(() => {})
      this.enabled.delete('Fetch')
      return
    }
    const patterns = this.routes.map(r => ({ urlPattern: r.pattern.includes('*') ? r.pattern : `*${r.pattern}*`, requestStage: 'Request' }))
    await this.send('Fetch.enable', { patterns })
    this.enabled.add('Fetch')
  }

  private async onRequestPaused(p: any) {
    const url: string = p.request.url
    const route = this.routes.find(r => (r.pattern.includes('*') ? globToRegExp(r.pattern).test(url) : url.includes(r.pattern)))
    if (!route) return this.send('Fetch.continueRequest', { requestId: p.requestId })
    route.hits++
    if (route.action === 'abort') return this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' })
    if (route.action === 'fulfill') {
      const headers = { 'content-type': route.contentType || guessType(route.body || ''), 'access-control-allow-origin': '*', ...(route.headers || {}) }
      return this.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: route.status || 200,
        responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })),
        body: Buffer.from(route.body || '').toString('base64'),
      })
    }
    const merged = { ...p.request.headers, ...(route.headers || {}) }
    return this.send('Fetch.continueRequest', {
      requestId: p.requestId,
      headers: Object.entries(merged).map(([name, value]) => ({ name, value: String(value) })),
    })
  }

  // ---------------- JS 执行 ----------------
  /** 在页面主世界执行表达式，返回可序列化的值 */
  async evaluate(expression: string, opts: { timeout?: number; replMode?: boolean } = {}): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: !opts.replMode,
      awaitPromise: true,
      userGesture: true,
      replMode: opts.replMode,
      timeout: opts.timeout,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new BxError('JS_ERROR', `页面 JS 报错：${d.exception?.description || d.text}`.slice(0, 1500))
    }
    // replMode 下表达式结果是 Promise 时不会自动等待，这里补上
    if (opts.replMode && r.result.subtype === 'promise' && r.result.objectId) {
      const a = await this.send('Runtime.awaitPromise', { promiseObjectId: r.result.objectId, returnByValue: true })
      if (a.exceptionDetails) throw new BxError('JS_ERROR', `页面 JS 报错：${a.exceptionDetails.exception?.description || a.exceptionDetails.text}`.slice(0, 1500))
      return a.result.value
    }
    if (opts.replMode && r.result.objectId) {
      if (r.result.subtype === 'node') return `<${r.result.description}>`
      const v = await this.send('Runtime.callFunctionOn', { objectId: r.result.objectId, functionDeclaration: 'function(){ return this }', returnByValue: true })
      this.send('Runtime.releaseObject', { objectId: r.result.objectId }).catch(() => {})
      return v.result.value ?? r.result.description
    }
    return r.result.value
  }

  /** 在某个元素上调用函数，this 就是那个元素 */
  async callOn(backendNodeId: number, fn: string, args: any[] = []): Promise<any> {
    let objectId: string
    try {
      objectId = (await this.send('DOM.resolveNode', { backendNodeId })).object.objectId
    } catch {
      throw new BxError('STALE_REF', '元素已经不在页面上了（页面可能刷新或局部重绘过）', '重新执行 `bx snapshot`')
    }
    const r = await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn,
      arguments: args.map(value => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    this.send('Runtime.releaseObject', { objectId }).catch(() => {})
    if (r.exceptionDetails) throw new BxError('JS_ERROR', r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }

  async readyState(): Promise<string> {
    try {
      return await this.evaluate('document.readyState', { timeout: 2000 })
    } catch {
      return 'unknown'
    }
  }

  /** 等页面稳定：主 frame 加载完 + 接口请求告一段落 */
  async settle(maxMs = 8000) {
    const t0 = Date.now()
    const dbg = process.env.BX_DEBUG ? (m: string) => console.log(new Date().toISOString(), 'settle', this.shortId, Date.now() - t0, m) : () => {}
    const end = Date.now() + maxMs
    await sleep(120)
    dbg(`loading=${this.loading}`)
    while (this.loading && Date.now() < end) await sleep(50)
    dbg(`loaded`)
    // 兼底：再确认一下 readyState（导航中途执行可能卡住，所以限时）
    while (Date.now() < end) {
      const rs = await Promise.race([this.readyState(), sleep(800).then(() => 'timeout')])
      if (rs === 'complete' || rs === 'interactive') break
      await sleep(100)
    }
    dbg('ready')
    const inflight = () => this.netOrder.filter(e => !e.done && Date.now() - e.start < 5000 && ['xhr', 'fetch', 'document'].includes(e.type)).length
    if (this.enabled.has('Network')) {
      while (Date.now() < end && inflight() > 0) await sleep(100)
    }
    await sleep(100)
  }
}

function fmtRemote(o: any): string {
  if (o.type === 'string') return o.value
  if ('value' in o) return JSON.stringify(o.value)
  if (o.unserializableValue) return o.unserializableValue
  return o.description || o.type
}

function guessType(body: string) {
  const t = body.trim()
  if (t.startsWith('{') || t.startsWith('[')) return 'application/json; charset=utf-8'
  if (t.startsWith('<')) return 'text/html; charset=utf-8'
  return 'text/plain; charset=utf-8'
}
