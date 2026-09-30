import fs from 'node:fs'
import path from 'node:path'
import type { TabSession, NetEntry } from './session.ts'
import { BX_HOME, ensureDir } from '../common/paths.ts'
import { BxError } from '../common/util.ts'

/**
 * trace 录制：把"做了什么 + 页面发了什么请求 + 看到了什么"都记下来，
 * 之后由 digest 整理成一份给 AI 看的调查报告。
 *
 * 记录的东西：
 * - action：通过 bx 做的操作（goto / click / fill …），带目标元素的描述
 * - user：用户在页面上手动做的操作（点击、输入、提交），适合"人演示一遍，AI 写脚本"
 * - navigate：主 frame 跳转
 * - observe：AI 看到的内容（read / snapshot / eval 的输出），用来做数据溯源
 * - mark：手动标注（bx trace mark "现在翻到第二页"）
 * - requests：接口请求，xhr / fetch / document 的响应体单独存文件
 */

export interface TraceEvent {
  t: number
  tab: string
  type: 'action' | 'user' | 'navigate' | 'observe' | 'mark' | 'dialog' | 'newtab'
  [k: string]: any
}

export interface TraceRequest {
  id: number
  tab: string
  t: number
  method: string
  url: string
  type: string
  status?: number
  mime?: string
  failed?: string
  duration?: number
  postData?: string
  headers?: Record<string, string>
  cookies?: string[]
  body?: string // bodies/<id>.txt
  bodySize?: number
  bodyNote?: string
}

const TRACES_DIR = () => ensureDir(path.join(BX_HOME, 'traces'))
const STATIC = new Set(['image', 'font', 'stylesheet', 'media', 'manifest', 'texttrack', 'ping', 'cspviolationreport', 'preflight', 'signedexchange'])
const BODY_TYPES = new Set(['xhr', 'fetch', 'document', 'other', 'eventsource'])
const MAX_BODY = 3 * 1024 * 1024
const MAX_TOTAL = 80 * 1024 * 1024
// 这些请求头对写脚本有意义（其它的浏览器会自动带）
const KEEP_HEADERS = /^(content-type|authorization|x-.*|referer|origin|accept|csrf.*|.*token.*)$/i

/** 注入页面：记录用户手动操作（通过 binding 回传） */
export const USER_LISTENER = `(() => {
  if (window.__bx_trace_on) return; window.__bx_trace_on = true;
  const send = o => { try { __bx_trace(JSON.stringify(o)) } catch (e) {} };
  const cssPath = el => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && !/\\d{4,}/.test(el.id)) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let e = el, i = 0; e && e.nodeType === 1 && i < 5; e = e.parentElement, i++) {
      if (e.id && !/\\d{4,}/.test(e.id)) { parts.unshift('#' + CSS.escape(e.id)); break }
      let s = e.tagName.toLowerCase();
      const cls = [...e.classList].filter(c => !/\\d{3,}|active|hover|focus|selected/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
      const p = e.parentElement;
      if (p) { const same = [...p.children].filter(x => x.tagName === e.tagName); if (same.length > 1 && !cls.length) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')' }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const desc = el => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
    role: el.getAttribute('role') || undefined, href: el.getAttribute('href') || undefined,
    name: el.getAttribute('name') || undefined, selector: cssPath(el),
  });
  const pick = t => t.closest && (t.closest('a,button,[role=button],[role=tab],[role=link],[role=menuitem],[role=option],input,select,textarea,label,summary,[onclick]') || t);
  addEventListener('click', e => send({ kind: 'click', target: desc(pick(e.target)) }), true);
  addEventListener('change', e => { const t = e.target; if (!t || !t.tagName) return;
    const v = t.type === 'password' ? '***' : t.type === 'checkbox' || t.type === 'radio' ? String(t.checked) : t.tagName === 'SELECT' ? (t.selectedOptions[0]?.label || t.value) : String(t.value).slice(0, 200);
    send({ kind: 'input', target: desc(t), value: v }) }, true);
  addEventListener('submit', e => send({ kind: 'submit', target: desc(e.target) }), true);
  addEventListener('keydown', e => { if (['Enter', 'Escape', 'Tab'].includes(e.key) || ((e.ctrlKey || e.metaKey) && e.key.length === 1))
    send({ kind: 'key', key: (e.ctrlKey ? 'Control+' : '') + (e.metaKey ? 'Meta+' : '') + e.key, target: desc(e.target) }) }, true);
  let st; addEventListener('scroll', () => { clearTimeout(st); st = setTimeout(() => send({ kind: 'scroll', y: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight }), 600) }, true);
})()`

