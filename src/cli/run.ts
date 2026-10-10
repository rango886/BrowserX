import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { BX_HOME, REPO_ROOT, ensureDir } from '../common/paths.ts'
import { BxError } from '../common/util.ts'
import { createBx } from '../sdk/index.ts'
import { render, type Format } from './output.ts'

/**
 * bx run '<代码>' | -f 文件.js
 * 代码按 ES 模块执行：支持顶层 await、import node:fs 等；return 的值打印出来。
 * 全局有 bx 和 BxError。只有一个表达式时可以不写 return。
 */

const IMPORT_RE = /^[ \t]*import(?!\s*[(.])\s*(?:[\w$*{}\s,]+?\s*from\s*)?(['"])([^'"\n]+)\1[ \t]*;?/gm

/** 把 import 的地址换成绝对地址：相对路径按脚本所在目录，包名按脚本目录 → bx 自己的依赖去找 */
function resolveSpec(spec: string, baseDir: string) {
  if (/^(node:|data:|file:|https?:)/.test(spec)) return spec
  if (spec.startsWith('.') || spec.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(spec)) return pathToFileURL(path.resolve(baseDir, spec)).href
  if (!spec.includes('/') && !spec.startsWith('@')) {
    // 内置模块不带 node: 前缀也能用
    try {
      if (createRequire(import.meta.url).resolve.paths(spec) === null) return spec
    } catch {}
  }
  for (const from of [path.join(baseDir, '_.js'), path.join(REPO_ROOT, 'package.json')]) {
    try {
      return pathToFileURL(createRequire(from).resolve(spec)).href
    } catch {}
  }
  return spec
}

/** 把代码包成模块：import 提到第一行（保持行号不变），其余放进 export default async function */
export function buildModule(code: string, baseDir: string) {
  const imports: string[] = []
  const body = code.replace(/^#!.*/, '').replace(IMPORT_RE, (m, q, spec) => {
    imports.push(m.trim().replace(/;?$/, ';').replace(`${q}${spec}${q}`, JSON.stringify(resolveSpec(spec, baseDir))))
    return m.replace(/[^\n]/g, '')
  })
  // 只有一个表达式（比如 `await bx.tabs()`）时自动 return 它
  let expr = false
  if (!/\breturn\b/.test(body) && body.trim()) {
    try {
      new vm.Script(`(async () => { return (${body}\n) })`)
      expr = true
    } catch {}
  }
  const head = imports.join(' ') + ' export default async function __bx_run() {'
  return expr ? `${head} return (${body}\n) }\n` : `${head}${body}\n}\n`
}

/** 结果太大时的摘要 */
function summarize(v: any): string {
  const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s)
  const one = (x: any) => clip(typeof x === 'string' ? x : JSON.stringify(x))
  if (typeof v === 'string') return `字符串，${v.length} 字。开头：\n${clip(v, 800)}`
  if (Array.isArray(v)) {
    const keys = v.length && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0]) ? `，每项的字段：${Object.keys(v[0]).join(', ')}` : ''
    return [`数组，共 ${v.length} 项${keys}。前 3 项：`, ...v.slice(0, 3).map((x, i) => `  [${i}] ${one(x)}`)].join('\n')
  }
  if (v && typeof v === 'object')
    return [
      `对象，字段：`,
      ...Object.entries(v)
        .slice(0, 30)
        .map(([k, x]) => `  ${k}: ${Array.isArray(x) ? `数组 ${x.length} 项` : typeof x === 'string' ? (x.length > 80 ? `字符串 ${x.length} 字` : JSON.stringify(x)) : x && typeof x === 'object' ? `对象（${Object.keys(x).length} 个字段）` : String(x)}`),
    ].join('\n')
  return String(v)
}

interface RunArgs {
  code?: string
  file?: string
  output?: Format
  tab?: string
  browser?: string
  max: number
  args: string[]
}

function parseRunArgs(argv: string[]): RunArgs {
  const r: RunArgs = { max: 20000, args: [] }
  const pos: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (argv[i + 1] === undefined) throw new BxError('BAD_ARGS', `${a} 后面要跟一个值`)
      return argv[++i]
    }
    if (a === '-f' || a === '--file') r.file = next()
    else if (a === '-o' || a === '--output') r.output = next() as Format
    else if (a === '-t' || a === '--tab') r.tab = next()
    else if (a === '--browser') r.browser = next()
    else if (a === '--max') r.max = Number(next())
    else if (a === '--') pos.push(...argv.slice(i + 1)), (i = argv.length)
    else pos.push(a)
  }
  if (r.file) r.args = pos
  else {
    r.code = pos[0]
    r.args = pos.slice(1)
  }
  return r
}

