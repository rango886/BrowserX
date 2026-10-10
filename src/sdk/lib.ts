import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { searchDirs } from '../common/paths.ts'
import { BxError } from '../common/util.ts'

/**
 * 函数库：按域名存放的普通 JS 模块 lib/<域名>.js，导出几个 async 函数。
 * 查找顺序：<项目>/.bx/lib → ~/.bx/lib → 仓库 lib/；先找完整域名，找不到再找上一级（www.bilibili.com → bilibili.com）。
 * 文件名以 _ 开头的只放共享代码，不算函数库。
 */

export interface LibEntry {
  domain: string
  file: string
  scope: string
}

const LIB_FILE = /^[^_.][^\\/]*\.m?js$/

export function listLibs(cwd = process.cwd()): LibEntry[] {
  const out = new Map<string, LibEntry>()
  for (const { scope, dir } of searchDirs('lib', cwd)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!LIB_FILE.test(name)) continue
      const domain = name.replace(/\.m?js$/, '').toLowerCase()
      if (!out.has(domain)) out.set(domain, { domain, file: path.join(dir, name), scope })
    }
  }
  return [...out.values()]
}

/** 网址 / 域名 → 规范的主机名 */
export function hostOf(x: string) {
  let s = String(x || '').trim().toLowerCase()
  if (s.includes('://')) {
    try {
      s = new URL(s).hostname
    } catch {}
  }
  return s.replace(/^\*\./, '').replace(/[/:].*$/, '')
}

export function findLib(domainOrUrl: string, cwd = process.cwd()): LibEntry | null {
  const libs = new Map(listLibs(cwd).map(l => [l.domain, l]))
  const parts = hostOf(domainOrUrl).split('.').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const cand = parts.slice(i).join('.')
    if (libs.has(cand)) return libs.get(cand)!
    if (parts.length - i <= 2) break
  }
  return null
}

export async function importLib(e: LibEntry): Promise<Record<string, any>> {
  try {
    return await import(pathToFileURL(e.file).href + '?v=' + fs.statSync(e.file).mtimeMs)
  } catch (err: any) {
    throw new BxError('LIB_ERROR', `加载 ${e.file} 出错：${err.message}`, '修好这个文件里的语法 / import 错误')
  }
}

// =====================================================================
// 解析源码：站点笔记、导出的函数、参数（类型看默认值）、说明和 @example
// =====================================================================

export interface LibParam {
  name: string
  raw: string
  default?: string
  type: 'string' | 'number' | 'boolean' | 'any'
  rest?: boolean
  /** 解构的选项对象 { limit = 20, full = false } = {} */
  options?: LibParam[]
}

export interface LibFn {
  name: string
  params: LibParam[]
  signature: string
  desc: string
  summary: string
  examples: string[]
  generator?: boolean
}

export interface LibInfo extends LibEntry {
  notes: string
  functions: LibFn[]
}

/** 跳过字符串 / 模板 / 注释，找和 open 配对的括号位置 */
function matchClose(src: string, start: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const stack: string[] = []
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i)
      if (i < 0) return -1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1
      if (i <= 0) return -1
      continue
    }
    if (pairs[c]) stack.push(pairs[c])
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1
      if (!stack.length) return i
    }
  }
  return -1
}

/** 按顶层逗号切开 */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      for (; j < s.length && s[j] !== c; j++) if (s[j] === '\\') j++
      cur += s.slice(i, j + 1)
      i = j
      continue
    }
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur.trim()) out.push(cur)
  return out.map(x => x.trim()).filter(Boolean)
}

/** 第一个顶层的赋值 =（不是 == / => / <= / >= / !=） */
function topAssign(s: string): number {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++
      continue
    }
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === '=' && depth === 0 && s[i + 1] !== '=' && s[i + 1] !== '>' && !'=!<>'.includes(s[i - 1] || '')) return i
  }
  return -1
}