/** 在页面里描述一个元素（给 click / fill 这些 bx 操作用） */
export const DESCRIBE_FN = `function(){
  const el = this;
  const cssPath = e0 => { const parts = [];
    for (let e = e0, i = 0; e && e.nodeType === 1 && i < 5; e = e.parentElement, i++) {
      if (e.id && !/\\d{4,}/.test(e.id)) { parts.unshift('#' + CSS.escape(e.id)); break }
      let s = e.tagName.toLowerCase();
      const cls = [...e.classList].filter(c => !/\\d{3,}|active|hover|focus|selected/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
      const p = e.parentElement;
      if (p) { const same = [...p.children].filter(x => x.tagName === e.tagName); if (same.length > 1 && !cls.length) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')' }
      parts.unshift(s) }
    return parts.join(' > ') };
  return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
    role: el.getAttribute('role') || undefined, href: el.getAttribute('href') || undefined, name: el.getAttribute('name') || undefined, selector: cssPath(el) };
}`

export class Trace {
  name: string
  goal?: string
  dir: string
  startedAt = Date.now()
  tabs = new Map<string, TabSession>()
  events: TraceEvent[] = []
  requests = new Map<string, TraceRequest>() // key: tab|requestId
  reqSeq = 0
  totalBody = 0
  private injected = new Map<string, string>() // tab -> script identifier

  constructor(name: string, goal?: string) {
    this.name = name
    this.goal = goal
    this.dir = path.join(TRACES_DIR(), name)
    if (fs.existsSync(path.join(this.dir, 'trace.json'))) throw new BxError('EXISTS', `trace ${name} 已存在`, '换个名字，或先 `bx trace rm ' + name + '`')
    ensureDir(path.join(this.dir, 'bodies'))
  }

  rel() {
    return +((Date.now() - this.startedAt) / 1000).toFixed(2)
  }

  /** 把一个标签加进录制（开启网络记录、注入用户操作监听） */
  async addTab(s: TabSession, why = 'start') {
    if (this.tabs.has(s.shortId)) return
    this.tabs.set(s.shortId, s)
    s.tracer = this
    await s.ensure('Page')
    await s.ensure('Network')
    await s.ensure('Runtime')
    try {
      await s.send('Runtime.addBinding', { name: '__bx_trace' })
      const { identifier } = await s.send('Page.addScriptToEvaluateOnNewDocument', { source: USER_LISTENER, runImmediately: true })
      this.injected.set(s.shortId, identifier)
      await s.evaluate(USER_LISTENER).catch(() => {})
    } catch {}
    const url = await s.evaluate('location.href').catch(() => '')
    this.events.push({ t: this.rel(), tab: s.shortId, type: why === 'start' ? 'navigate' : 'newtab', url, title: await s.evaluate('document.title').catch(() => '') })
  }

  add(e: Omit<TraceEvent, 't'> & { t?: number }) {
    this.events.push({ t: this.rel(), ...e } as TraceEvent)
  }

