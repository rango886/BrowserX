import type { TabSession } from './session.ts'

/** 可以操作的角色 → 分配 ref */
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'textField',
  'ComboBox', 'PopUpButton', 'MenuListPopup', 'DisclosureTriangle', 'video', 'audio', 'Date', 'DateTime', 'InputTime', 'ColorWell',
])

/** 不展开内部结构的控件 */
const LEAF = new Set(['Date', 'DateTime', 'InputTime', 'ColorWell', 'slider', 'video', 'audio'])

/** 纯容器：不单独打印，子节点上提 */
const TRANSPARENT = new Set([
  'generic', 'none', 'presentation', 'paragraph', 'Section', 'LineBreak', 'InlineTextBox', 'listitem',
  'cell', 'gridcell', 'strong', 'emphasis', 'Abbr', 'time', 'mark', 'superscript', 'subscript', 'LabelText',
  'Legend', 'Pre', 'code', 'blockquote', 'Canvas', 'Div', 'Span', 'sectionheader', 'sectionfooter', 'ruby',
  'insertion', 'deletion', 'Unknown', 'Ruby', 'RubyAnnotation', 'Caption', 'DescriptionList', 'term', 'definition',
  'Iframe', 'IframePresentational', 'ListMarker',
])

/** 有名字时才打印的角色（landmark 等），没名字就透明 */
const NAMED_ONLY = new Set(['region', 'group', 'form', 'navigation', 'complementary', 'banner', 'main', 'article', 'dialog', 'alertdialog', 'figure', 'contentinfo', 'search'])

/** 块级容器：前后文字不拼在一行 */
const BLOCK = new Set(['paragraph', 'listitem', 'cell', 'gridcell', 'blockquote', 'Pre', 'Section', 'DescriptionList', 'term', 'definition', 'figure', 'contentinfo', 'region', 'form', 'navigation', 'complementary', 'banner', 'main', 'article', 'LabelText', 'Legend', 'Caption', 'sectionheader', 'sectionfooter', 'search'])

const SHOW_PROPS = ['level', 'checked', 'pressed', 'expanded', 'selected', 'disabled', 'required', 'readonly', 'invalid']

interface AXNode {
  nodeId: string
  ignored: boolean
  role?: { value: string }
  name?: { value: string }
  value?: { value: any }
  description?: { value: string }
  properties?: { name: string; value: { value: any } }[]
  childIds?: string[]
  backendDOMNodeId?: number
  parentId?: string
  frameId?: string
}

export interface SnapshotOpts {
  interactive?: boolean // 只看可操作元素 + 标题
  maxLines?: number
  textLimit?: number
}

