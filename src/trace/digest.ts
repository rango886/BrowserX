import fs from 'node:fs'
import path from 'node:path'

/**
 * 把 trace 整理成给 AI 看的调查报告。
 *
 * 程序擅长、AI 不擅长的"体力活"都在这里做完：
 * 1. 去噪：埋点 / 统计 / 心跳请求
 * 2. 接口归纳：同一个接口的多次请求合并，看参数哪些会变
 * 3. 响应结构：给结构示意，不给完整响应体
 * 4. 数据溯源：拿"看到的内容"去所有响应里搜，找出数据来自哪个接口的哪个字段
 * 5. 参数溯源：参数值来自用户输入 / 页面网址 / 前面某个接口的返回
 * 6. 操作 ↔ 请求：每一步操作触发了哪些接口
 */

// ---------------- 类型 ----------------

interface Req {
  id: number
  tab: string
  t: number
  method: string
  url: string
  type: string
  status?: number
  mime?: string
  failed?: string
  postData?: string
  headers?: Record<string, string>
  cookies?: string[]
  body?: string
  bodySize?: number
  bodyNote?: string
}
interface Ev {
  t: number
  tab: string
  type: string
  [k: string]: any
}
export interface TraceData {
  name: string
  goal?: string
  startedAt: string
  duration: number
  tabs: string[]
  events: Ev[]
  requests: Req[]
}

export function loadTrace(dir: string): TraceData {
  return JSON.parse(fs.readFileSync(path.join(dir, 'trace.json'), 'utf8'))
}

// ---------------- 去噪 / 归纳 ----------------

const NOISE = /(\/log(s|ger|report)?\b|\/track|beacon|analytic|\/collect|\/report\b|\/stat(s)?\b|metrics|sentry|telemetry|hm\.baidu|google-analytics|googletagmanager|doubleclick|googlesyndication|cnzz|umeng|\/ping\b|heartbeat|web-heart|\/rum\b|\/perf\b|\/monitor|\/trace\b|\/event(s)?\b|clarity\.ms|hotjar|mixpanel|segment\.io|\/gen_204|\/log\?|favicon|data\.bilibili\.com|cm\.bilibili\.com)/i

export function isNoise(r: Req) {
  if (r.method === 'OPTIONS') return true
  if (['image', 'font', 'stylesheet', 'media', 'ping', 'preflight', 'manifest'].includes(r.type)) return true
  if (NOISE.test(r.url)) return true
  if (r.type === 'script' && !/[?&](callback|cb|jsonp)=/.test(r.url)) return true
  return false
}

function segTemplate(s: string) {
  if (/^\d+$/.test(s)) return '{n}'
  if (/^BV[0-9A-Za-z]{10}$/.test(s)) return '{bvid}'
  if (/^(?=.*\d)[A-Za-z0-9_-]{16,}$/.test(s)) return '{id}'
  return s
}

export function endpointKey(r: Req) {
  try {
    const u = new URL(r.url)
    return `${r.method} ${u.host}${u.pathname.split('/').map(segTemplate).join('/')}`
  } catch {
    return `${r.method} ${r.url.slice(0, 80)}`
  }
}

// ---------------- 响应体解析 ----------------

type Parsed = { kind: 'json'; value: any } | { kind: 'html'; text: string } | { kind: 'text'; text: string } | { kind: 'none' }

function parseBody(dir: string, r: Req, cache: Map<number, Parsed>): Parsed {
  let p = cache.get(r.id)
  if (p) return p
  p = { kind: 'none' }
  if (r.body) {
    const raw = fs.readFileSync(path.join(dir, r.body), 'utf8')
    const t = raw.trim()
    let v: any
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        v = JSON.parse(t)
      } catch {}
    } else {
      // JSONP：callback({...})
      const m = t.match(/^[\w$.]+\s*\(\s*([\[{][\s\S]*[\]}])\s*\)\s*;?$/)
      if (m) {
        try {
          v = JSON.parse(m[1])
        } catch {}
      }
    }
    if (v !== undefined) p = { kind: 'json', value: v }
    else if (/html/i.test(r.mime || '') || t.startsWith('<')) p = { kind: 'html', text: raw }
    else p = { kind: 'text', text: raw }
  }
  cache.set(r.id, p)
  return p
}

/** 遍历 JSON 的叶子节点：[路径, 值] */
function* leaves(v: any, p = '', depth = 0): Generator<[string, string | number | boolean]> {
  if (depth > 14) return
  if (v === null || v === undefined) return
  if (typeof v !== 'object') {
    yield [p, v]
    return
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < Math.min(v.length, 500); i++) yield* leaves(v[i], `${p}[${i}]`, depth + 1)
    return
  }
  for (const k of Object.keys(v).slice(0, 300)) yield* leaves(v[k], p ? `${p}.${k}` : k, depth + 1)
}

const normPath = (p: string) => p.replace(/\[\d+\]/g, '[]')

// ---------------- "看到的内容" → 候选字符串 ----------------

