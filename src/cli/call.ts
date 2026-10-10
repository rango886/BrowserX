import readline from 'node:readline'
import { BxError } from '../common/util.ts'
import { createBx } from '../sdk/index.ts'
import { cliUsage, describeLib, findLib, fnLogin, importLib, libInfo, listLibs, type LibFn, type LibInfo, type LibParam } from '../sdk/lib.ts'
import { render, type Format } from './output.ts'

/**
 * bx call <域名> <函数> [参数...] [--选项 值]
 *   位置参数按顺序传给函数；--limit 20 这类合成最后一个对象参数。类型看函数签名里的默认值。
 *   第一个参数写 - 就从 stdin 一行一条地读，结果输出 JSONL；读进来的是 JSON 记录时，默认取它的 url 字段。
 */

const RESERVED = new Set(['output', 'tab', 'browser', 'field', 'concurrency', 'help'])

function convert(v: string, type: LibParam['type'], name: string) {
  if (type === 'number') {
    const n = Number(v)
    if (v === '' || Number.isNaN(n)) throw new BxError('BAD_ARGS', `${name} 需要数字，收到 ${JSON.stringify(v)}`)
    return n
  }
  if (type === 'boolean') {
    if (/^(true|1|yes|on)$/i.test(v)) return true
    if (/^(false|0|no|off)$/i.test(v)) return false
    throw new BxError('BAD_ARGS', `${name} 需要 true / false`)
  }
  if (type === 'any') {
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
    if (v === 'true' || v === 'false') return v === 'true'
    if (/^[[{]/.test(v.trim()))
      try {
        return JSON.parse(v)
      } catch {}
  }
  return v
}

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

interface Parsed {
  pos: string[]
  opts: Record<string, any>
  own: { output?: Format; tab?: string; browser?: string; field?: string; concurrency?: number; help?: boolean }
}

function parseCallArgs(argv: string[], f: LibFn | undefined): Parsed {
  const optParam = f?.params.find(p => p.options)
  const known = new Map((optParam?.options || []).map(o => [o.name, o]))
  const r: Parsed = { pos: [], opts: {}, own: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (argv[i + 1] === undefined) throw new BxError('BAD_ARGS', `${a} 后面要跟一个值`)
      return argv[++i]
    }
    if (a === '--') {
      r.pos.push(...argv.slice(i + 1))
      break
    }
    if (a === '-o' || a === '--output') r.own.output = next() as Format
    // 函数自己声明了同名参数（比如 youtube videos 的 tab）时，--tab / --browser / --field / --concurrency 交给函数；-t 始终是指定标签
    else if (/^--(tab|browser|field|concurrency)(=|$)/.test(a) && known.has(a.slice(2).split('=')[0])) {
      const [k, v] = a.slice(2).split(/=(.*)/s) as [string, string | undefined]
      r.opts[k] = convert(v ?? next(), known.get(k)!.type ?? 'any', '--' + k)
    } else if (a === '-t' || a === '--tab') r.own.tab = next()
    else if (a === '--browser') r.own.browser = next()
    else if (a === '--field') r.own.field = next()
    else if (a === '--concurrency') r.own.concurrency = Number(next())
    else if (a === '--help' || a === '-h') r.own.help = true
    else if (/^--[^-]/.test(a)) {
      let [k, v] = a.slice(2).split(/=(.*)/s) as [string, string | undefined]
      let neg = false
      if (!known.has(k) && !known.has(camel(k)) && k.startsWith('no-')) {
        k = k.slice(3)
        neg = true
      }
      const name = known.has(k) ? k : known.has(camel(k)) ? camel(k) : camel(k)
      const spec = known.get(name)
      if (neg) r.opts[name] = false
      else if (spec?.type === 'boolean') r.opts[name] = v === undefined ? true : convert(v, 'boolean', '--' + k)
      else {
        // 没声明的选项：后面跟着值就取值，否则当开关
        if (v === undefined) v = argv[i + 1] !== undefined && !/^--/.test(argv[i + 1]) ? next() : spec ? next() : 'true'
        r.opts[name] = convert(v, spec?.type ?? 'any', '--' + k)
      }
    } else r.pos.push(a)
  }
  return r
}

/** 位置参数 + 选项 → 函数的实参列表 */
function bindArgs(info: LibInfo, f: LibFn, pos: any[], opts: Record<string, any>) {
  const args: any[] = []
  const optIdx = f.params.findIndex(p => p.options)
  let k = 0
  for (let i = 0; i < f.params.length; i++) {
    const p = f.params[i]
    if (p.options) {
      args[i] = Object.keys(opts).length ? opts : p.default === undefined ? {} : undefined
      continue
    }
    if (p.rest) {
      args.push(...pos.slice(k).map(v => (typeof v === 'string' ? convert(v, 'any', p.name) : v)))
      k = pos.length
      break
    }
    if (k < pos.length) {
      const v = pos[k++]
      args[i] = typeof v === 'string' ? convert(v, p.type, `<${p.name}>`) : v
    } else if (p.default === undefined && (optIdx < 0 || i < optIdx)) {
      throw new BxError('BAD_ARGS', `缺少参数 <${p.name}>`, `用法：${cliUsage(info.domain, f)}`)
    }
  }
  if (k < pos.length) throw new BxError('BAD_ARGS', `参数多了：${pos.slice(k).join(' ')}`, `用法：${cliUsage(info.domain, f)}`)
  if (optIdx < 0 && Object.keys(opts).length) throw new BxError('BAD_ARGS', `${f.name} 没有选项参数：--${Object.keys(opts).join(' --')}`, `用法：${cliUsage(info.domain, f)}`)
  // 去掉末尾的 undefined，让默认值生效
  while (args.length && args[args.length - 1] === undefined) args.pop()
  return args
}

async function* stdinRecords(): AsyncGenerator<any> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const v = JSON.parse(t)
        if (Array.isArray(v)) {
          for (const x of v) yield x
        } else yield v
        continue
      } catch {}
    }
    yield t
  }
}

