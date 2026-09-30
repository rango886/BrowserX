import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import type { TabSession } from './session.ts'
import { REPO_ROOT, searchDirs } from '../common/paths.ts'
import { BxError, sleep, urlMatches } from '../common/util.ts'
import { scroll } from './actions.ts'

const require = createRequire(import.meta.url)

let LIB_SRC: string | null = null
/** Readability + Turndown + 提取器，包在一个闭包里注入，不污染页面全局 */
function libSource() {
  if (LIB_SRC) return LIB_SRC
  const readability = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8')
  const turndown = fs.readFileSync(path.join(path.dirname(require.resolve('turndown/package.json')), 'lib/turndown.browser.umd.js'), 'utf8')
  const extract = fs.readFileSync(path.join(REPO_ROOT, 'src/inject/extract.js'), 'utf8')
  LIB_SRC = `(() => {
    const Readability = (() => { const module = { exports: {} }; ${readability}\n; return module.exports })();
    const TurndownService = (() => { const module = { exports: {} }; const exports = module.exports; ${turndown}\n; return module.exports })();
    ${extract}
    return { Readability, TurndownService, bxExtract };
  })()`
  return LIB_SRC
}

// ---------------- reader 加载 ----------------

export interface ReaderMeta {
  match: string | string[]
  name?: string
  description?: string
  waitFor?: string
  scroll?: number
}
export interface Reader {
  name: string
  file: string
  scope: string
  meta: ReaderMeta
  read: Function
  section?: Function
}

const EXT = /\.(m?js|ts)$/
function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (EXT.test(e.name)) out.push(p)
  }
  return out
}

export async function loadReaders(cwd?: string): Promise<{ readers: Reader[]; errors: string[] }> {
  const readers: Reader[] = []
  const errors: string[] = []
  for (const { scope, dir } of searchDirs('readers', cwd)) {
    for (const file of walk(dir)) {
      try {
        const mtime = fs.statSync(file).mtimeMs
        const mod = await import(pathToFileURL(file).href + '?v=' + mtime)
        if (!mod.meta?.match || typeof mod.read !== 'function') {
          errors.push(`${file}: 需要导出 meta.match 和 read()`)
          continue
        }
        readers.push({
          name: mod.meta.name || path.relative(dir, file).replace(EXT, '').replace(/\\/g, '/'),
          file,
          scope,
          meta: mod.meta,
          read: mod.read,
          section: mod.section,
        })
      } catch (e: any) {
        errors.push(`${file}: ${e.message}`)
      }
    }
  }
  return { readers, errors }
}

function specificity(r: Reader, url: string) {
  const pats = ([] as string[]).concat(r.meta.match)
  return Math.max(...pats.filter(p => urlMatches(url, p)).map(p => p.replace(/\*/g, '').length))
}

export async function findReader(url: string, cwd?: string, name?: string) {
  const { readers } = await loadReaders(cwd)
  if (name) return readers.find(r => r.name === name) || null
  const scopes = ['project', 'global', 'builtin']
  for (const scope of scopes) {
    const hits = readers.filter(r => r.scope === scope && ([] as string[]).concat(r.meta.match).some(p => urlMatches(url, p)))
    if (hits.length) return hits.sort((a, b) => specificity(b, url) - specificity(a, url))[0]
  }
  return null
}

// ---------------- read ----------------

export interface ReadOpts {
  mode?: 'brief' | 'default' | 'full'
  section?: string
  offset?: number
  limit?: number
  budget?: number
  via?: string // reader 名 / readability / list / outline / generic
  links?: boolean
  scroll?: number
  cwd?: string
}

export async function read(s: TabSession, o: ReadOpts) {
  await s.ensure('Page')
  const url: string = await s.evaluate('location.href')
  const warnings: string[] = []

  const generic = ['readability', 'list', 'outline', 'generic'].includes(o.via || '')
  const reader = generic ? null : await findReader(url, o.cwd, o.via)
  if (o.via && !generic && !reader) throw new BxError('NO_READER', `没有叫 ${o.via} 的 reader`, '`bx reader list` 查看可用的 reader')

  const nScroll = o.scroll ?? reader?.meta.scroll ?? 0
  for (let i = 0; i < nScroll; i++) {
    await scroll(s, { dir: 'down' })
    await sleep(500)
  }

  if (reader) {
    try {
      if (reader.meta.waitFor) {
        const sel = JSON.stringify(reader.meta.waitFor)
        for (let i = 0; i < 50 && !(await s.evaluate(`!!document.querySelector(${sel})`)); i++) await sleep(200)
      }
      const fn = o.section ? reader.section : reader.read
      if (o.section && !fn) throw new Error(`reader ${reader.name} 没有实现 section()`)
      const args = { mode: o.mode || 'default', section: o.section, offset: o.offset || 0, limit: o.limit, budget: o.budget || 6000 }
      const res = await s.evaluate(`(async () => { const f = (${fn!.toString()}); return await f(${JSON.stringify(o.section ? o.section : args)}, ${JSON.stringify(args)}) })()`)
      if (res && typeof res === 'object' && !res.fallback) {
        return { url, via: `reader:${reader.name}`, ...res }
      }
      warnings.push(`reader ${reader.name} 没有返回内容，改用通用提取`)
    } catch (e: any) {
      warnings.push(`reader ${reader.name} 出错（${e.message.slice(0, 200)}），改用通用提取`)
    }
  }

  const res = await s.evaluate(
    `(async () => { const L = ${libSource()}; return await L.bxExtract(${JSON.stringify({
      mode: o.mode || 'default',
      section: o.section,
      offset: o.offset,
      limit: o.limit,
      budget: o.budget || 6000,
      via: generic && o.via !== 'generic' ? o.via : undefined,
      links: o.links,
    })}, L) })()`,
  )
  if (res?.error) throw new BxError('READ_FAILED', res.error, res.sections ? `可用分段：${res.sections.map((x: any) => x.id).join(', ')}` : undefined)
  if (warnings.length) res.warnings = warnings
  return res
}