/** 从观察到的输出（read / snapshot / eval / 页面文字）里提取用来溯源的字符串 */
export function candidatesFrom(outputs: string[], limit = 500, exclude: string[] = []): string[] {
  const set = new Set<string>()
  const skip = new Set(exclude)
  const push = (s: string) => {
    s = s
      .replace(/\[(ref=e\d+|level=\d|checked|selected|expanded|disabled|pressed|required)[^\]]*\]/g, '')
      .replace(/^\s*[-*#>]+\s*/, '')
      .replace(/^\s*\d+\.\s+/, '')
      .replace(/^(text|link|button|heading|textbox|img|image|listitem|cell|row|option|tab|checkbox|combobox|menuitem|searchbox|iframe|clickable)\b[:\s]*/i, '')
      .replace(/\*\*/g, '')
      .replace(/\{options:.*\}$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^"+|"+$/g, '')
      .trim()
    if (s.length < 5 || s.length > 200) return
    if (skip.has(s) || BX_LABELS.test(s)) return
    if (/^https?:\/\/\S+$/.test(s) && (s.length > 150 || skip.has(s.replace(/#.*$/, '')))) return
    if (/^[\d\s:.\-/,]+$/.test(s) && s.replace(/\D/g, '').length < 6) return // 太短的纯数字 / 时间
    set.add(s)
  }
  const walkStr = (s: string) => {
    for (const line of s.split(/\n/)) {
      const quoted = [...line.matchAll(/"([^"]{5,200})"/g)].map(m => m[1])
      if (quoted.length) quoted.forEach(push)
      for (const part of line.split(/\s[·|•]\s|：|: (?=\S)/)) push(part)
    }
  }
  for (const out of outputs) {
    let j: any
    try {
      j = JSON.parse(out)
    } catch {}
    if (j !== undefined && typeof j === 'object') {
      for (const [p, v] of leaves(j)) {
        // bx 自己输出里的说明性字段不算"看到的内容"
        if (/^(sections|hints|warnings|via|type|more|changes|note|refs|truncated|range|total)\b/.test(p)) continue
        if (typeof v === 'string') walkStr(v)
        else if (typeof v === 'number' && String(v).length >= 6) push(String(v))
      }
    } else walkStr(String(j ?? out))
    if (set.size > limit * 3) break
  }
  // 长的、信息量大的优先
  return [...set].sort((a, b) => score(b) - score(a)).slice(0, limit)
}
const BX_LABELS = /^(整页可见文字|JSON-LD 结构化数据|分段（bx read|…\(还有更多|…\(第 |\(已截断|\(跨域 iframe|url: |type: \w+ · via)/

function score(s: string) {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  return Math.min(s.length, 60) + cjk
}

/** 快速多串匹配：用 5 字符片段做索引 */
class Matcher {
  cands: string[]
  private head = new Map<string, number[]>() // 候选的前 5 个字符 → 候选
  private grams = new Map<string, Set<number>>() // 候选里所有 5 字片段 → 候选
  constructor(cands: string[]) {
    this.cands = cands
    cands.forEach((c, i) => {
      const h = c.slice(0, 5)
      ;(this.head.get(h) || this.head.set(h, []).get(h)!).push(i)
      for (let k = 0; k + 5 <= c.length; k++) {
        const g = c.slice(k, k + 5)
        ;(this.grams.get(g) || this.grams.set(g, new Set()).get(g)!).add(i)
      }
    })
  }
  /** 返回被这个字符串"命中"的候选：候选是它的子串，或者它是候选的子串（它够长时） */
  match(s: string): number[] {
    const out = new Set<number>()
    if (s.length >= 5) {
      for (let k = 0; k + 5 <= s.length; k++) {
        const hs = this.head.get(s.slice(k, k + 5))
        if (hs) for (const i of hs) if (s.startsWith(this.cands[i], k)) out.add(i)
      }
      if (s.length >= 8) {
        const gs = this.grams.get(s.slice(0, 5))
        if (gs) for (const i of gs) if (this.cands[i].includes(s)) out.add(i)
      }
    }
    return [...out]
  }
}

// ---------------- 参数分析 ----------------

interface ParamInfo {
  key: string
  values: string[]
  calls: number
  notes: string[]
}

const SIGN_KEY = /^(w_rid|sign|signature|_signature|x-bogus|a_bogus|x_bogus|mstoken|sig|_sig|s_v_web_id|verifyfp|fp|x-s|x-t|x-s-common)$/i
const PAGE_KEY = /^(pn|page|p|pageno|page_num|pagenum|pageindex|offset|cursor|next|next_offset|start|pagination_str|max_id|since_id|after|before|last_id|page_token|pagetoken)$/i

function paramsOf(r: Req): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    new URL(r.url).searchParams.forEach((v, k) => (out[k] = v))
  } catch {}
  if (r.postData) {
    const t = r.postData.trim()
    if (t.startsWith('{')) {
      try {
        const j = JSON.parse(t)
        for (const [k, v] of Object.entries(j)) out['body.' + k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
      } catch {}
    } else if (/^[\w.%-]+=/.test(t)) {
      new URLSearchParams(t).forEach((v, k) => (out['body.' + k] = v))
    }
  }
  return out
}

// ---------------- 形状渲染 ----------------

function typeOf(v: any) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'num'
  if (typeof v === 'string') return 'str'
  return typeof v
}

function sample(v: any) {
  if (typeof v === 'string') {
    const s = v.replace(/\s+/g, ' ')
    return JSON.stringify(s.length > 40 ? s.slice(0, 40) + '…' : s)
  }
  return JSON.stringify(v)
}

/** 把 JSON 画成结构示意，★ 标出看到的数据所在的字段 */
function renderShape(v: any, hot: Set<string>, maxLines = 50): string[] {
  const lines: string[] = []
  const hasHot = hot.size > 0
  const hotPrefix = (p: string) => [...hot].some(h => h === p || h.startsWith(p + '.') || h.startsWith(p + '['))
  const keysOf = (o: any) => {
    const ks = Object.keys(o)
    return `{${ks.slice(0, 8).join(', ')}${ks.length > 8 ? ', …' : ''}}`
  }
  // 有 ★ 时：没有 ★ 的子树折叠成一行；没有 ★ 时：展开两层
  const fold = (p: string, depth: number) => (hasHot ? !hotPrefix(p) : depth >= 2)
  const walk = (x: any, p: string, key: string, ind: string, depth: number) => {
    if (lines.length >= maxLines) return
    const t = typeOf(x)
    const star = hot.has(p) ? ' ★' : ''
    if (t === 'array') {
      const first = x.find((e: any) => e && typeof e === 'object') ?? x[0]
      const isObj = first && typeof first === 'object' && !Array.isArray(first)
      if (fold(p, depth) || !x.length) {
        lines.push(`${ind}${key}: [${x.length} 项]${isObj ? ' ' + keysOf(first) : x.length ? ` ${typeOf(first)}` : ''}`)
        return
      }
      lines.push(`${ind}${key}: [${x.length} 项]${hotPrefix(p + '[]') ? ' ★' : ''}`)
      if (isObj) {
        const merged: any = {}
        for (const e of x.slice(0, 5)) if (e && typeof e === 'object') for (const k of Object.keys(e)) if (!(k in merged)) merged[k] = e[k]
        walkObj(merged, p + '[]', ind + '  ', depth + 1)
      } else lines.push(`${ind}  - ${typeOf(first)} 例 ${sample(first)}${hot.has(p + '[]') ? ' ★' : ''}`)
      return
    }
    if (t === 'object') {
      if (fold(p, depth)) {
        lines.push(`${ind}${key}: ${keysOf(x)}`)
        return
      }
      lines.push(`${ind}${key}:${star}`)
      walkObj(x, p, ind + '  ', depth + 1)
      return
    }
    lines.push(`${ind}${key}: ${t} 例 ${sample(x)}${star}`)
  }
  const walkObj = (o: any, p: string, ind: string, depth: number) => {
    const keys = Object.keys(o)
    // 带 ★ 的字段优先，其余按原顺序，太多就折叠；嵌套很深时只展开带 ★ 的
    const hotKeys = keys.filter(k => hotPrefix(p ? `${p}.${k}` : k))
    const rest = keys.filter(k => !hotKeys.includes(k))
    const budget = hasHot && depth >= 3 ? 0 : Math.max(8, 25 - hotKeys.length)
    for (const k of [...hotKeys, ...rest.slice(0, budget)]) walk(o[k], p ? `${p}.${k}` : k, k, ind, depth)
    if (rest.length > budget && lines.length < maxLines) lines.push(`${ind}…还有 ${rest.length - budget} 个字段：${rest.slice(budget, budget + 10).join(', ')}${rest.length - budget > 10 ? ' …' : ''}`)
  }
  if (Array.isArray(v)) walk(v, '', '(根)', '', 0)
  else if (v && typeof v === 'object') walkObj(v, '', '', 0)
  else lines.push(`${typeOf(v)} 例 ${sample(v)}`)
  if (lines.length >= maxLines) lines.push('…（结构太大，已截断；用 bx trace show 看完整内容）')
  return lines
}

// ---------------- 主流程 ----------------

export interface Digest {
  file: string
  text: string
  endpoints: EndpointInfo[]
  candidates: string[]
}

interface EndpointInfo {
  key: string
  reqs: Req[]
  hits: Map<string, Set<number>> // 字段路径 → 命中的候选
  matched: Set<number>
  params: ParamInfo[]
  htmlVar?: string
  htmlWhere?: 'script' | 'body'
  triggers: string[]
  score: number
}

export function digestTrace(dir: string): Digest {
  const tr = loadTrace(dir)
  tr.events.sort((a, b) => a.t - b.t)
  const cache = new Map<number, Parsed>()
  const all = tr.requests
  const noise = all.filter(isNoise)
  const useful = all.filter(r => !isNoise(r))

  // ---- 1. 候选字符串：AI / 用户看到的内容 ----
  const outputs = tr.events.filter(e => e.type === 'observe' && e.output).map(e => String(e.output))
  const pageUrlList = tr.events.filter(e => e.url).map(e => String(e.url).replace(/#.*$/, ''))
  const candidates = candidatesFrom(outputs, 500, pageUrlList)
  const matcher = new Matcher(candidates)

  // 用户输入过的文字（用来做参数溯源）
  const typed: string[] = []
  for (const e of tr.events) {
    if (e.type === 'action' && e.method === 'fill' && e.args?.text) typed.push(String(e.args.text))
    if (e.type === 'action' && e.method === 'type' && e.args?.text) typed.push(String(e.args.text))
    if (e.type === 'user' && e.kind === 'input' && e.value && e.value !== '***') typed.push(String(e.value))
  }
  const pageUrls = tr.events.filter(e => e.url).map(e => String(e.url))

  // ---- 2. 按接口归纳 ----
  const groups = new Map<string, EndpointInfo>()
  for (const r of useful) {
    const k = endpointKey(r)
    let g = groups.get(k)
    if (!g) groups.set(k, (g = { key: k, reqs: [], hits: new Map(), matched: new Set(), params: [], triggers: [], score: 0 }))
    g.reqs.push(r)
  }

  // ---- 3. 数据溯源 + 早先响应里的值索引（参数溯源用） ----
  const valueIndex = new Map<string, { ep: string; path: string; t: number }>()
  for (const r of [...useful].sort((a, b) => a.t - b.t)) {
    const g = groups.get(endpointKey(r))!
    const p = parseBody(dir, r, cache)
    if (p.kind === 'json') {
      let n = 0
      for (const [lp, v] of leaves(p.value)) {
        if (++n > 30000) break
        const s = String(v)
        if ((typeof v === 'number' && s.length >= 4) || (typeof v === 'string' && s.length >= 4 && s.length <= 80 && !/\s/.test(s))) {
          if (!valueIndex.has(s)) valueIndex.set(s, { ep: g.key, path: normPath(lp), t: r.t })
        }
        if (typeof v === 'string' || (typeof v === 'number' && s.length >= 6)) {
          const hit = matcher.match(s.replace(/\s+/g, ' '))
          if (hit.length) {
            const np = normPath(lp)
            const set = g.hits.get(np) || g.hits.set(np, new Set()).get(np)!
            for (const i of hit) {
              set.add(i)
              g.matched.add(i)
            }
          }
        }
      }
    } else if (p.kind === 'html' || p.kind === 'text') {
      const text = p.text
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]
        const at = text.indexOf(c)
        if (at < 0) continue
        g.matched.add(i)
        if (p.kind === 'html') {
          const inScript = text.lastIndexOf('<script', at) > text.lastIndexOf('</script', at)
          if (inScript) {
            g.htmlWhere = 'script'
            const chunk = text.slice(text.lastIndexOf('<script', at), at)
            const m = [...chunk.matchAll(/window\.([\w$]+)\s*=/g)].pop() || [...chunk.matchAll(/id="([\w-]+)"/g)].pop()
            if (m) g.htmlVar = m[0].startsWith('window') ? `window.${m[1]}` : `#${m[1]}`
          } else if (!g.htmlWhere) g.htmlWhere = 'body'
        }
        const set = g.hits.get('(文本)') || g.hits.set('(文本)', new Set()).get('(文本)')!
        set.add(i)
      }
    }
  }

  // ---- 4. 参数分析 ----
  for (const g of groups.values()) {
    const byKey = new Map<string, string[]>()
    for (const r of g.reqs) for (const [k, v] of Object.entries(paramsOf(r))) (byKey.get(k) || byKey.set(k, []).get(k)!).push(v)
    const t0 = Date.parse(tr.startedAt) / 1000
    for (const [k, vals] of byKey) {
      const distinct = [...new Set(vals)]
      const notes: string[] = []
      const bare = k.replace(/^body\./, '')
      const v0 = distinct[0] || ''
      if (SIGN_KEY.test(bare) || (/^[0-9a-f]{32,64}$/i.test(v0) && distinct.length > 1)) notes.push('⚠ 像签名，每次都不一样')
      if (/^\d{10}(\d{3})?$/.test(v0) && Math.abs(Number(v0.slice(0, 10)) - t0) < 86400 * 2) notes.push('时间戳')
      if (PAGE_KEY.test(bare)) notes.push('翻页参数')
      else if (distinct.length > 1 && distinct.every(v => /^\d{1,4}$/.test(v))) {
        const nums = distinct.map(Number).sort((a, b) => a - b)
        if (nums.every((x, i) => i === 0 || x - nums[i - 1] === 1)) notes.push('可能是翻页（连续数字）')
      }
      for (const tx of typed) if (tx && distinct.some(v => v === tx || v.includes(tx))) notes.push(`来自输入 "${tx.slice(0, 30)}"`)
      if (!notes.some(n => n.startsWith('来自')) && v0.length >= 4 && pageUrls.some(u => decodeURIComponent(u).includes(v0))) notes.push('来自页面网址')
      const isTime = notes.includes('时间戳')
      if (!notes.some(n => n.startsWith('来自')) && !isTime && !notes.some(n => n.includes('签名')) && v0.length >= 5) {
        const src = valueIndex.get(v0)
        const firstT = Math.min(...g.reqs.map(r => r.t))
        if (src && src.ep !== g.key && src.t <= firstT) notes.push(`来自 ${src.ep} 的 ${src.path}`)
      }
      if (distinct.length === 1 && vals.length > 1 && !notes.length) notes.push('固定')
      g.params.push({ key: k, values: distinct.slice(0, 4), calls: vals.length, notes })
    }
  }

  // ---- 5. 操作 ↔ 请求 ----
  const steps = tr.events.filter(e => ['action', 'user', 'navigate', 'newtab', 'mark', 'dialog'].includes(e.type))
  const stepReqs: Req[][] = steps.map((e, i) => {
    if (e.type === 'mark' || e.type === 'dialog') return []
    const nextT = steps.slice(i + 1).find(x => x.type !== 'mark' && x.type !== 'dialog')?.t ?? Infinity
    const end = Math.min(nextT, e.t + 8)
    return useful.filter(r => r.t >= e.t - 0.05 && r.t < end && (r.tab === e.tab || e.type === 'newtab'))
  })
  const reqStep = new Map<number, string>()
  steps.forEach((e, i) => {
    for (const r of stepReqs[i]) {
      const g = groups.get(endpointKey(r))!
      const d = describeStep(e)
      if (!g.triggers.includes(d) && g.triggers.length < 3) g.triggers.push(d)
      if (!reqStep.has(r.id)) reqStep.set(r.id, shortStep(e))
    }
  })
  // 参数值随操作变化：比如点了"动画" → rid=1005
  for (const g of groups.values()) {
    for (const p of g.params) {
      if (p.values.length < 2 || p.notes.some(n => n.includes('签名') || n === '时间戳')) continue
      const pairs: string[] = []
      const seen = new Set<string>()
      for (const r of g.reqs) {
        const v = paramsOf(r)[p.key]
        const st = reqStep.get(r.id)
        if (v === undefined || !st || seen.has(v)) continue
        seen.add(v)
        pairs.push(`${st} → ${v.length > 20 ? v.slice(0, 20) + '…' : v}`)
      }
      if (pairs.length >= 2) p.notes.push(`随操作变化：${pairs.slice(0, 5).join('，')}`)
    }
  }

  // ---- 6. 排序：命中越多越重要 ----
  for (const g of groups.values()) {
    const json = g.reqs.some(r => parseBody(dir, r, cache).kind === 'json')
    g.score = g.matched.size * 10 + (json ? 3 : 0) + Math.min(g.reqs.length, 5) + (g.reqs.some(r => ['xhr', 'fetch'].includes(r.type)) ? 2 : 0)
  }
  const ranked = [...groups.values()].sort((a, b) => b.score - a.score)
  // 只命中零星几条的接口（搜索框默认词之类）不算数据来源
  const topHits = ranked[0]?.matched.size || 0
  // 由操作（点击 / 输入）触发的接口，哪怕只命中一条也算：通常就是用户想看的那部分数据
  const byAction = (g: EndpointInfo) => g.triggers.some(t => !/^(打开|新标签|reload|goto)/.test(t))
  const dataEps = ranked.filter(g => g.matched.size > 0 && (g === ranked[0] || g.matched.size >= Math.max(3, topHits * 0.1) || byAction(g)))

  // ================= 渲染 =================
  const L: string[] = []
  const P = (...s: string[]) => L.push(...s)
  const covered = new Set<number>()
  for (const g of groups.values()) g.matched.forEach(i => covered.add(i))
  const bodies = all.filter(r => r.body).length

  P(`# trace 调查报告：${tr.name}`, '')
  if (tr.goal) P(`**目标**：${tr.goal}`, '')
  P(`时长 ${tr.duration}s · 标签 ${tr.tabs.join(', ') || '-'} · ${steps.filter(s => s.type === 'action').length} 个 bx 操作 · ${steps.filter(s => s.type === 'user').length} 个手动操作 · 请求 ${all.length} 个（去掉 ${noise.length} 个埋点/静态资源，剩 ${groups.size} 个接口，保存了 ${bodies} 个响应体）`)
  P(`溯源：从看到的内容里取了 ${candidates.length} 条文字，${covered.size} 条在响应里找到了出处${candidates.length ? `（${Math.round((covered.size / candidates.length) * 100)}%）` : ''}`, '')

  // ---- 结论 ----
  P('## 1. 结论（先看这里）', '')
  if (!candidates.length) P('- ⚠ 录制期间没有"看到的内容"（没有 read / snapshot / eval，停止时也没取到页面文字），没法做数据溯源。下次录制时，拿到数据后执行一次 `bx read`。')
  if (!dataEps.length && candidates.length) P('- 看到的内容在所有保存的响应里都没找到：可能是页面 JS 计算出来的、在 WebSocket 里、或者在录制开始之前就加载好了。建议：录制开始后先 reload 一次，或者直接用 DOM 提取（tab.eval）。')
  for (const g of dataEps.slice(0, 4)) {
    const top = [...g.hits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 4)
    P(`- **数据来源：\`${g.key}\`** —— ${g.matched.size} 条看到的内容来自这里${top.length ? `，在 ${top.map(([p]) => '`' + p + '`').join('、')}` : ''}`)
    const sign = g.params.filter(p => p.notes.some(n => n.includes('签名')))
    const r0 = g.reqs[0]
    const kind = parseBody(dir, r0, cache).kind
    if (kind === 'html') {
      if (g.htmlWhere === 'script') P(`  - 数据直接写在 HTML 的 <script> 里${g.htmlVar ? `（${g.htmlVar}）` : ''} → 打开页面后 \`tab.eval(() => ${g.htmlVar?.startsWith('window') ? g.htmlVar : 'JSON.parse(document.querySelector(...).textContent)'})\` 读出来`)
      else P('  - 数据在 HTML 正文里（服务端渲染）→ 打开页面后用 `tab.eval` 从 DOM 提取，或者 `tab.read()`')
    } else if (sign.length) {
      P(`  - ⚠ 参数里有签名：${sign.map(p => p.key).join(', ')}。方案 A：\`tab.waitResponse('${pathOf(g.key)}')\` 截获页面自己发的请求（触发方式：${g.triggers[0] || '打开页面'}）；方案 B：找到签名算法在 Node 里实现`)
    } else {
      P(`  - 没有签名参数 → 可以直接在页面里调：\`tab.fetch(...)\`（自动带登录状态）`)
    }
    const pg = g.params.filter(p => p.notes.some(n => n.includes('翻页')))
    if (pg.length) P(`  - 翻页：${pg.map(p => `\`${p.key}\`（${p.values.slice(0, 3).join(' → ')}）`).join('，')}`)
    const chained = g.params.filter(p => p.notes.some(n => n.startsWith('来自 ')))
    for (const p of chained) P(`  - 参数 \`${p.key}\` ${p.notes.find(n => n.startsWith('来自 '))} → 需要先调那个接口`)
    const ck = [...new Set(g.reqs.flatMap(r => r.cookies || []))]
    if (ck.length) P(`  - 请求带了 cookie：${ck.slice(0, 8).join(', ')}${ck.length > 8 ? ' …' : ''}（在页面里 fetch 会自动带上）`)
    const hdr = [...new Set(g.reqs.flatMap(r => Object.keys(r.headers || {}).filter(h => /^(x-|authorization|.*token)/i.test(h))))]
    if (hdr.length) P(`  - 带了自定义请求头：${hdr.join(', ')}（可能要在页面 JS 里取，或者从 cookie / localStorage 里找）`)
  }
  P('')

  // ---- 时间线 ----
  P('## 2. 操作时间线', '')
  if (!steps.length) P('(没有记录到操作)')
  steps.forEach((e, i) => {
    const eps = [...new Set(stepReqs[i].map(endpointKey))]
    const epStr = eps.length ? ` → ${eps.slice(0, 4).map(k => '`' + shortKey(k) + '`').join(' ')}${eps.length > 4 ? ` 等 ${eps.length} 个接口` : ''}` : ''
    P(`${i + 1}. [${e.t.toFixed(1)}s ${e.tab}] ${describeStep(e)}${epStr}`)
    if (e.type === 'action' && e.changes?.url) P(`   ↳ 跳到 ${e.changes.url}`)
    if (e.error) P(`   ↳ ✗ ${String(e.error).slice(0, 120)}`)
  })
  P('')

  // ---- 接口详情 ----
  P('## 3. 接口详情（按重要程度）', '')
  const detail = [...dataEps, ...ranked.filter(g => !dataEps.includes(g) && g.reqs.some(r => ['xhr', 'fetch'].includes(r.type) && parseBody(dir, r, cache).kind === 'json')).slice(0, Math.max(0, 5 - dataEps.length))]
  detail.forEach((g, n) => {
    const st = [...new Set(g.reqs.map(r => r.failed ? 'ERR' : r.status))].join('/')
    P(`### ${n + 1}. \`${g.key}\``, '')
    P(`调用 ${g.reqs.length} 次 · 状态 ${st} · 类型 ${[...new Set(g.reqs.map(r => r.type))].join('/')} · 请求 ${g.reqs.slice(0, 6).map(r => '#' + r.id).join(' ')}${g.matched.size ? ` · **命中 ${g.matched.size} 条看到的内容**` : ''}`)
    if (g.triggers.length) P(`触发：${g.triggers.join('；')}`)
    P('', `例：\`${g.reqs[0].url.length > 300 ? g.reqs[0].url.slice(0, 300) + '…' : g.reqs[0].url}\``)
    if (g.reqs[0].postData) P(`请求体：\`${g.reqs[0].postData.slice(0, 300)}\``)
    if (g.params.length) {
      P('', '| 参数 | 取值 | 说明 |', '|---|---|---|')
      for (const p of g.params.slice(0, 25)) P(`| ${p.key} | ${p.values.map(v => '`' + (v.length > 40 ? v.slice(0, 40) + '…' : v).replace(/\|/g, '\\|') + '`').join(' ')}${p.calls > p.values.length ? ` (${p.calls} 次)` : ''} | ${p.notes.join('；')} |`)
    }
    // 响应结构：挑命中最多的那一次
    const rep = [...g.reqs].sort((a, b) => (parseBody(dir, b, cache).kind === 'json' ? 1 : 0) - (parseBody(dir, a, cache).kind === 'json' ? 1 : 0))[0]
    const pb = parseBody(dir, rep, cache)
    if (pb.kind === 'json') {
      P('', `响应结构（#${rep.id}${rep.bodySize ? `，${Math.round(rep.bodySize / 1024)}KB` : ''}${g.hits.size ? '；★ = 看到的数据在这里；折叠的 {…} 是没用到的字段' : ''}）：`, '```')
      P(...renderShape(pb.value, new Set(g.hits.keys()), dataEps.includes(g) ? 50 : 14))
      P('```')
      const hotEx = [...g.hits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 3)
      for (const [p, set] of hotEx) P(`- \`${p}\` ← 例如 "${candidates[[...set][0]].slice(0, 50)}"`)
    } else if (pb.kind === 'html') {
      P('', `响应是 HTML（${Math.round((rep.bodySize || 0) / 1024)}KB）${g.htmlWhere === 'script' ? `，看到的数据在 <script> 里${g.htmlVar ? ` → ${g.htmlVar}` : ''}` : g.htmlWhere === 'body' ? '，看到的数据在 HTML 正文里' : ''}`)
    } else if (rep.bodyNote) P('', `（响应体：${rep.bodyNote}）`)
    P('')
  })

  const others = ranked.filter(g => !detail.includes(g))
  if (others.length) {
    P('## 4. 其它接口', '')
    for (const g of others.slice(0, 40)) P(`- \`${g.key}\` ×${g.reqs.length} (${[...new Set(g.reqs.map(r => r.failed ? 'ERR' : r.status))].join('/')}) #${g.reqs[0].id}`)
    if (others.length > 40) P(`- …还有 ${others.length - 40} 个`)
    P('')
  }
  if (noise.length) {
    const hosts = [...new Set(noise.map(r => hostOf(r.url)))]
    P(`已忽略 ${noise.length} 个埋点/静态资源请求（${hosts.slice(0, 8).join(', ')}${hosts.length > 8 ? ' …' : ''}）`, '')
  }

  const missed = candidates.filter((_, i) => !covered.has(i)).slice(0, 8)
  if (missed.length && covered.size) {
    P('## 5. 没找到出处的内容（例子）', '')
    P('这些是页面上看到了、但在保存的响应里没找到的，通常是页面固定文案、JS 拼出来的，或者在录制前就加载好了：', '')
    for (const m of missed) P(`- ${m.slice(0, 80)}`)
    P('')
  }

  P('## 下一步', '')
  P(`- 看某个响应的完整内容：\`bx trace show ${tr.name} <请求号> [--path data.list]\``)
  P(`- 在所有响应里搜一段文字：\`bx trace find ${tr.name} "文字"\``)
  P(`- 生成脚本骨架：\`bx script new <站点名> --from-trace ${tr.name}\``)
  P(`- 写完后验证：\`bx script test <站点名> <命令> [参数] --from-trace ${tr.name}\``)
  P(`- 写法参考：docs/sites.md（ctx.tab / ctx.open / tab.fetch / tab.waitResponse / tab.eval）`)

  const text = L.join('\n')
  const file = path.join(dir, 'report.md')
  fs.writeFileSync(file, text)
  return { file, text, endpoints: ranked, candidates }
}

function shortStep(e: Ev): string {
  const txt = e.target?.text ? ` "${e.target.text.slice(0, 12)}"` : ''
  if (e.type === 'navigate' || e.type === 'newtab') return '打开页面'
  if (e.type === 'user') return `[手动]${e.kind === 'click' ? '点击' : e.kind}${txt}`
  if (e.type === 'action') return `${e.method}${txt}${e.method === 'fill' && e.args?.text ? ` "${String(e.args.text).slice(0, 12)}"` : ''}`
  return e.type
}

function describeStep(e: Ev): string {
  const tg = e.target ? ` ${e.target.tag}${e.target.text ? ` "${e.target.text.slice(0, 30)}"` : ''}${e.target.selector ? ` (${e.target.selector.slice(0, 80)})` : ''}` : ''
  switch (e.type) {
    case 'navigate':
      return `打开 ${e.url}`
    case 'newtab':
      return `新标签 ${e.url || ''}`
    case 'mark':
      return `📌 ${e.note}`
    case 'dialog':
      return `弹窗 ${e.dialog}: ${e.message}`
    case 'user':
      if (e.kind === 'click') return `[手动] 点击${tg}`
      if (e.kind === 'input') return `[手动] 输入${tg} = "${String(e.value).slice(0, 40)}"`
      if (e.kind === 'submit') return `[手动] 提交表单${tg}`
      if (e.kind === 'key') return `[手动] 按键 ${e.key}${tg}`
      if (e.kind === 'scroll') return `[手动] 滚动到 ${e.y}/${e.max}`
      return `[手动] ${e.kind}`
    case 'action': {
      const a = e.args || {}
      switch (e.method) {
        case 'goto':
          return `goto ${a.url}`
        case 'click':
          return `click ${a.ref}${tg}`
        case 'fill':
          return `fill ${a.ref}${tg} = "${String(a.text ?? '').slice(0, 40)}"${a.submit ? ' + 回车' : ''}`
        case 'press':
          return `press ${(a.keys || []).join(' ')}`
        case 'select':
          return `select ${a.ref}${tg} = ${(a.values || []).join(',')}`
        case 'scroll':
          return `scroll ${a.dir || a.ref || 'down'}`
        case 'tab.open':
          return `tab open ${a.url || ''}`
        case 'fetch':
          return `fetch ${a.url}`
        default:
          return `${e.method}${a.ref ? ' ' + a.ref : ''}${tg}`
      }
    }
  }
  return e.type
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host
  } catch {
    return u.slice(0, 30)
  }
}
const pathOf = (key: string) => key.replace(/^\w+ [^/]+/, '').replace(/\{[^}]+\}/g, '*')
const shortKey = (key: string) => key.replace(/^GET /, '').replace(/^(\w+) /, '$1 ')

// ---------------- 给 CLI 用的小工具 ----------------

export function showRequest(dir: string, id: number, jsonPath?: string, max = 20000) {
  const tr = loadTrace(dir)
  const r = tr.requests.find(x => x.id === id)
  if (!r) throw new Error(`trace ${tr.name} 里没有请求 #${id}`)
  const cache = new Map<number, Parsed>()
  const p = parseBody(dir, r, cache)
  const head: any = { id: r.id, method: r.method, url: r.url, status: r.status, type: r.type, t: r.t }
  if (r.postData) head.postData = r.postData
  if (r.headers && Object.keys(r.headers).length) head.headers = r.headers
  if (r.cookies?.length) head.cookies = r.cookies
  if (p.kind === 'json') {
    let v = p.value
    if (jsonPath) {
      for (const part of jsonPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) v = v?.[part]
    }
    const s = JSON.stringify(v, null, 1)
    head.json = s.length > max ? JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'string' && x.length > 200 ? x.slice(0, 200) + '…' : x))) : v
    if (s.length > max) head.note = `内容很大（${s.length} 字符），长字符串已截断；用 --path 取一部分`
  } else if (p.kind === 'html' || p.kind === 'text') head.body = p.text.length > max ? p.text.slice(0, max) + `…(共 ${p.text.length} 字符)` : p.text
  else head.body = r.bodyNote || '(没有保存响应体)'
  return head
}