export const RUN_HELP = `bx run '<代码>' [参数...]      bx run -f 文件.js [参数...]      echo '代码' | bx run -

在 Node 里执行 JS（ES 模块）：支持顶层 await，可以 import node:fs 等；return 的值打印出来。
全局有 bx 对象（bx.tab / bx.open / bx.tabs / bx.read / bx.lib / bx.log / bx.sleep）和 BxError。
只有一个表达式时可以不写 return，比如：bx run 'await bx.tabs()'
每次跑完进程就退出；标签、登录状态、网络记录都在 daemon 里，下次 bx.tab('t5') 就能拿回来。

选项：
  -f, --file <文件>     从文件读代码（相对 import 按文件所在目录解析）
  -t, --tab <标签>      bx.tab() 默认用这个标签
  --browser <名字>      bx.open / bx.tab 用哪个浏览器
  -o <格式>             text|json|yaml|jsonl|csv|table
  --max <字数>          结果超过这么多字（默认 20000）就写到 ~/.bx/out/ 下，只打印摘要和路径；0 表示不限
  其余参数放在 bx.args 里

例：
  bx run 'const t = await bx.open("https://example.com"); const r = await t.eval(() => document.title); await t.close(); return r'
  bx run 'return bx.lib("bilibili.com").search("纪录片", { limit: 5 })'
  bx run -f research/step1.js`

export async function runCode(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h') || !argv.length) {
    if (!argv.length && process.stdin.isTTY) throw new BxError('BAD_ARGS', '缺少要执行的代码', "例：bx run 'return await bx.tabs()'，或 bx run -f x.js")
    if (argv.length) return console.log(RUN_HELP)
  }
  const a = parseRunArgs(argv)
  let code: string
  let label: string
  let baseDir = process.cwd()
  if (a.file) {
    code = fs.readFileSync(a.file, 'utf8')
    label = path.resolve(a.file)
    baseDir = path.dirname(label)
  } else if (a.code === undefined || a.code === '-') {
    code = fs.readFileSync(0, 'utf8')
    label = '<stdin>'
  } else {
    code = a.code
    label = '<run>'
  }

  const bx = createBx({ tab: a.tab || process.env.BX_TAB, browser: a.browser })
  bx.args = a.args
  ;(globalThis as any).bx = bx
  ;(globalThis as any).BxError = BxError

  const tmp = path.join(ensureDir(path.join(BX_HOME, 'run')), `run-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(tmp, buildModule(code, baseDir))
  let result: any
  try {
    const mod = await import(pathToFileURL(tmp).href)
    fs.rmSync(tmp, { force: true })
    result = await mod.default()
  } catch (e: any) {
    fs.rmSync(tmp, { force: true })
    // 报错位置换回用户的代码
    const tmpUrl = pathToFileURL(tmp).href
    const m = String(e?.stack || '').match(new RegExp(`(?:${tmpUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}):(\\d+):(\\d+)`))
    if (m) {
      const line = Number(m[1])
      const src = code.split('\n')[line - 1]
      e.where = `${label}:${line}${src !== undefined ? `  ${src.trim().slice(0, 120)}` : ''}`
    }
    if (e instanceof SyntaxError) (e as any).hint ??= '代码有语法错误；注意 bx run 的代码在 Node 里执行，要在页面里跑的代码用 tab.eval(() => …)'
    throw e
  } finally {
    bx.close()
  }

  if (result === undefined) return
  const fmt: Format = a.output || (process.env.BX_FORMAT as Format) || 'text'
  const s = render(result, fmt)
  if (a.max > 0 && s.length > a.max) {
    const dir = ensureDir(path.join(BX_HOME, 'out'))
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const isText = typeof result === 'string'
    const file = path.join(dir, `run-${stamp}.${isText ? 'txt' : 'json'}`)
    fs.writeFileSync(file, isText ? result : JSON.stringify(result, null, 1))
    console.log(`结果有 ${s.length} 字，太大了，完整内容写到了：${file}\n${summarize(result)}`)
    return
  }
  if (s) console.log(s)
}
