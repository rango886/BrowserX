// read --grep：在整篇内容里挑出匹配的段落（带上下文），给 AI 看不用把全文塞进上下文
//
// 切分规则：先按空行切段落；超过 LONG 字的段落（中文网页常见一整段不换行）再按句末标点切成句子。
// 每个命中单元前后各带 context 个单元，相邻窗口合并。输出总字数受 budget 限制。

export interface GrepMatch {
  /** 这一块在全文里的起始字符位置（可以拿去 bx read --offset 接着读） */
  offset: number
  text: string
  /** 这一块里命中了几处 */
  hits: number
}

export interface GrepResult {
  matches: GrepMatch[]
  /** 命中的单元总数（不是块数） */
  hits: number
  total: number
  truncated?: boolean
}

const LONG = 600

/** 字符串转正则：'/x/i' 按正则；其他按正则语法、不区分大小写（像 grep -iE）；写错了就按字面匹配 */
export function grepRegExp(p: string | RegExp): RegExp {
  if (p instanceof RegExp) return new RegExp(p.source, p.flags.replace('g', ''))
  const m = /^\/(.+)\/([a-z]*)$/s.exec(p)
  if (m) {
    try {
      return new RegExp(m[1], m[2].replace('g', ''))
    } catch {}
  }
  try {
    return new RegExp(p, 'i')
  } catch {
    return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

interface Unit {
  start: number
  text: string
}

function units(content: string): Unit[] {
  const out: Unit[] = []
  const paraRe = /\n\s*\n/g
  let pos = 0
  const push = (start: number, para: string) => {
    if (!para.trim()) return
    if (para.length <= LONG) return out.push({ start, text: para })
    // 长段落按句子切：句末标点（中英文）后面断开
    const sentRe = /[^。！？!?；;\n]*(?:[。！？!?；;]+[”"’'）)」』]*|\n|$)/g
    let m: RegExpExecArray | null
    while ((m = sentRe.exec(para)) && m[0]) {
      if (m[0].trim()) out.push({ start: start + m.index, text: m[0] })
      if (sentRe.lastIndex >= para.length) break
    }
  }
  let m: RegExpExecArray | null
  while ((m = paraRe.exec(content))) {
    push(pos, content.slice(pos, m.index))
    pos = m.index + m[0].length
  }
  push(pos, content.slice(pos))
  return out
}

export function grepText(content: string, pattern: string | RegExp, o: { context?: number; budget?: number } = {}): GrepResult {
  const re = grepRegExp(pattern)
  const ctx = Math.max(0, o.context ?? 1)
  const budget = o.budget ?? 6000
  const us = units(content)
  const hitIdx: number[] = []
  us.forEach((u, i) => re.test(u.text) && hitIdx.push(i))

  // 每个命中单元取 [i-ctx, i+ctx]，重叠或相邻的合并成一块
  const windows: { from: number; to: number; hits: number }[] = []
  for (const i of hitIdx) {
    const from = Math.max(0, i - ctx)
    const to = Math.min(us.length - 1, i + ctx)
    const last = windows[windows.length - 1]
    if (last && from <= last.to + 1) {
      last.to = Math.max(last.to, to)
      last.hits++
    } else windows.push({ from, to, hits: 1 })
  }

  const matches: GrepMatch[] = []
  let used = 0
  let truncated = false
  for (const w of windows) {
    // 直接从原文截取，保留原来的换行和标点
    const end = us[w.to].start + us[w.to].text.length
    const text = content.slice(us[w.from].start, end).trim().replace(/\n{3,}/g, '\n\n')
    if (used + text.length > budget) {
      // 预算不够：最后一块截断，后面的不要了
      const room = budget - used
      if (room > 200) matches.push({ offset: us[w.from].start, text: text.slice(0, room) + '…', hits: w.hits })
      truncated = true
      break
    }
    matches.push({ offset: us[w.from].start, text, hits: w.hits })
    used += text.length
  }
  return { matches, hits: hitIdx.length, total: content.length, ...(truncated ? { truncated } : {}) }
}

/** 列表类结果（items）：任何一个字符串字段命中就留下 */
export function grepItems<T>(items: T[], pattern: string | RegExp): T[] {
  const re = grepRegExp(pattern)
  const str = (v: any): string => (v == null ? '' : typeof v === 'object' ? Object.values(v).map(str).join(' ') : String(v))
  return items.filter(it => re.test(str(it)))
}