function typeOf(def?: string): LibParam['type'] {
  if (def === undefined) return 'string'
  const d = def.trim()
  if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(d)) return 'number'
  if (d === 'true' || d === 'false') return 'boolean'
  if (/^(['"`]).*\1$/s.test(d)) return 'string'
  return 'any'
}

function parseParam(raw: string): LibParam {
  const t = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim()
  if (t.startsWith('...')) return { name: t.slice(3).trim(), raw: t, type: 'string', rest: true }
  const eq = topAssign(t)
  const left = (eq >= 0 ? t.slice(0, eq) : t).trim()
  const def = eq >= 0 ? t.slice(eq + 1).trim() : undefined
  if (left.startsWith('{')) {
    const inner = left.slice(1, left.lastIndexOf('}'))
    const options = splitTop(inner)
      .filter(x => !x.startsWith('...'))
      .map(x => {
        const e = topAssign(x)
        const key = (e >= 0 ? x.slice(0, e) : x).split(':')[0].trim()
        const d = e >= 0 ? x.slice(e + 1).trim() : undefined
        return { name: key, raw: x, default: d, type: d === undefined ? ('any' as const) : typeOf(d) }
      })
    return { name: 'options', raw: t, default: def, type: 'any', options }
  }
  if (left.startsWith('[')) return { name: 'list', raw: t, default: def, type: 'any' }
  return { name: left, raw: t, default: def, type: typeOf(def) }
}

/** 去掉注释符号，得到注释正文 */
function commentText(c: string) {
  if (c.startsWith('//')) return c.replace(/^\s*\/\/ ?/gm, '')
  return c
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map(l => l.replace(/^\s*\* ?/, ''))
    .join('\n')
    .trim()
}

/** 文件顶部的注释（import 之间的也算），不包括紧贴第一个 export 的函数说明 */
function headNotes(src: string): string {
  const blocks: { text: string; end: number }[] = []
  let i = 0
  const re = /\s*(\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n?)+|import\b[^;\n]*(?:\n[^;\n]*)*?\bfrom\s*['"][^'"]+['"];?|import\s*['"][^'"]+['"];?|#![^\n]*\n)/y
  while (true) {
    re.lastIndex = i
    const m = re.exec(src)
    if (!m) break
    const tok = m[1]
    if (tok.startsWith('/*') || tok.startsWith('//')) blocks.push({ text: tok, end: re.lastIndex })
    i = re.lastIndex
  }
  // 紧贴在后面代码上的 /** */ 是函数说明，不算笔记
  const last = blocks[blocks.length - 1]
  if (last && last.text.startsWith('/**') && /^[ \t]*\r?\n?[ \t]*export\b/.test(src.slice(last.end))) blocks.pop()
  return blocks.map(b => commentText(b.text)).join('\n').trim()
}

function parseDoc(doc: string) {
  const lines = commentText(doc).split('\n')
  const desc: string[] = []
  const examples: string[] = []
  let inEx = false
  for (const l of lines) {
    const m = l.match(/^\s*@(\w+)\s*(.*)$/)
    if (m) {
      inEx = m[1] === 'example'
      if (inEx && m[2].trim()) examples.push(m[2].trim())
      continue
    }
    if (inEx) {
      if (l.trim()) examples.push(l.trim())
    } else desc.push(l)
  }
  const d = desc.join('\n').trim()
  return { desc: d, summary: d.split('\n')[0] || '', examples }
}

export function parseLibSource(src: string): { notes: string; functions: LibFn[] } {
  const functions: LibFn[] = []
  const re = /export\s+(?:async\s+)?function\s*(\*)?\s*([\w$]+)\s*\(|export\s+const\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\s*(\*)?\s*[\w$]*\s*\(|\(|([\w$]+)\s*=>)/g
  for (const m of src.matchAll(re)) {
    const name = m[2] || m[3]
    let params: LibParam[] = []
    let paramsRaw = ''
    if (m[5]) {
      paramsRaw = m[5]
      params = [parseParam(m[5])]
    } else {
      const open = m.index! + m[0].length - 1
      const close = matchClose(src, open)
      if (close < 0) continue
      paramsRaw = src.slice(open + 1, close)
      params = splitTop(paramsRaw).map(parseParam)
    }
    // 紧贴在 export 前面的 /** */
    let doc = ''
    const before = src.slice(0, m.index)
    const end = before.lastIndexOf('*/')
    if (end >= 0 && /^\s*$/.test(before.slice(end + 2))) {
      const start = before.lastIndexOf('/*', end)
      if (start >= 0) doc = before.slice(start, end + 2)
    }
    const d = doc ? parseDoc(doc) : { desc: '', summary: '', examples: [] }
    const signature = `${name}(${paramsRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim()})`
    functions.push({ name, params, signature, ...d, generator: !!(m[1] || m[4]) })
  }
  return { notes: headNotes(src), functions }
}

export function libInfo(e: LibEntry): LibInfo {
  return { ...e, ...parseLibSource(fs.readFileSync(e.file, 'utf8')) }
}

/** 命令行写法：bx call <域名> <函数> <参数> [--选项 值] */
export function cliUsage(domain: string, f: LibFn) {
  const parts = [`bx call ${domain} ${f.name}`]
  for (const p of f.params) {
    if (p.options) {
      for (const o of p.options) parts.push(o.type === 'boolean' ? `[--${o.name}]` : `[--${o.name} ${o.default !== undefined ? o.default.replace(/^['"`]|['"`]$/g, '') : '<值>'}]`)
    } else if (p.rest) parts.push(`[${p.name}...]`)
    else parts.push(p.default === undefined ? `<${p.name}>` : `[${p.name}=${p.default.replace(/^['"`]|['"`]$/g, '')}]`)
  }
  return parts.join(' ')
}

/** bx lib list <域名> 的文本 */
export function describeLib(info: LibInfo, opts: { notes?: boolean } = {}) {
  const L: string[] = [`${info.domain}  （${info.scope}：${info.file}）`]
  if (opts.notes !== false && info.notes) L.push('', ...(/^站点笔记/.test(info.notes) ? [] : ['站点笔记：']), ...info.notes.split('\n').map(l => '  ' + l))
  L.push('', `函数（bx call ${info.domain} <函数> …，或在 bx run 里 bx.lib('${info.domain}').<函数>(…)）：`)
  for (const f of info.functions) {
    L.push('', `  ${f.signature}`)
    if (f.desc) L.push(...f.desc.split('\n').map(l => '      ' + l))
    for (const e of f.examples) L.push(`      例：${e}`)
    if (f.name !== 'read') L.push(`      命令行：${cliUsage(info.domain, f)}`)
    else L.push('      （bx read 打开这个域名的网址时会先用它）')
  }
  if (!info.functions.length) L.push('  （没有导出函数）')
  return L.join('\n')
}
