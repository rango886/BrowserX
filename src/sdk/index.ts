import { RpcClient } from '../common/rpc.ts'
import { BxError, sleep, urlMatches } from '../common/util.ts'

/**
 * 站点脚本的写法（不需要 import 任何东西）：
 *
 * export default {
 *   name: 'bili',
 *   home: 'https://www.bilibili.com',
 *   domains: ['bilibili.com'],
 *   commands: {
 *     'video info': {
 *       summary: '视频信息',
 *       args: ['bvid'],
 *       opts: { limit: { type: 'number', default: 20, desc: '条数' } },
 *       async *run(ctx) { const tab = await ctx.tab(); yield await tab.fetch(...) }
 *     }
 *   }
 * }
 */
export interface OptSpec {
  type?: 'string' | 'number' | 'boolean'
  default?: any
  desc?: string
  short?: string
  choices?: string[]
}
export interface ArgSpec {
  name: string
  desc?: string
  optional?: boolean
  rest?: boolean
}
export interface CommandSpec {
  summary?: string
  description?: string
  args?: (string | ArgSpec)[]
  opts?: Record<string, OptSpec>
  /** 从管道读入记录时，用记录里的哪个字段当第一个参数（默认同第一个参数名） */
  key?: string | string[]
  examples?: string[]
  run: (ctx: Ctx) => any
}
export interface SiteSpec {
  name: string
  description?: string
  home?: string
  domains?: string[]
  commands: Record<string, CommandSpec>
}

export function normArgs(spec: CommandSpec): ArgSpec[] {
  return (spec.args || []).map(a => {
    if (typeof a !== 'string') return a
    const optional = a.endsWith('?')
    const rest = a.endsWith('...')
    return { name: a.replace(/[?.]+$/, ''), optional, rest }
  })
}

export class Tab {
  rpc: RpcClient
  id: string
  constructor(rpc: RpcClient, id: string) {
    this.rpc = rpc
    this.id = id
  }
  private c(method: string, params: any = {}) {
    return this.rpc.call(method, { tab: this.id, ...params })
  }
  goto(url: string) {
    return this.c('page.goto', { url })
  }
  async url(): Promise<string> {
    return this.eval('location.href')
  }
  /** 在页面里执行：可以传函数（会被序列化，不能引用外部变量）或者表达式字符串 */
  async eval<T = any>(fn: string | ((...a: any[]) => any), ...args: any[]): Promise<T> {
    const code = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : fn
    return (await this.c('page.eval', { code })).value
  }
  /** 用页面自己的 cookie / 登录状态发请求，返回 JSON */
  async fetch<T = any>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<T> {
    const r = await this.c('page.fetch', { url, init })
    if (r.status >= 400) throw new BxError('HTTP_ERROR', `${r.status} ${url}`, r.text?.slice(0, 300))
    if (r.json === undefined) throw new BxError('NOT_JSON', `响应不是 JSON：${url}`, String(r.text).slice(0, 300))
    return r.json
  }
  async fetchText(url: string, init: any = {}): Promise<string> {
    return (await this.c('page.fetch', { url, init, as: 'text' })).text
  }
  read(opts: any = {}) {
    return this.c('page.read', opts)
  }
  snapshot(opts: { interactive?: boolean } = {}) {
    return this.c('page.snapshot', opts)
  }
  click(ref: string) {
    return this.c('page.click', { ref })
  }
  fill(ref: string, text: string, opts: { submit?: boolean } = {}) {
    return this.c('page.fill', { ref, text, ...opts })
  }
  press(...keys: string[]) {
    return this.c('page.press', { keys })
  }
  upload(ref: string, files: string[]) {
    return this.c('page.upload', { ref, files })
  }
  waitFor(o: { text?: string; selector?: string; url?: string; fn?: string; timeout?: number }) {
    return this.c('page.wait', o)
  }
  /** 等下一个匹配的接口返回，拿到它的 JSON（先调用它，再触发导航/点击） */
  async waitResponse(match: string, opts: { timeout?: number } = {}) {
    const r = await this.c('net.wait', { match, ...opts })
    return r.json ?? r.body
  }
  shot(o: { save?: string; full?: boolean } = {}) {
    return this.c('page.shot', { out: o.save, full: o.full })
  }
  cookies() {
    return this.c('cookies.get')
  }
  close() {
    return this.rpc.call('tab.close', { ids: [this.id] })
  }
}

export interface Ctx {
  args: Record<string, any>
  opts: Record<string, any>
  /** 管道输入的整条记录（如果有） */
  input?: any
  site: SiteSpec
  rpc: RpcClient
  /** 拿一个本站点的标签页：优先复用已打开的（带着登录状态），没有就后台新开 home */
  tab(urlOrMatch?: string): Promise<Tab>
  newTab(url: string): Promise<Tab>
  /** 后台打开一个工作标签（要跳转页面时用它，不影响用户自己的标签），命令结束后自动关闭 */
  open(url: string): Promise<Tab>
  log(...a: any[]): void
  sleep(ms: number): Promise<void>
}

export function makeCtx(rpc: RpcClient, site: SiteSpec, args: any, opts: any, input: any, global: { browser?: string; tab?: string; opened?: string[] }): Ctx {
  let cached: Tab | null = null
  return {
    args,
    opts,
    input,
    site,
    rpc,
    async tab(urlOrMatch?: string) {
      if (global.tab) return new Tab(rpc, global.tab)
      if (cached && !urlOrMatch) return cached
      const match = urlOrMatch || site.domains?.[0] || site.home
      if (!match) throw new BxError('BAD_SITE', `站点 ${site.name} 没有声明 home / domains`)
      const open = urlOrMatch?.startsWith('http') ? urlOrMatch : site.home || `https://${match}`
      const r = await rpc.call('tab.find', { match, open, browser: global.browser })
      const t = new Tab(rpc, r.id)
      if (!urlOrMatch) cached = t
      return t
    },
    async newTab(url: string) {
      const r = await rpc.call('tab.open', { url, background: true, keep: true, browser: global.browser })
      return new Tab(rpc, r.id)
    },
    async open(url: string) {
      if (global.tab) {
        const t = new Tab(rpc, global.tab)
        await t.goto(url)
        return t
      }
      const r = await rpc.call('tab.open', { url, background: true, keep: true, browser: global.browser })
      global.opened?.push(r.id)
      return new Tab(rpc, r.id)
    },
    log: (...a) => process.stderr.write(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'),
    sleep,
  }
}

export { urlMatches }
