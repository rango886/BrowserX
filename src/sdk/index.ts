import path from 'node:path'
import { RpcClient } from '../common/rpc.ts'
import { BxError, patternString, sleep, urlMatches } from '../common/util.ts'
import { grepItems, grepText } from '../common/grep.ts'
import { findLib, hostOf, importLib, libInfo, type LibFn } from './lib.ts'

/**
 * 全局的 bx 对象：bx run 的代码和函数库（lib/<域名>.js）里的函数用的是同一个。
 *
 *   bx.tab(idOrMatch)     按编号（t5）或网址匹配拿到一个标签；匹配不到就后台新开
 *   bx.open(url)          后台新开一个标签
 *   bx.tabs(filter?)      列出标签
 *   bx.read(urlOrTab)     通用阅读（有函数库的 read 就用它），返回 { title, content, … }
 *   bx.lib(domain)        某个域名的函数库：await bx.lib('reddit.com').search('sqlite')
 *   bx.log(...)  bx.sleep(ms)
 *
 * 状态（登录、标签、网络记录）都在 daemon 里，进程退出也不会丢。
 */

export interface BxOptions {
  /** 默认标签（-t / BX_TAB） */
  tab?: string
  /** 默认浏览器（--browser） */
  browser?: string
  cwd?: string
  /** 把这个 bx 和 BxError 放到全局（默认 true） */
  global?: boolean
}

/** 元素目标：snapshot 编号 e12、CSS 选择器、getByRole('button', { name: '提交' }) / getByLabel / getByText */
export type Target = string

export interface ClickOptions {
  double?: boolean
  right?: boolean
  middle?: boolean
  /** 'Shift,Control' 或 ['Shift'] */
  modifiers?: string | string[]
  force?: boolean
  /** 等这次点击触发的下载完成，返回 { download: { file, url, size } } */
  download?: boolean
  save?: string
  /** 操作完顺带返回新的 snapshot（只含可操作元素） */
  snap?: boolean
}

export class Tab {
  bx: Bx
  id: string
  constructor(bx: Bx, id: string) {
    this.bx = bx
    this.id = id
  }
  /** 对这个标签发 RPC */
  c(method: string, params: any = {}) {
    return this.bx.call(method, { tab: this.id, ...params })
  }
  toString() {
    return this.id
  }
  toJSON() {
    return { tab: this.id }
  }

  // ---- 导航 ----
  goto(url: string) {
    return this.c('page.goto', { url })
  }
  back() {
    return this.c('page.back')
  }
  forward() {
    return this.c('page.forward')
  }
  reload() {
    return this.c('page.reload')
  }
  async url(): Promise<string> {
    return this.eval('location.href')
  }
  async title(): Promise<string> {
    return this.eval('document.title')
  }

  // ---- 页面里的 JS ----
  /** 在页面里执行：传函数（会被序列化，不能引用外部变量，参数从后面传）或者表达式字符串 */
  async eval<T = any>(fn: string | ((...a: any[]) => any), ...args: any[]): Promise<T> {
    const code = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : fn
    return (await this.c('page.eval', { code })).value
  }
  /** 在某个元素上执行：fn 的第一个参数是元素，其余参数从后面传 */
  async evalOn<T = any>(target: Target, fn: string | ((el: any, ...a: any[]) => any), ...args: any[]): Promise<T> {
    const code = typeof fn === 'function' ? `(el) => (${fn.toString()})(el, ...${JSON.stringify(args)})` : fn
    return (await this.c('page.eval', { code, target })).value
  }
  /** 用页面自己的 cookie / 登录状态发请求，返回 JSON */
  async fetch<T = any>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<T> {
    const r = await this.c('page.fetch', { url, init })
    if (r.status === 401) throw new BxError('NEED_LOGIN', `401 ${url}`, '没登录或登录过期：请用户在浏览器里登录这个网站后重试')
    if (r.status === 403) throw new BxError('NEED_LOGIN', `403 ${url}`, '可能没登录，也可能被网站拦了（无头 / 新 profile 的浏览器常见）：换用户日常的浏览器，或请用户先登录')
    if (r.status === 429) throw new BxError('BLOCKED', `429 请求太频繁：${url}`, '停一会儿再试，或者放慢速度')
    if (r.status === 404) throw new BxError('NOT_FOUND', `404 ${url}`, '检查参数')
    if (r.status >= 400) throw new BxError('HTTP_ERROR', `${r.status} ${url}`, String(r.text ?? '').slice(0, 300))
    if (r.json === undefined) throw new BxError('NOT_JSON', `响应不是 JSON：${url}`, String(r.text).slice(0, 300))
    return r.json
  }
  async fetchText(url: string, init: any = {}): Promise<string> {
    return (await this.c('page.fetch', { url, init, as: 'text' })).text
  }