  // ---------- 来自 TabSession 的回调 ----------
  onNavigate(s: TabSession, url: string) {
    const last = this.events.findLast(e => e.tab === s.shortId && e.type === 'navigate')
    if (last && last.url === url && this.rel() - last.t < 1) return
    this.add({ tab: s.shortId, type: 'navigate', url })
  }
  onDialog(s: TabSession, d: any) {
    this.add({ tab: s.shortId, type: 'dialog', dialog: d.type, message: d.message })
  }
  onUser(s: TabSession, payload: string) {
    if (s.acting > 0 || Date.now() - s.actedAt < 400) return // bx 自己的操作，不重复记录
    try {
      const o = JSON.parse(payload)
      // 连续的滚动只记最后一次
      const last = this.events[this.events.length - 1]
      if (o.kind === 'scroll' && last?.type === 'user' && last.kind === 'scroll' && last.tab === s.shortId) {
        Object.assign(last, o, { t: this.rel() })
        return
      }
      this.add({ tab: s.shortId, type: 'user', ...o })
    } catch {}
  }
  onRequestStart(s: TabSession, e: NetEntry) {
    if (STATIC.has(e.type)) return
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(e.requestHeaders || {})) if (KEEP_HEADERS.test(k)) headers[k] = String(v).slice(0, 300)
    this.requests.set(`${s.shortId}|${e.requestId}|${e.id}`, {
      id: ++this.reqSeq,
      tab: s.shortId,
      t: +((e.start - this.startedAt) / 1000).toFixed(2),
      method: e.method,
      url: e.url,
      type: e.type,
      postData: e.postData?.slice(0, 20000),
      headers,
    })
  }
  onCookies(s: TabSession, e: NetEntry, names: string[]) {
    const r = this.requests.get(`${s.shortId}|${e.requestId}|${e.id}`)
    if (r) r.cookies = names
  }
  async onRequestDone(s: TabSession, e: NetEntry) {
    const r = this.requests.get(`${s.shortId}|${e.requestId}|${e.id}`)
    if (!r) return
    Object.assign(r, { status: e.status, mime: e.mime, failed: e.failed, duration: e.duration, type: e.type })
    if (STATIC.has(e.type)) return this.requests.delete(`${s.shortId}|${e.requestId}|${e.id}`)
    if (e.failed) return
    const jsonp = e.type === 'script' && /[?&](callback|cb|jsonp)=/.test(e.url)
    if (!BODY_TYPES.has(e.type) && !jsonp) return
    if (this.totalBody > MAX_TOTAL) return void (r.bodyNote = '超出总大小限制，未保存')
    try {
      const b = await s.responseBody(e)
      if (b.base64) return void (r.bodyNote = '二进制')
      if (b.body.length > MAX_BODY) r.bodyNote = `过大，只保存前 ${MAX_BODY} 字符`
      const body = b.body.slice(0, MAX_BODY)
      fs.writeFileSync(path.join(this.dir, 'bodies', `${r.id}.txt`), body)
      r.body = `bodies/${r.id}.txt`
      r.bodySize = b.body.length
      this.totalBody += body.length
    } catch (err: any) {
      r.bodyNote = err.message.slice(0, 100)
    }
  }

  async stop() {
    // 停止前抓一次每个标签的可见文字当作“看到的内容”（用户手动演示时没有 read 输出，靠它做溯源）
    for (const [id, s] of this.tabs) {
      const text = await s.evaluate(`(document.body && document.body.innerText || '').slice(0, 60000)`, { timeout: 3000 }).catch(() => '')
      if (text) this.add({ tab: id, type: 'observe', method: 'page-text', output: text, url: await s.evaluate('location.href').catch(() => '') })
    }
    for (const [id, s] of this.tabs) {
      s.tracer = undefined
      const ident = this.injected.get(id)
      if (ident) await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: ident }).catch(() => {})
      await s.send('Runtime.removeBinding', { name: '__bx_trace' }).catch(() => {})
    }
    // 等一下还没结束的响应体
    await new Promise(r => setTimeout(r, 300))
    const data = {
      version: 1,
      name: this.name,
      goal: this.goal,
      startedAt: new Date(this.startedAt).toISOString(),
      duration: this.rel(),
      tabs: [...this.tabs.keys()],
      events: this.events,
      requests: [...this.requests.values()].sort((a, b) => a.id - b.id),
    }
    fs.writeFileSync(path.join(this.dir, 'trace.json'), JSON.stringify(data, null, 1))
    return { name: this.name, dir: this.dir, duration: data.duration, events: data.events.length, requests: data.requests.length, bodies: data.requests.filter(r => r.body).length }
  }

  status() {
    const count = (t: string) => this.events.filter(e => e.type === t).length
    return {
      name: this.name,
      goal: this.goal,
      seconds: this.rel(),
      tabs: [...this.tabs.keys()],
      actions: count('action'),
      user: count('user'),
      observations: count('observe'),
      requests: this.requests.size,
    }
  }
}

export function listTraces() {
  const dir = TRACES_DIR()
  return fs
    .readdirSync(dir)
    .filter(n => fs.existsSync(path.join(dir, n, 'trace.json')))
    .map(n => {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n, 'trace.json'), 'utf8'))
      return { name: n, goal: j.goal, started: j.startedAt?.slice(0, 16).replace('T', ' '), seconds: j.duration, events: j.events.length, requests: j.requests.length }
    })
}

export function traceDir(name: string) {
  const d = path.join(TRACES_DIR(), name)
  if (!fs.existsSync(path.join(d, 'trace.json'))) throw new BxError('NO_TRACE', `没有 trace ${name}`, '`bx trace list` 查看已有的录制')
  return d
}
