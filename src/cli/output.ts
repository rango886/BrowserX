import YAML from 'yaml'

export type Format = 'text' | 'json' | 'jsonl' | 'yaml' | 'csv' | 'table'

/** 终端显示宽度（中文算 2） */
function width(s: string) {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    w += c > 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)) ? 2 : 1
  }
  return w
}

function clipW(s: string, max: number) {
  if (width(s) <= max) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = width(ch)
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))

function cell(v: any): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v).replace(/\s+/g, ' ')
}

export function table(rows: any[]): string {
  if (!rows.length) return '(空)'
  const cols: string[] = []
  for (const r of rows.slice(0, 100)) for (const k of Object.keys(r)) if (!cols.includes(k) && r[k] !== undefined) cols.push(k)
  const termW = process.stdout.columns || 160
  const maxW: Record<string, number> = {}
  for (const c of cols) maxW[c] = Math.max(width(c), ...rows.map(r => width(cell(r[c]))))
  // 宽列（title / url / text 这类）按终端宽度压缩
  const fixed = cols.reduce((a, c) => a + Math.min(maxW[c], 24) + 2, 0)
  const budget = Math.max(termW - fixed, 40)
  for (const c of cols) if (maxW[c] > 24) maxW[c] = Math.min(maxW[c], Math.max(24, Math.floor(budget / Math.max(1, cols.filter(x => maxW[x] > 24).length)) + 24))
  const line = (vals: string[]) => vals.map((v, i) => pad(clipW(v, maxW[cols[i]]), maxW[cols[i]])).join('  ').trimEnd()
  return [line(cols), ...rows.map(r => line(cols.map(c => cell(r[c]))))].join('\n')
}

function csvCell(v: any) {
  const s = cell(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function csv(rows: any[]): string {
  const cols: string[] = []
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k)
  return [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n')
}

export function yaml(v: any) {
  return YAML.stringify(v, { lineWidth: 0 }).trimEnd()
}

/** read 结果的文本渲染：给人和 AI 看都顺眼 */
export function renderRead(r: any): string {
  const out: string[] = []
  if (r.section) {
    out.push(`# ${r.title || ''} › ${r.section}`)
    out.push(`${r.url}`)
    out.push('')
    out.push(r.content || '(空)')
    if (r.more !== undefined) out.push('', `…(第 ${r.range[0]}-${r.range[1]} 字，共 ${r.total}；继续：bx read --section ${r.section} --offset ${r.more})`)
    return out.join('\n')
  }
  out.push(`# ${r.title || '(无标题)'}`)
  out.push(`${r.url}`)
  const info = [`type: ${r.type || '?'}`, `via: ${r.via || '?'}`]
  const meta = r.meta || {}
  for (const k of ['author', 'published', 'site']) if (meta[k]) info.push(`${k}: ${meta[k]}`)
  out.push(info.join(' · '))
  if (meta.description && r.type !== 'article') out.push(`> ${meta.description}`)
  for (const w of r.warnings || []) out.push(`⚠ ${w}`)
  for (const h of r.hints || []) out.push(`💡 ${h}`)
  if (r.summary) out.push('', r.summary)
  // reader 自定义字段（除了约定字段之外的）用 yaml 展示
  const known = new Set(['url', 'title', 'type', 'via', 'meta', 'warnings', 'hints', 'summary', 'content', 'items', 'more', 'sections', 'structured', 'size'])
  const extra = Object.fromEntries(Object.entries(r).filter(([k]) => !known.has(k)))
  if (Object.keys(extra).length) out.push('', yaml(extra))
  if (r.content) out.push('', r.content)
  if (r.items) {
    out.push('')
    const base = r.more?.next !== undefined ? r.more.next - r.items.length : 0
    r.items.forEach((it: any, i: number) => {
      if (typeof it !== 'object') return out.push(`${base + i + 1}. ${it}`)
      const { title, url, text, ...rest } = it
      out.push(`${base + i + 1}. ${title ?? ''}`)
      if (text) out.push(`   ${text}`)
      const restStr = Object.entries(rest).map(([k, v]) => `${k}: ${cell(v)}`).join(' · ')
      if (restStr) out.push(`   ${restStr}`)
      if (url) out.push(`   ${url}`)
    })
  }
  if (r.more) out.push('', `…(还有更多，共 ${r.more.total}；继续：bx read --offset ${r.more.next})`)
  if (r.sections?.length) {
    out.push('', '分段（bx read --section <id>）：')
    for (const s of r.sections) out.push(`  - ${s.id}: ${s.title}${s.chars !== undefined ? `（${s.chars}${typeof s.chars === 'number' ? ' 字' : ''}）` : ''}`)
  }
  return out.join('\n')
}

export function render(v: any, fmt: Format, kind?: string): string {
  if (fmt === 'json') return JSON.stringify(v, null, 2)
  if (fmt === 'jsonl') return (Array.isArray(v) ? v : [v]).map(x => JSON.stringify(x)).join('\n')
  if (fmt === 'yaml') return yaml(v)
  if (fmt === 'csv') return csv(Array.isArray(v) ? v : [v])
  if (fmt === 'table') return table(Array.isArray(v) ? v : [v])
  // text
  if (v === null || v === undefined) return ''
  if (typeof v !== 'object') return String(v)
  if (kind === 'read') return renderRead(v)
  if (typeof v.text === 'string' && Object.keys(v).every(k => ['text', 'refs', 'truncated'].includes(k))) return v.text
  if (Array.isArray(v)) {
    if (v.length && v.every(x => x && typeof x === 'object' && !Array.isArray(x))) return table(v)
    return v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n')
  }
  return yaml(v)
}