  // ---- 看页面 ----
  read(opts: ReadOptions = {}) {
    return this.bx.read(this, opts)
  }
  snapshot(opts: { interactive?: boolean; max?: number } = {}): Promise<{ text: string; refs: number; truncated: boolean }> {
    return this.c('page.snapshot', opts)
  }
  /** 在 snapshot 里搜文字，返回 { text, refs } */
  find(text: string, opts: { max?: number } = {}): Promise<{ text: string; refs: string[] }> {
    return this.c('page.find', { text, ...opts })
  }
  shot(o: { save?: string; full?: boolean; ref?: Target; marks?: boolean } = {}) {
    return this.c('page.shot', { out: o.save && path.resolve(o.save), full: o.full, ref: o.ref, marks: o.marks })
  }
  async cookies(url?: string): Promise<{ name: string; value: string; domain: string }[]> {
    return this.c('cookies.get', { url })
  }

  // ---- 操作 ----
  click(target: Target, o: ClickOptions = {}) {
    return this.c('page.click', { ref: target, ...o, save: o.save && path.resolve(o.save) })
  }
  hover(target: Target) {
    return this.c('page.hover', { ref: target })
  }
  /** fill(目标, 文字) 或一次填多个：fill({ e3: '张三', "getByLabel('同意')": true }) */
  fill(target: Target | Record<string, any>, text?: string, opts: { submit?: boolean; append?: boolean; snap?: boolean } = {}) {
    if (typeof target === 'object') return this.c('page.fillMany', { fields: Object.entries(target).map(([t, value]) => ({ target: t, value })) })
    return this.c('page.fill', { ref: target, text: String(text ?? ''), ...opts })
  }
  type(text: string, opts: { submit?: boolean } = {}) {
    return this.c('page.type', { text, ...opts })
  }
  press(...keys: string[]) {
    return this.c('page.press', { keys })
  }
  select(target: Target, ...values: string[]) {
    return this.c('page.select', { ref: target, values })
  }
  check(target: Target) {
    return this.c('page.check', { ref: target, value: true })
  }
  uncheck(target: Target) {
    return this.c('page.check', { ref: target, value: false })
  }
  /** 目标可以是 <input type=file>，也可以是“点了会弹选文件窗口”的按钮 */
  upload(target: Target, files: string | string[]) {
    return this.c('page.upload', { ref: target, files: ([] as string[]).concat(files).map(f => path.resolve(f)) })
  }
  drag(from: Target, to: Target) {
    return this.c('page.drag', { from, to })
  }
  /** scroll()  scroll('up')  scroll('bottom')  scroll('e12')；返回 { scrollY, atBottom } */
  scroll(dirOrTarget: string = 'down', opts: { amount?: number } = {}) {
    const dirs = ['down', 'up', 'left', 'right', 'top', 'bottom']
    return this.c('page.scroll', dirs.includes(dirOrTarget) ? { dir: dirOrTarget, ...opts } : { ref: dirOrTarget, ...opts })
  }
  /** 按坐标操作（canvas、地图、滑块） */
  get mouse() {
    const m = (action: string, o: any = {}) => this.c('input.mouse', { action, ...o })
    return {
      click: (x: number, y: number, o: { right?: boolean; double?: boolean; middle?: boolean } = {}) => m('click', { x, y, ...o }),
      move: (x: number, y: number) => m('move', { x, y }),
      down: (o: { right?: boolean } = {}) => m('down', o),
      up: (o: { right?: boolean } = {}) => m('up', o),
      wheel: (dx: number, dy: number) => m('wheel', { dx, dy }),
      drag: (x1: number, y1: number, x2: number, y2: number, o: { steps?: number } = {}) => m('drag', { x: x1, y: y1, x2, y2, ...o }),
    }
  }
  /** 按住 / 松开一个键：keyDown('Shift') … keyUp('Shift') */
  keyDown(key: string) {
    return this.c('input.key', { action: 'down', key })
  }
  keyUp(key: string) {
    return this.c('input.key', { action: 'up', key })
  }

