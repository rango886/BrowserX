import type { TabSession } from './session.ts'
import { axIndex, axKey, INTERACTIVE, type AXNode } from './snapshot.ts'
import { BxError, sleep } from '../common/util.ts'

/**
 * 元素定位：所有操作命令的"目标"都走这里，支持四种写法
 *   e15 / @e15                         snapshot 编号（元素没了会按"角色 + 名字 + 第几个"自动重新找）
 *   getByRole('button', { name: '提交' }) / getByLabel('邮箱') / getByText('下一步') / getByPlaceholder('搜索')
 *   其它任何字符串                      CSS 选择器（能穿透 open shadow DOM）
 * 匹配到多个元素时报错并列出候选，不随便挑一个
 */

type TextWant = { text?: string; re?: { source: string; flags: string }; exact?: boolean }
export type Locator =
  | { kind: 'ref'; ref: string }
  | { kind: 'css'; selector: string }
  | ({ kind: 'role'; role: string } & TextWant)
  | ({ kind: 'label' | 'text' | 'placeholder' } & TextWant)

export const isRef = (t: string) => /^@?e\d+$/.test(t.trim())

export function parseTarget(target: string): Locator {
  const t = String(target ?? '').trim()
  if (!t) throw new BxError('BAD_ARGS', '缺少目标元素', '写 snapshot 编号（e12）、CSS 选择器，或 getByRole / getByLabel / getByText')
  if (isRef(t)) return { kind: 'ref', ref: t.replace(/^@/, '') }
  const m = t.match(/^(?:page\.)?getBy(Role|Label|Text|Placeholder)\s*\(([\s\S]*)\)$/)
  if (!m) return { kind: 'css', selector: t }
  let args: any[]
  try {
    args = parseLiterals(m[2])
  } catch (e: any) {
    throw new BxError('BAD_ARGS', `看不懂 ${t}：${e.message}`, "例：getByRole('button', { name: '提交' })、getByText('下一步', { exact: true })")
  }
  const kind = m[1].toLowerCase() as 'role' | 'label' | 'text' | 'placeholder'
  if (kind === 'role') {
    const o = args[1] || {}
    return { kind, role: String(args[0]), ...textWant(o.name, o.exact) }
  }
  return { kind, ...textWant(args[0], args[1]?.exact) }
}

function textWant(v: any, exact?: boolean): TextWant {
  if (v && typeof v === 'object' && '$regex' in v) return { re: { source: v.$regex, flags: v.flags } }
  return v === undefined ? {} : { text: String(v), exact: !!exact }
}

/** 解析 JS 字面量参数：'a', "b", 1, true, { name: 'x', exact: true }, /re/i */
export function parseLiterals(src: string): any[] {
  let i = 0
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++
  }
  const val = (): any => {
    ws()
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i++
      let s = ''
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          i++
          const e = src[i]
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e
        } else s += src[i]
        i++
      }
      if (src[i] !== c) throw new Error('字符串没有结束')
      i++
      return s
    }
    if (c === '/') {
      i++
      let body = ''
      let cls = false
      while (i < src.length && (src[i] !== '/' || cls)) {
        if (src[i] === '\\') body += src[i++]
        else if (src[i] === '[') cls = true
        else if (src[i] === ']') cls = false
        body += src[i++]
      }
      i++
      let flags = ''
      while (/[a-z]/i.test(src[i] || '')) flags += src[i++]
      return { $regex: body, flags }
    }
    if (c === '{') {
      i++
      const o: any = {}
      ws()
      while (i < src.length && src[i] !== '}') {
        let k: string
        if (src[i] === '"' || src[i] === "'") k = val()
        else {
          k = ''
          while (/[\w$]/.test(src[i] || '')) k += src[i++]
        }
        ws()
        if (src[i] !== ':') throw new Error(`对象里 ${k} 后面缺少冒号`)
        i++
        o[k] = val()
        ws()
        if (src[i] === ',') i++
        ws()
      }
      if (src[i] !== '}') throw new Error('对象没有结束')
      i++
      return o
    }
    let s = ''
    while (i < src.length && /[\w.+-]/.test(src[i])) s += src[i++]
    if (s === 'true') return true
    if (s === 'false') return false
    if (s === 'null') return null
    if (s === 'undefined') return undefined
    if (s && !Number.isNaN(Number(s))) return Number(s)
    throw new Error(`第 ${i + 1} 个字符附近有看不懂的写法`)
  }
  const out: any[] = []
  ws()
  while (i < src.length) {
    out.push(val())
    ws()
    if (src[i] === ',') i++
    else if (i < src.length) throw new Error('参数之间要用逗号隔开')
    ws()
  }
  return out
}