export async function snapshot(s: TabSession, opts: SnapshotOpts = {}) {
  await s.ensure('Page')
  await s.ensure('DOM')
  const maxLines = opts.maxLines ?? 600
  const textLimit = opts.textLimit ?? 200

  const { nodes } = (await s.send('Accessibility.getFullAXTree', {})) as { nodes: AXNode[] }
  const byId = new Map(nodes.map(n => [n.nodeId, n]))
  const sameName = axIndex(nodes)
  const clickable = await findClickables(s).catch(() => new Map<number, string>())

  // 同进程的 iframe：取它们的 AX 树，挂到对应的 Iframe 节点下面
  const frameRoots = new Map<number, AXNode>() // iframe 元素的 backendNodeId -> 子 frame 的根
  const skippedFrames: string[] = []
  try {
    const { frameTree } = await s.send('Page.getFrameTree')
    const walk = async (ft: any, depth: number) => {
      for (const child of ft.childFrames || []) {
        try {
          const owner = await s.send('DOM.getFrameOwner', { frameId: child.frame.id })
          const sub = (await s.send('Accessibility.getFullAXTree', { frameId: child.frame.id })) as { nodes: AXNode[] }
          sub.nodes.forEach(n => byId.set(n.nodeId + '@' + child.frame.id, { ...n, childIds: n.childIds?.map(c => c + '@' + child.frame.id) }))
          const root = sub.nodes.find(n => !n.parentId)
          if (root) frameRoots.set(owner.backendNodeId, byId.get(root.nodeId + '@' + child.frame.id)!)
        } catch {
          skippedFrames.push(child.frame.url)
        }
        if (depth < 3) await walk(child, depth + 1)
      }
    }
    await walk(frameTree, 0)
  } catch {}

  const root = nodes.find(n => !n.parentId) || nodes[0]
  const lines: string[] = []
  let truncated = false
  let title = ''
  let seenRoot = false
  // 正在拼接的文字行；遇到块级元素换行
  let cur: { idx: number; parent?: string; full: boolean; start: number } | null = null
  let breakNext = false

  const propStr = (n: AXNode) => {
    const out: string[] = []
    for (const p of n.properties || []) {
      if (!SHOW_PROPS.includes(p.name)) continue
      const v = p.value?.value
      if (v === false || v === undefined || v === 'false') continue
      out.push(v === true || v === 'true' ? p.name : `${p.name}=${v}`)
    }
    return out
  }

  const clip = (t: string, n = textLimit) => {
    t = t.replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n) + '…' : t
  }

  // 返回这个子树是否打印了东西
  const visit = (n: AXNode | undefined, depth: number, parentName: string) => {
    if (!n || truncated) return
    if (lines.length >= maxLines) {
      truncated = true
      return
    }
    const role = n.role?.value || ''
    const name = (n.name?.value || '').trim()
    const kids = () => {
      const ch = (n.childIds || []).map(id => byId.get(id))
      // iframe：接上子 frame
      if (n.backendDOMNodeId && frameRoots.has(n.backendDOMNodeId)) ch.push(frameRoots.get(n.backendDOMNodeId))
      return ch
    }

    if (role === 'RootWebArea') {
      if (!seenRoot) {
        seenRoot = true
        title = name
        for (const c of kids()) visit(c, depth, parentName)
      } else {
        lines.push(`${'  '.repeat(depth)}- iframe "${clip(name, 80)}"`)
        for (const c of kids()) visit(c, depth + 1, parentName)
      }
      return
    }

    if (n.backendDOMNodeId && clickable.has(n.backendDOMNodeId) && !INTERACTIVE.has(role)) {
      // 带点击事件的普通元素（div / li …），无障碍树不认为它能点
      lines.push(`${'  '.repeat(depth)}- clickable "${clip(clickable.get(n.backendDOMNodeId)!, 80)}" [ref=${s.refFor(n.backendDOMNodeId)}]`)
      cur = null
      return
    }

    if (n.ignored) {
      for (const c of kids()) visit(c, depth, parentName)
      return
    }

    if (role === 'StaticText') {
      if (opts.interactive) return
      if (!name.trim() && !cur) return
      if (name && (name === parentName || (parentName && name.length > 1 && parentName.includes(name)))) return
      const ind = '  '.repeat(depth)
      if (cur && cur.idx === lines.length - 1 && !breakNext) {
        if (cur.full) return
        const sep = cur.parent === n.parentId || /\s$/.test(lines[cur.idx]) || /^\s/.test(name) ? '' : ' '
        lines[cur.idx] += sep + name
      } else {
        if (!name.trim()) return
        lines.push(`${ind}- text: ${name.trimStart()}`)
        cur = { idx: lines.length - 1, parent: n.parentId, full: false, start: ind.length + 8 }
      }
      cur.parent = n.parentId
      breakNext = false
      const L = lines[cur.idx]
      if (L.length - cur.start > textLimit * 3) {
        lines[cur.idx] = L.slice(0, cur.start + textLimit * 3) + '…'
        cur.full = true
      }
      return
    }

    const interactive = INTERACTIVE.has(role)
    const transparent = TRANSPARENT.has(role) || (NAMED_ONLY.has(role) && !name)
    const keep = interactive || (!transparent && (!opts.interactive || role === 'heading'))

    if (!keep) {
      const block = BLOCK.has(role)
      if (block) breakNext = true
      for (const c of kids()) visit(c, depth, parentName)
      if (block) breakNext = true
      return
    }

    let line = `${'  '.repeat(depth)}- ${role}`
    if (name) line += ` "${clip(name, 120)}"`
    const props = propStr(n)
    if (interactive && n.backendDOMNodeId) {
      // 主页面里的元素记下“角色 + 名字 + 第几个”，页面局部重绘后靠它重新找回来
      const list = n.nodeId.includes('@') ? undefined : sameName.get(axKey(role, name))
      const nth = list ? list.indexOf(n.backendDOMNodeId) : -1
      props.unshift('ref=' + s.refFor(n.backendDOMNodeId, nth >= 0 ? { role, name, nth } : undefined))
    }
    if (props.length) line += ` [${props.join(', ')}]`
    const val = n.value?.value
    if (val !== undefined && val !== '' && role !== 'link' && val !== name) line += `: ${clip(String(val), 120)}`
    // 原生下拉框：选项压成一行（用 bx select 选）
    if (role === 'combobox') {
      const popup = kids().find(c => c?.role?.value === 'MenuListPopup')
      if (popup) {
        const opts: string[] = []
        const collect = (x: AXNode | undefined, d = 0) => {
          if (!x || d > 4) return
          if (x.role?.value === 'option') opts.push((x.name?.value || '').trim())
          else for (const id of x.childIds || []) collect(byId.get(id), d + 1)
        }
        collect(popup)
        lines.push(line + ` {options: ${clip(opts.join(' | '), 300)}}`)
        return
      }
    }
    lines.push(line)
    // 日期、时间这类输入框内部的小部件不展开
    if (LEAF.has(role)) return
    // 按钮、链接这类元素的子节点通常只是它的文字，不再展开
    if (['button', 'link', 'option', 'menuitem', 'tab', 'heading'].includes(role) && name) {
      for (const c of kids()) if (c && hasInteractive(c, byId)) visit(c, depth + 1, name)
      return
    }
    for (const c of kids()) visit(c, depth + 1, name || parentName)
  }

  visit(root, 0, '')

  // 去掉和下一个输入框名字重复的 label 文字
  for (let i = lines.length - 2; i >= 0; i--) {
    const m = lines[i].match(/^\s*- text: (.*)$/)
    if (!m) continue
    const next = lines[i + 1].match(/^\s*- \w+ "(.*?)" \[ref=/)
    if (next && next[1].trim() === m[1].trim()) lines.splice(i, 1)
  }

  const url = await s.evaluate('location.href').catch(() => '')
  const header = [`# ${title || '(无标题)'}`, `url: ${url}`]
  if (truncated) header.push(`(已截断到 ${maxLines} 行；用 --max 调大，或用 -i 只看可操作元素，或用 bx read 读内容)`)
  if (skippedFrames.length) header.push(`(跨域 iframe 未展开：${skippedFrames.slice(0, 3).join(', ')})`)
  return { text: header.join('\n') + '\n' + lines.join('\n'), refs: s.refs.size, truncated }
}