  // ---- 等待 / 网络 ----
  /** url 可以是子串、带 * 的通配、'/正则/' 字符串，或者直接传 RegExp */
  waitFor(o: { text?: string; gone?: string; selector?: string; url?: string | RegExp; fn?: string; idle?: boolean; timeout?: number }) {
    return this.c('page.wait', { ...o, url: o.url === undefined ? undefined : patternString(o.url) })
  }
  /** 等下一个匹配的接口返回，拿到它的 JSON（先调用它，再触发导航/点击） */
  async waitResponse(match: string | RegExp, opts: { timeout?: number } = {}) {
    const r = await this.c('net.wait', { match: patternString(match), ...opts })
    return r.json ?? r.body
  }
  /**
   * 让网站自己发请求，我们接住返回：等请求 → 交出结果 → 调 more() 触发下一页 → 再等；
   * 连续 idle 次（默认 2）等不到新请求就结束。more() 返回 false 也结束。
   *   for await (const res of tab.collect('/api/search', { more: () => tab.scroll() })) { ... }
   * 默认交出响应的 JSON（不是 JSON 就是文本）；full: true 交出 { url, status, json | body }。
   * past: true 把调用之前已经记录到的匹配请求也算上。
   */
  async *collect(match: string | RegExp, o: { more?: () => any; timeout?: number; idle?: number; limit?: number; full?: boolean; past?: boolean } = {}): AsyncGenerator<any> {
    if (match instanceof RegExp) match = patternString(match)
    const timeout = o.timeout ?? 5000
    const idle = o.idle ?? 2
    let after = o.past ? 0 : (await this.c('net.mark')).seq
    let misses = 0
    let n = 0
    while (true) {
      const end = Date.now() + timeout
      let got: any[] = []
      while (Date.now() < end) {
        got = (await this.c('net.since', { match, after })).items
        if (got.length) break
        await sleep(250)
      }
      if (got.length) {
        misses = 0
        for (const e of got) {
          after = Math.max(after, e.id)
          yield o.full ? e : (e.json ?? e.body)
          if (++n >= (o.limit ?? Infinity)) return
        }
      } else if (++misses >= idle) return
      if (o.more) {
        const r = await o.more()
        if (r === false) return
      }
    }
  }

  // ---- 标签 ----
  activate() {
    return this.bx.call('tab.activate', { id: this.id })
  }
  close() {
    this.bx.forget(this.id)
    return this.bx.call('tab.close', { ids: [this.id] })
  }
}

export interface ReadOptions {
  mode?: 'brief' | 'default' | 'full'
  brief?: boolean
  full?: boolean
  section?: string
  offset?: number
  limit?: number
  budget?: number
  /** lib | readability | list | outline */
  via?: string
  links?: boolean
  scroll?: number
  /** bx.read(url) 时保留打开的标签（默认读完就关） */
  keep?: boolean
  /** 只留匹配的段落（带上下文）。字符串按正则、不分大小写：'断货|限购'；也可以传 RegExp */
  grep?: string | RegExp
  /** grep 时前后各带几个段落 / 句子（默认 1） */
  context?: number
}

export type Bx = ReturnType<typeof createBx>