export function findInTrace(dir: string, text: string) {
  const tr = loadTrace(dir)
  const cache = new Map<number, Parsed>()
  const out: any[] = []
  for (const r of tr.requests) {
    const p = parseBody(dir, r, cache)
    if (p.kind === 'json') {
      for (const [lp, v] of leaves(p.value)) if (String(v).includes(text)) out.push({ id: r.id, endpoint: endpointKey(r), path: lp, value: String(v).slice(0, 120) })
    } else if (p.kind === 'html' || p.kind === 'text') {
      const at = p.text.indexOf(text)
      if (at >= 0) out.push({ id: r.id, endpoint: endpointKey(r), path: '(文本)', value: p.text.slice(Math.max(0, at - 40), at + text.length + 40).replace(/\s+/g, ' ') })
    }
    if (decodeURIComponent(r.url).includes(text)) out.push({ id: r.id, endpoint: endpointKey(r), path: '(请求网址)', value: r.url.slice(0, 160) })
    if (r.postData?.includes(text)) out.push({ id: r.id, endpoint: endpointKey(r), path: '(请求体)', value: r.postData.slice(0, 160) })
    if (out.length > 100) break
  }
  return out
}

/** 给脚本生成器用：最可能的站点 home / domains */
export function guessSite(tr: TraceData) {
  const hosts = new Map<string, number>()
  for (const e of tr.events) if (e.url) hosts.set(hostOf(e.url), (hosts.get(hostOf(e.url)) || 0) + 1)
  const top = [...hosts.entries()].filter(([h]) => h && !h.startsWith('127.') && h !== 'about:blank').sort((a, b) => b[1] - a[1])[0]?.[0] || [...hosts.keys()][0] || ''
  const root = top.split('.').slice(-2).join('.')
  const home = tr.events.find(e => e.url && hostOf(e.url) === top)?.url
  return { host: top, domain: /^\d+\.\d+/.test(top) || top.includes(':') ? top : root, home: home ? new URL(home).origin : undefined }
}