function pickKey(rec: any, keys: string[]) {
  if (typeof rec !== 'object' || rec === null) return rec
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), rec)
    if (v !== undefined && v !== null && v !== '') return v
  }
  throw new BxError('NO_FIELD', `管道输入的记录里没有字段 ${keys.join(' / ')}：${JSON.stringify(rec).slice(0, 200)}`, '用 --field <字段名> 指定取哪个字段')
}

export async function runCall(argv: string[]) {
  const domain = argv[0]
  if (!domain || domain.startsWith('-')) {
    console.log('用法：bx call <域名> <函数> [参数...] [--选项 值]\n\n有哪些函数：bx lib list [域名]')
    return
  }
  const entry = findLib(domain)
  if (!entry) throw new BxError('NO_LIB', `没有 ${domain} 的函数库`, `已有：${listLibs().map(l => l.domain).join(', ') || '(无)'}；新写一个放到 ~/.bx/lib/${domain}.js`)
  const info = libInfo(entry)
  const fnName = argv[1]
  if (!fnName || fnName.startsWith('-')) return console.log(describeLib(info))
  const f = info.functions.find(x => x.name === fnName)
  if (!f) throw new BxError('NO_FUNCTION', `${info.domain} 的函数库里没有 ${fnName}`, `有：${info.functions.map(x => x.name).join(', ')}；看用法：bx lib list ${info.domain}`)
  const a = parseCallArgs(argv.slice(2), f)
  if (a.own.help) {
    const L = [cliUsage(info.domain, f), '', f.signature]
    if (f.desc) L.push('', f.desc)
    for (const e of f.examples) L.push(`例：${e}`)
    L.push('', '通用：-o text|json|jsonl|yaml|csv|table  -t <标签>  --browser <名字>')
    L.push('管道：第一个参数写 - 就从 stdin 一行一条读，JSON 记录默认取 url 字段（--field 指定别的），--concurrency N 并发')
    return console.log(L.join('\n'))
  }
  const declared = new Set((f.params.find(p => p.options)?.options || []).map(o => o.name))
  for (const k of Object.keys(a.opts)) if (RESERVED.has(k) && !declared.has(k)) throw new BxError('BAD_ARGS', `--${k} 是 bx call 自己的选项`)

  const bx = createBx({ tab: a.own.tab || process.env.BX_TAB, browser: a.own.browser })
  ;(globalThis as any).bx = bx
  ;(globalThis as any).BxError = BxError
  const mod = await importLib(entry)
  const fn = mod[f.name]
  if (typeof fn !== 'function') throw new BxError('NO_FUNCTION', `${entry.file} 没有导出函数 ${f.name}`)

  const fromStdin = a.pos[0] === '-'
  const fmt: Format = a.own.output || (process.env.BX_FORMAT as Format) || (fromStdin || !process.stdout.isTTY ? 'jsonl' : 'text')
  const stream = fmt === 'jsonl'
  const collected: any[] = []
  let emitted = 0
  const undef = new Map<string, number>()
  const emit = (x: any) => {
    if (x === undefined) return
    emitted++
    if (x && typeof x === 'object' && !Array.isArray(x)) for (const [k, v] of Object.entries(x)) if (v === undefined) undef.set(k, (undef.get(k) || 0) + 1)
    if (stream) process.stdout.write(JSON.stringify(x) + '\n')
    else collected.push(x)
  }
  const runOnce = async (pos: any[]) => {
    const r = fn(...bindArgs(info, f, pos, a.opts))
    if (r && typeof r[Symbol.asyncIterator] === 'function') {
      for await (const x of r) emit(x)
    } else {
      const v = await r
      if (Array.isArray(v)) v.forEach(emit)
      else emit(v)
    }
  }

  try {
    if (fromStdin) {
      const first = f.params.find(p => !p.options)?.name
      const keys = a.own.field ? [a.own.field] : ['url', ...(first ? [first] : []), 'id']
      const conc = Math.max(1, a.own.concurrency || 1)
      const running = new Set<Promise<void>>()
      let failed = 0
      for await (const rec of stdinRecords()) {
        const p = (async () => {
          let key: any
          try {
            key = pickKey(rec, keys)
            await runOnce([typeof key === 'string' ? key : key, ...a.pos.slice(1)])
          } catch (e: any) {
            failed++
            process.stderr.write(`✗ ${JSON.stringify(key ?? rec).slice(0, 120)}: ${e.code && e.code !== 'ERROR' ? `[${e.code}] ` : ''}${e.message}${e.hint ? '\n  → ' + e.hint : ''}\n`)
          }
        })()
        running.add(p)
        p.finally(() => running.delete(p))
        if (running.size >= conc) await Promise.race(running)
      }
      await Promise.all(running)
      if (failed) process.exitCode = 3
    } else await runOnce(a.pos)
  } finally {
    for (const [k, c] of undef) if (c === emitted && emitted > 1) process.stderr.write(`⚠ 字段 ${k} 在全部 ${c} 条记录里都是 undefined（字段路径写错了？）\n`)
    bx.close()
  }
  if (!stream) {
    const out = collected.length === 1 && fmt !== 'csv' && fmt !== 'table' ? collected[0] : collected
    const s = render(out, fmt)
    if (s) console.log(s)
  }
}