function hasInteractive(n: AXNode, byId: Map<string, AXNode>, depth = 0): boolean {
  if (depth > 6) return false
  if (INTERACTIVE.has(n.role?.value || '') && !n.ignored) return true
  return (n.childIds || []).some(id => {
    const c = byId.get(id)
    return c ? hasInteractive(c, byId, depth + 1) : false
  })
}

export const axKey = (role: string, name: string) => role + '\u0000' + name.trim()

/** 角色 + 名字 → 按文档顺序排列的 backendNodeId（用来算“第几个同名元素”） */
export function axIndex(nodes: AXNode[]) {
  const m = new Map<string, number[]>()
  for (const n of nodes) {
    if (n.ignored || !n.backendDOMNodeId) continue
    const k = axKey(n.role?.value || '', n.name?.value || '')
    const list = m.get(k) || m.set(k, []).get(k)!
    if (!list.includes(n.backendDOMNodeId)) list.push(n.backendDOMNodeId)
  }
  return m
}

export type { AXNode }
export { INTERACTIVE }

/**：鼠标是手型、自己和祖先 / 子孙都不是标准交互元素。
 * 返回 backendNodeId -> 文字
 */
async function findClickables(s: TabSession): Promise<Map<number, string>> {
  const r = await s.send('Runtime.evaluate', {
    expression: `(() => {
      const INTER = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[contenteditable=""],[contenteditable=true]';
      const out = [], texts = [];
      const all = document.body ? document.body.querySelectorAll('div,li,span,p,img,svg,i,em,section,dd,dt,td,h1,h2,h3,h4,h5,h6') : [];
      for (const el of all) {
        if (out.length >= 150) break;
        if (getComputedStyle(el).cursor !== 'pointer') continue;
        const p = el.parentElement;
        if (p && getComputedStyle(p).cursor === 'pointer' && !p.matches(INTER)) continue; // 只要最外层
        if (el.closest(INTER) || el.querySelector(INTER)) continue;
        if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) continue;
        const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ');
        if (!t || t.length > 60) continue;
        out.push(el); texts.push(t);
      }
      return { els: out, texts };
    })()`,
    returnByValue: false,
  })
  const map = new Map<number, string>()
  const objId = r.result?.objectId
  if (!objId) return map
  const props = await s.send('Runtime.getProperties', { objectId: objId, ownProperties: true })
  const get = (name: string) => props.result.find((p: any) => p.name === name)?.value?.objectId
  const elsId = get('els')
  const textsId = get('texts')
  if (!elsId || !textsId) return map
  const [els, texts] = await Promise.all([
    s.send('Runtime.getProperties', { objectId: elsId, ownProperties: true }),
    s.send('Runtime.callFunctionOn', { objectId: textsId, functionDeclaration: 'function(){ return this }', returnByValue: true }),
  ])
  const list = els.result.filter((p: any) => /^\d+$/.test(p.name) && p.value?.objectId)
  await Promise.all(
    list.map(async (p: any) => {
      try {
        const d = await s.send('DOM.describeNode', { objectId: p.value.objectId })
        map.set(d.node.backendNodeId, texts.result.value[Number(p.name)])
      } catch {}
    }),
  )
  s.send('Runtime.releaseObject', { objectId: objId }).catch(() => {})
  return map
}