export function createBx(o: BxOptions = {}) {
  let client: Promise<RpcClient> | null = null
  const cwd = o.cwd || process.cwd()
  /** 这个进程自己开的标签（bx.open，或 bx.tab 没找到而新开的），bx.cleanup() 时关掉 */
  const opened = new Set<string>()

  const bx = {
    options: o,
    /** bx run -f x.js a b 时的 ['a', 'b'] */
    args: [] as string[],
    BxError,
    rpc(): Promise<RpcClient> {
      return (client ||= RpcClient.connect())
    },
    async call<T = any>(method: string, params: any = {}): Promise<T> {
      return (await bx.rpc()).call(method, params)
    },

    /**
     * 拿一个标签：
     *   bx.tab()                当前标签（-t / BX_TAB 指定的，或 daemon 的当前标签）
     *   bx.tab('t5')            按编号
     *   bx.tab('bilibili.com')  复用已打开的、网址匹配的标签（带着登录状态）；没有就后台新开
     * 第二个参数 { open: 'https://www.bilibili.com' } 指定匹配不到时打开哪个网址（默认 https://<域名>）
     */
    async tab(idOrMatch?: string, opts: { open?: string | false } = {}): Promise<Tab> {
      if (!idOrMatch) {
        if (o.tab) return new Tab(bx, o.tab)
        const cur = await bx.call('tab.current')
        if (!cur?.current) throw new BxError('NO_TAB', '没有当前标签', '用 bx.tab("t5") / bx.tab("域名") / bx.open(url)，或者 bx run -t t5')
        return new Tab(bx, cur.current)
      }
      if (/^t?\d+$/.test(idOrMatch)) return new Tab(bx, idOrMatch.startsWith('t') ? idOrMatch : 't' + idOrMatch)
      // -t 指定的标签正好匹配，就用它
      if (o.tab) {
        const url = await bx.call('page.eval', { tab: o.tab, code: 'location.href' }).then(r => r.value, () => '')
        if (url && urlMatches(url, idOrMatch)) return new Tab(bx, o.tab)
      }
      const open = opts.open === false ? undefined : opts.open || (/^https?:\/\//.test(idOrMatch) ? idOrMatch : idOrMatch.includes('*') ? undefined : `https://${idOrMatch}`)
      const r = await bx.call('tab.find', { match: idOrMatch, open, browser: o.browser })
      if (!r) throw new BxError('NO_TAB', `没有网址匹配 ${idOrMatch} 的标签`, '传 { open: 网址 } 让它自动打开')
      if (!r.reused) opened.add(r.id)
      return new Tab(bx, r.id)
    },
    /** 后台新开一个标签（不切换当前标签，不抢焦点）。用完记得 tab.close() */
    async open(url: string, opts: { browser?: string; group?: string } = {}): Promise<Tab> {
      const r = await bx.call('tab.open', { url, background: true, keep: true, browser: opts.browser || o.browser, group: opts.group })
      opened.add(r.id)
      return new Tab(bx, r.id)
    },
    /** 关掉这个进程自己开的、还没关的标签（用户原来的标签不动）。返回关掉的编号 */
    async cleanup(): Promise<string[]> {
      const ids = [...opened]
      opened.clear()
      if (ids.length) await bx.call('tab.close', { ids }).catch(async () => {
        for (const id of ids) await bx.call('tab.close', { ids: [id] }).catch(() => {})
      })
      return ids
    },
    /** 标签关掉了，不再记着它 */
    forget(id: string) {
      opened.delete(id)
    },
    async tabs(filter?: string): Promise<{ id: string; title: string; url: string; browser: string }[]> {
      return bx.call('tab.list', { filter, browser: o.browser })
    },

    /** 读页面：网址（后台开标签，读完关掉）、Tab、标签编号，或者不传（当前标签） */
    async read(target?: string | Tab, opts: ReadOptions = {}): Promise<any> {
      let tab: Tab
      let temp = false
      if (target instanceof Tab) tab = target
      else if (typeof target === 'string' && /^(https?:\/\/|[\w-]+(\.[\w-]+)+\/)/.test(target)) {
        tab = await bx.open(/^https?:/.test(target) ? target : 'https://' + target)
        temp = !opts.keep
      } else tab = await bx.tab(target)
      try {
        const r = await readTab(bx, tab, opts, cwd)
        if (!temp) r.tab ??= tab.id
        return r
      } finally {
        if (temp) await tab.close().catch(() => {})
      }
    },

    /** 某个域名的函数库：bx.lib('reddit.com').search('sqlite')。先找完整域名，再找上一级 */
    lib(domain: string): Record<string, (...a: any[]) => Promise<any>> {
      const entry = findLib(domain, cwd)
      if (!entry) throw new BxError('NO_LIB', `没有 ${domain} 的函数库`, '`bx lib list` 看有哪些；新写一个放到 ~/.bx/lib/<域名>.js')
      let mod: Promise<Record<string, any>> | null = null
      return new Proxy({} as any, {
        get(_, name) {
          if (typeof name !== 'string' || name === 'then') return undefined
          return async (...args: any[]) => {
            const m = await (mod ||= importLib(entry))
            if (typeof m[name] !== 'function') {
              const fns = Object.keys(m).filter(k => typeof m[k] === 'function')
              throw new BxError('NO_FUNCTION', `${entry.domain} 的函数库里没有 ${name}`, `有：${fns.join(', ') || '(无)'}；看用法：bx lib list ${entry.domain}`)
            }
            return m[name](...args)
          }
        },
      })
    },

    log: (...a: any[]) => process.stderr.write(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'),
    sleep,
    close() {
      client?.then(c => c.close(), () => {})
    },
  }
  // 函数库里的代码直接用全局的 bx / BxError，不用 import
  if (o.global !== false) {
    ;(globalThis as any).bx = bx
    ;(globalThis as any).BxError = BxError
  }
  return bx
}

/** 函数列表（bx read 末尾附上，让 AI 知道这个网站还能干什么） */
function libSummary(file: string, domain: string) {
  try {
    const info = libInfo({ domain, file, scope: '' })
    const functions = info.functions.filter(f => f.name !== 'read').map(f => ({ name: f.name, signature: f.signature, summary: f.summary }))
    return functions.length ? { domain, file, functions } : undefined
  } catch {
    return undefined
  }
}

async function readTab(bx: Bx, tab: Tab, o: ReadOptions, cwd: string) {
  if (o.grep !== undefined && o.grep !== '') return applyGrep(await readTabRaw(bx, tab, { ...o, mode: 'full', budget: 1e7, offset: undefined }, cwd), o)
  return readTabRaw(bx, tab, o, cwd)
}

/** grep 后处理：正文按段落 / 句子过滤，列表按条目过滤 */
function applyGrep(res: any, o: ReadOptions) {
  const pattern = o.grep!
  const label = pattern instanceof RegExp ? String(pattern) : pattern
  delete res.more
  delete res.range
  if (Array.isArray(res.items)) {
    const before = res.items.length
    res.items = grepItems(res.items, pattern)
    res.grep = { pattern: label, hits: res.items.length, of: `${before} 项` }
    return res
  }
  const content = typeof res.content === 'string' ? res.content : ''
  const g = grepText(content, pattern, { context: o.context, budget: o.budget || 6000 })
  res.matches = g.matches
  res.content = g.matches.length
    ? g.matches.map(m => `〔@${m.offset}〕 ${m.text}`).join('\n\n⋯\n\n')
    : `(没有匹配 ${label} 的内容)`
  res.grep = {
    pattern: label,
    hits: g.hits,
    blocks: g.matches.length,
    of: `${g.total} 字`,
    ...(g.truncated ? { truncated: `超出 ${o.budget || 6000} 字预算，后面的匹配没显示；加 --budget 或把关键词写得更窄` } : {}),
    ...(g.matches.length ? { tip: '〔@数字〕是这一块在全文里的位置，bx read --offset 数字 从那里接着读' } : {}),
  }
  return res
}

async function readTabRaw(bx: Bx, tab: Tab, o: ReadOptions, cwd: string) {
  const url = await tab.url()
  const mode = o.mode || (o.brief ? 'brief' : o.full ? 'full' : 'default')
  const warnings: string[] = []
  const generic = ['readability', 'list', 'outline', 'generic'].includes(o.via || '')
  const entry = /^https?:/.test(url) ? findLib(hostOf(url), cwd) : null
  const lib = entry ? libSummary(entry.file, entry.domain) : undefined

  if (entry && !generic) {
    const mod = await importLib(entry).catch(e => (warnings.push(e.message), null))
    if (mod && typeof mod.read === 'function') {
      try {
        for (let i = 0; i < (o.scroll ?? 0); i++) {
          await tab.scroll('down')
          await sleep(500)
        }
        const r = await mod.read(tab, { mode, section: o.section, offset: o.offset || 0, limit: o.limit, budget: o.budget || 6000, links: o.links })
        if (r != null && !(typeof r === 'object' && r.fallback)) {
          const res = typeof r === 'string' ? { content: r } : r
          return { url, via: `lib:${entry.domain}`, ...res, ...(lib ? { lib } : {}) }
        }
        warnings.push(`${entry.domain} 的 read() 没有处理这个页面，改用通用提取`)
      } catch (e: any) {
        warnings.push(`${entry.domain} 的 read() 出错（${e.code && e.code !== 'ERROR' ? e.code + ' ' : ''}${String(e.message).slice(0, 200)}），改用通用提取`)
      }
    } else if (o.via === 'lib') throw new BxError('NO_READ', `${entry.domain} 的函数库没有 read()`)
  } else if (o.via === 'lib') throw new BxError('NO_LIB', `${hostOf(url)} 没有函数库`)

  const res = await tab.c('page.read', { mode, section: o.section, offset: o.offset, limit: o.limit, budget: o.budget, via: generic ? o.via : undefined, links: o.links, scroll: o.scroll })
  if (warnings.length) res.warnings = [...(res.warnings || []), ...warnings]
  if (lib) res.lib = lib
  return res
}

export type { LibFn }
export { urlMatches, BxError, sleep }