/** bx lib list [域名] */
export function libList(domain: string | undefined, fmt: Format) {
  if (domain) {
    const entry = findLib(domain)
    if (!entry) throw new BxError('NO_LIB', `没有 ${domain} 的函数库`, `已有：${listLibs().map(l => l.domain).join(', ') || '(无)'}`)
    const info = libInfo(entry)
    return fmt === 'text' ? describeLib(info) : info
  }
  const libs = listLibs().map(e => {
    try {
      const i = libInfo(e)
      const site = i.login?.level || 'none'
      return {
        domain: e.domain,
        scope: e.scope,
        login: site,
        functions: i.functions.map(f => f.name),
        /** 和站点默认值不一样的函数 */
        loginFns: Object.fromEntries(i.functions.filter(f => fnLogin(i, f).level !== site).map(f => [f.name, fnLogin(i, f).level])),
        file: e.file,
      }
    } catch (err: any) {
      return { domain: e.domain, scope: e.scope, login: 'none', functions: [], loginFns: {}, file: e.file, error: err.message }
    }
  })
  if (fmt !== 'text') return libs
  if (!libs.length) return '还没有函数库。写法见仓库 docs/lib.md，放到 ~/.bx/lib/<域名>.js'
  const w = Math.max(...libs.map(l => l.domain.length)) + 2
  const tag: Record<string, string> = { required: '[要登录]  ', optional: '[登录更好]', none: '          ' }
  const mark: Record<string, string> = { required: '（要登录）', optional: '（登录更好）', none: '（不用登录）' }
  return [
    ...libs.map(
      l =>
        `${l.domain.padEnd(w)}${tag[l.login]} ${l.functions.map(f => (l.loginFns as any)[f] ? f + mark[(l.loginFns as any)[f]] : f).join(' ')}${l.scope !== 'builtin' ? `   （${l.scope}）` : ''}${(l as any).error ? `   ⚠ ${(l as any).error}` : ''}`,
    ),
    '',
    '[要登录] 没登录会报 NEED_LOGIN；[登录更好] 不登录也能用但会受限。调研前可以先请用户在浏览器里登录这些网站',
    '详细用法（签名、说明、例子、站点笔记）：bx lib list <域名>',
  ].join('\n')
}

export { importLib }
