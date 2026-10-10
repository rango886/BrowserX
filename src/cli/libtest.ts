import fs from 'node:fs'
import path from 'node:path'
import { BX_HOME, ensureDir } from '../common/paths.ts'
import { BxError, sleep } from '../common/util.ts'
import { createBx } from '../sdk/index.ts'
import { findLib, fnLogin, importLib, libInfo, listLibs, type LibEntry, type LibFn, type LibInfo } from '../sdk/lib.ts'

/**
 * bx lib test [域名] [函数...]：把函数库里的 @example 当测试跑。
 * - 每个域名在 ~/.bx/test/<时间>/<域名>/ 这个临时目录里跑（当前目录切过去），@test file 声明的文件先写进去，下载的东西也落在这里
 * - 同一个域名里按顺序跑，每条之间停一下（--delay），免得触发风控
 * - 按错误码分类：只有“真坏了”才算失败；要登录、被拦、例子过期单独列出来
 */

export type Status = 'ok' | 'fail' | 'login' | 'blocked' | 'stale' | 'skip'

export interface ExampleResult {
  domain: string
  fn: string
  example: string
  status: Status
  ms?: number
  /** 结果摘要，或者错误说明 */
  note: string
  code?: string
}

const MARK: Record<Status, string> = { ok: '✓', fail: '✗', login: '要登录', blocked: '被拦', stale: '例子过期', skip: '跳过' }

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (...a: any[]) => Promise<any>
const IDENT = /^[A-Za-z_$][\w$]*$/

/** 结果是不是空的 */
function isEmpty(v: any) {
  if (v === undefined || v === null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v).length === 0
  return false
}

/** 一句话的结果摘要：条数 + 第一条的字段 */
function brief(v: any): string {
  if (Array.isArray(v)) {
    const first = v[0]
    const keys = first && typeof first === 'object' && !Array.isArray(first) ? `，字段：${Object.keys(first).slice(0, 8).join(' ')}` : ''
    return `${v.length} 项${keys}`
  }
  if (typeof v === 'string') return `字符串 ${v.length} 字`
  if (v && typeof v === 'object') return `对象，字段：${Object.keys(v).slice(0, 8).join(' ')}`
  return String(v)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms) return p
  let timer: NodeJS.Timeout
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new BxError('TIMEOUT', `超过 ${ms / 1000} 秒还没跑完`, '用 --timeout 调大，或者给这个函数加 @test skip')), ms)
    }),
  ])
}

/** 错误 → 分类 */
function classify(e: any, info: LibInfo, f: LibFn): Pick<ExampleResult, 'status' | 'note' | 'code'> {
  const code = e?.code && e.code !== 'ERROR' ? String(e.code) : undefined
  const msg = `${code ? `[${code}] ` : ''}${e?.message || e}${e?.hint ? ' → ' + e.hint : ''}`
  if (code === 'NEED_LOGIN') {
    const marked = fnLogin(info, f).level !== 'none'
    return { status: 'login', code, note: marked ? msg : `${msg}（这个函数没标 @login，要补上）` }
  }
  if (code === 'BLOCKED') return { status: 'blocked', code, note: msg }
  if (code === 'NOT_FOUND') return { status: 'stale', code, note: `${msg}（参数里的内容可能被删了，换一个例子）` }
  return { status: 'fail', code, note: msg }
}

/** 执行一条例子：把模块导出的函数当成变量，例子当表达式求值 */
async function runExample(mod: Record<string, any>, example: string) {
  const names = Object.keys(mod).filter(k => IDENT.test(k) && typeof mod[k] === 'function')
  let fn: (...a: any[]) => Promise<any>
  try {
    fn = new AsyncFunction(...names, `return (${example}\n)`)
  } catch (e: any) {
    throw new BxError('BAD_EXAMPLE', `例子写得不对，解析不了：${e.message}`, '@example 要写成一个函数调用表达式，比如 search(\'x\', { limit: 5 })')
  }
  const r = await fn(...names.map(n => mod[n]))
  // 生成器：最多取 50 条
  if (r && typeof r[Symbol.asyncIterator] === 'function') {
    const out: any[] = []
    for await (const x of r) if (out.push(x) >= 50) break
    return out
  }
  return r
}

export interface TestOptions {
  all?: boolean
  dry?: boolean
  clean?: boolean
  /** 每条例子的超时，秒 */
  timeout?: number
  /** 同一个域名里两条例子之间停多久，毫秒 */
  delay?: number
  tab?: string
  browser?: string
}

function pickDomains(domain: string | undefined, o: TestOptions): LibEntry[] {
  if (o.all) return listLibs()
  if (!domain) throw new BxError('BAD_ARGS', '要测哪个网站的函数库？', '例：bx lib test bilibili.com；全部都测用 --all（很慢，而且容易触发风控）')
  const e = findLib(domain)
  if (!e) throw new BxError('NO_LIB', `没有 ${domain} 的函数库`, `已有：${listLibs().map(l => l.domain).join(', ') || '(无)'}`)
  return [e]
}

const progress = (s: string) => process.stderr.write(s + '\n')