const norm = (s: string) => String(s || '').replace(/\s+/g, ' ').trim()

function textOk(name: string, w: TextWant) {
  if (w.re) return new RegExp(w.re.source, w.re.flags).test(name)
  if (w.text === undefined) return true
  return w.exact ? norm(name) === norm(w.text) : norm(name).toLowerCase().includes(norm(w.text).toLowerCase())
}

function describeLocator(l: Locator) {
  const w = l as any
  const t = w.re ? `/${w.re.source}/${w.re.flags}` : w.text !== undefined ? JSON.stringify(w.text) : ''
  if (l.kind === 'role') return `getByRole('${l.role}'${t ? `, { name: ${t} }` : ''})`
  if (l.kind === 'css') return l.selector
  if (l.kind === 'ref') return l.ref
  return `getBy${l.kind[0].toUpperCase() + l.kind.slice(1)}(${t})`
}

const FORM_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'listbox', 'textField', 'ComboBox', 'Date', 'DateTime', 'InputTime', 'ColorWell'])

interface Found {
  bids: number[]
  descs: string[]
}

/** 在无障碍树里按角色 / 名字找 */
async function byAX(s: TabSession, pick: (n: AXNode) => boolean): Promise<Found> {
  const { nodes } = (await s.send('Accessibility.getFullAXTree', {})) as { nodes: AXNode[] }
  const bids: number[] = []
  const descs: string[] = []
  for (const n of nodes) {
    if (n.ignored || !n.backendDOMNodeId || bids.includes(n.backendDOMNodeId)) continue
    if (!pick(n)) continue
    bids.push(n.backendDOMNodeId)
    descs.push(`${n.role?.value} "${norm(n.name?.value || '').slice(0, 60)}"`)
  }
  return { bids, descs }
}

/** 在页面里跑一段返回元素数组的表达式，换成 backendNodeId */
async function byDOM(s: TabSession, expression: string): Promise<Found> {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: false, awaitPromise: true })
  if (r.exceptionDetails) {
    const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text
    throw new BxError('BAD_SELECTOR', `选择器不对：${String(msg).split('\n')[0]}`, '检查 CSS 写法；按文字找用 getByText(...)，按角色找用 getByRole(...)')
  }
  const objId = r.result?.objectId
  if (!objId) return { bids: [], descs: [] }
  try {
    const props = await s.send('Runtime.getProperties', { objectId: objId, ownProperties: true })
    const els = props.result.filter((p: any) => /^\d+$/.test(p.name) && p.value?.objectId).slice(0, 20)
    const bids: number[] = []
    const descs: string[] = []
    for (const p of els) {
      const d = await s.send('DOM.describeNode', { objectId: p.value.objectId })
      const v = await s.send('Runtime.callFunctionOn', {
        objectId: p.value.objectId,
        functionDeclaration: `function(){ const t = (this.innerText || this.value || this.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
          return this.tagName.toLowerCase() + (this.id ? '#' + this.id : '') + (t ? ' "' + t + '"' : '') }`,
        returnByValue: true,
      })
      bids.push(d.node.backendNodeId)
      descs.push(v.result.value)
    }
    return { bids, descs }
  } finally {
    s.send('Runtime.releaseObject', { objectId: objId }).catch(() => {})
  }
}

const DEEP_QUERY = `function __bxDeep(root, sel) {
  const out = [];
  const visit = r => { out.push(...r.querySelectorAll(sel)); for (const el of r.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot) };
  visit(root); return [...new Set(out)];
}`

/** 在页面里用的文字匹配函数（和 textOk 一样的规则） */
function okSrc(w: TextWant) {
  return `const W = ${JSON.stringify(w)};
    const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
    const ok = t => W.re ? new RegExp(W.re.source, W.re.flags).test(t) : W.text === undefined ? true : W.exact ? norm(t) === norm(W.text) : norm(t).toLowerCase().includes(norm(W.text).toLowerCase());`
}