export async function libTest(domain: string | undefined, fnNames: string[], o: TestOptions) {
  const entries = pickDomains(domain, o)
  const home = process.cwd()
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const root = path.join(BX_HOME, 'test', stamp)
  const results: ExampleResult[] = []
  const noExample: string[] = []

  // 函数库里的 bx.lib('别的域名') 还要按原来的目录找（项目级函数库）
  const bx = createBx({ tab: o.tab || process.env.BX_TAB, browser: o.browser, cwd: home })
  ;(globalThis as any).bx = bx
  ;(globalThis as any).BxError = BxError

  try {
    for (const entry of entries) {
      const info = libInfo(entry)
      let fns = info.functions
      if (fnNames.length) {
        const miss = fnNames.filter(n => !fns.some(f => f.name === n))
        if (miss.length) throw new BxError('NO_FUNCTION', `${info.domain} 的函数库里没有 ${miss.join(', ')}`, `有：${fns.map(f => f.name).join(', ')}`)
        fns = fns.filter(f => fnNames.includes(f.name))
      }
      for (const f of fns) if (!f.examples.length && f.name !== 'read') noExample.push(`${info.domain} ${f.name}`)
      const todo = fns.filter(f => f.examples.length)
      if (!todo.length) continue

      progress(`${info.domain}`)
      const dir = path.join(root, info.domain)
      let mod: Record<string, any> | null = null
      let loadErr: any = null
      if (!o.dry) {
        ensureDir(dir)
        mod = await importLib(entry).catch(e => ((loadErr = e), null))
      }
      let first = true
      for (const f of todo) {
        for (const ex of f.examples) {
          const base = { domain: info.domain, fn: f.name, example: ex }
          let r: ExampleResult
          if (f.test?.skip) r = { ...base, status: 'skip', note: f.test.skip }
          else if (o.dry) r = { ...base, status: 'ok', note: f.test?.files.length ? `会先写文件：${f.test.files.map(x => x.name).join(' ')}` : '会跑' }
          else if (loadErr) r = { ...base, ...classify(loadErr, info, f) }
          else {
            if (!first && o.delay) await sleep(o.delay)
            first = false
            for (const file of f.test?.files || []) {
              const p = path.resolve(dir, file.name)
              ensureDir(path.dirname(p))
              fs.writeFileSync(p, file.content)
            }
            const t0 = Date.now()
            process.chdir(dir)
            try {
              const v = await withTimeout(runExample(mod!, ex), (o.timeout ?? 300) * 1000)
              r = isEmpty(v) ? { ...base, status: 'fail', code: 'EMPTY', note: `结果是空的：${JSON.stringify(v)}` } : { ...base, status: 'ok', note: brief(v) }
            } catch (e: any) {
              r = { ...base, ...classify(e, info, f) }
            } finally {
              process.chdir(home)
              await bx.cleanup().catch(() => {})
            }
            r.ms = Date.now() - t0
          }
          results.push(r)
          const mark = o.dry && r.status === 'ok' ? '·' : MARK[r.status]
          progress(`  ${mark} ${ex}${r.ms !== undefined ? `  ${(r.ms / 1000).toFixed(1)}s` : ''}  ${r.note.split('\n')[0].slice(0, 200)}`)
        }
      }
    }
  } finally {
    bx.close()
  }

  if (!o.dry && o.clean) fs.rmSync(root, { recursive: true, force: true })
  const failed = results.filter(r => r.status === 'fail').length
  if (failed && !o.dry) process.exitCode = 1
  return { results, noExample, dir: !o.dry && !o.clean && fs.existsSync(root) ? root : undefined }
}

/** 最后的汇总（逐条结果在跑的时候已经打到 stderr 了） */
export function testSummary(r: Awaited<ReturnType<typeof libTest>>, dry = false) {
  const count = (s: Status) => r.results.filter(x => x.status === s).length
  const L: string[] = []
  if (dry) {
    L.push(`会跑 ${count('ok')} 条，跳过 ${count('skip')} 条`)
  } else {
    const parts = (['ok', 'fail', 'login', 'blocked', 'stale', 'skip'] as Status[]).filter(s => count(s)).map(s => `${MARK[s]} ${count(s)}`)
    L.push(`共 ${r.results.length} 条：${parts.join('  ') || '（没有例子）'}`)
    const bad = r.results.filter(x => x.status === 'fail')
    if (bad.length) L.push('', '真坏了，要修：', ...bad.map(x => `  ${x.domain} ${x.example}\n      ${x.note.split('\n')[0].slice(0, 300)}`))
    const other = r.results.filter(x => x.status === 'login' || x.status === 'blocked' || x.status === 'stale')
    if (other.length) L.push('', '没跑通但不是代码的问题：', ...other.map(x => `  [${MARK[x.status]}] ${x.domain} ${x.example}`))
    if (r.dir) L.push('', `临时目录（下载的文件在这里）：${r.dir}`)
  }
  if (r.noExample.length) L.push('', `没有 @example 的函数（测不到）：${r.noExample.join('、')}`)
  return L.join('\n')
}