function textExpr(w: TextWant) {
  return `(() => {
    ${okSrc(w)}
    const hits = new Set();
    const visit = root => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const el = n.parentElement;
        if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
        if (ok(n.textContent) || ok(el.innerText || '')) hits.add(el);
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(el.type) && ok(el.value)) hits.add(el);
      }
    };
    visit(document);
    let list = [...hits].filter(el => !el.checkVisibility || el.checkVisibility());
    // 只留最里层的（外层元素的文字也包含这段字）
    list = list.filter(el => !list.some(o => o !== el && el.contains(o)));
    // 完全相等的优先
    const exact = list.filter(el => norm(el.innerText || el.value) === norm(W.text || ''));
    return exact.length ? exact : list;
  })()`
}

async function find(s: TabSession, l: Locator): Promise<Found> {
  switch (l.kind) {
    case 'css':
      return byDOM(s, `(${DEEP_QUERY})(document, ${JSON.stringify(l.selector)})`)
    case 'text':
      return byDOM(s, textExpr(l))
    case 'placeholder':
      return byDOM(s, `(() => { ${okSrc(l)} return (${DEEP_QUERY})(document, '[placeholder]').filter(el => ok(el.placeholder)) })()`)
    case 'role':
      return byAX(s, n => (n.role?.value || '').toLowerCase() === l.role.toLowerCase() && textOk(n.name?.value || '', l))
    case 'label':
      return byAX(s, n => FORM_ROLES.has(n.role?.value || '') && textOk(n.name?.value || '', l))
    default:
      return { bids: [], descs: [] }
  }
}

/** 元素还在页面上吗 */
async function alive(s: TabSession, bid: number) {
  try {
    return (await s.callOn(bid, 'function(){ return this.isConnected }')) === true
  } catch {
    return false
  }
}

/** 编号对应的元素没了（页面局部重绘）：按 snapshot 时记下的"角色 + 名字 + 第几个"再找一次 */
async function relocate(s: TabSession, ref: string): Promise<number | null> {
  const info = s.refInfo.get(ref)
  if (!info) return null
  const { nodes } = (await s.send('Accessibility.getFullAXTree', {})) as { nodes: AXNode[] }
  const list = axIndex(nodes).get(axKey(info.role, info.name))
  const bid = list?.[info.nth]
  if (bid === undefined) return null
  s.rebindRef(ref, bid)
  s.notes.push(`${ref} 原来的元素已经不在了（页面重绘过），按 ${info.role} "${info.name.slice(0, 40)}" 重新定位过`)
  return bid
}

/** 目标字符串 → backendNodeId。CSS / getBy* 找不到时会等一会儿（最多 timeout 毫秒） */
export async function resolveTarget(s: TabSession, target: string, opts: { timeout?: number } = {}): Promise<number> {
  await s.ensure('DOM')
  const l = parseTarget(target)
  if (l.kind === 'ref') {
    const bid = s.resolveRef(l.ref)
    if (await alive(s, bid)) return bid
    const again = await relocate(s, l.ref)
    if (again !== null) return again
    throw new BxError('STALE_REF', `${l.ref} 对应的元素已经不在页面上了，也没能重新找到`, '重新执行 `bx snapshot`，或者改用 getByRole(...) / CSS 选择器定位')
  }
  const end = Date.now() + (opts.timeout ?? 3000)
  while (true) {
    const f = await find(s, l)
    if (f.bids.length === 1) return f.bids[0]
    if (f.bids.length > 1) {
      throw new BxError(
        'AMBIGUOUS',
        `${describeLocator(l)} 匹配到 ${f.bids.length >= 20 ? '20 个以上' : f.bids.length + ' 个'}元素`,
        `候选：${f.descs.slice(0, 8).map((d, i) => `\n    ${i + 1}. ${d}`).join('')}\n  写得更具体一些（加 { exact: true }、换更精确的 CSS），或者 bx snapshot / bx find 拿编号`,
      )
    }
    if (Date.now() >= end) break
    await sleep(250)
  }
  throw new BxError('NO_ELEMENT', `页面上没有找到 ${describeLocator(l)}`, '`bx find <文字>` 或 `bx snapshot -i` 看看页面上有什么')
}

export { INTERACTIVE }
