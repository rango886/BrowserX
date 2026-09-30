import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { searchDirs } from '../common/paths.ts'
import { BxError } from '../common/util.ts'
import { RpcClient } from '../common/rpc.ts'
import { makeCtx, normArgs, type CommandSpec, type SiteSpec } from '../sdk/index.ts'
import { render, type Format } from './output.ts'

export interface SiteEntry {
  name: string
  scope: string
  file: string
}

/** 扫描所有站点：sites/<name>/index.{ts,js} 或 sites/<name>.{ts,js}；项目级覆盖全局，全局覆盖内置 */
export function listSites(): SiteEntry[] {
  const out = new Map<string, SiteEntry>()
  for (const { scope, dir } of searchDirs('sites')) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue
      let file: string | undefined
      let name = e.name
      if (e.isDirectory()) file = ['index.ts', 'index.js', 'index.mjs'].map(f => path.join(dir, e.name, f)).find(f => fs.existsSync(f))
      else if (/\.(ts|m?js)$/.test(e.name)) {
        file = path.join(dir, e.name)
        name = e.name.replace(/\.(ts|m?js)$/, '')
      }
      if (file && !out.has(name)) out.set(name, { name, scope, file })
    }
  }
  return [...out.values()]
}

export async function loadSite(name: string): Promise<SiteSpec | null> {
  const e = listSites().find(s => s.name === name)
  if (!e) return null
  const mod = await import(pathToFileURL(e.file).href + '?v=' + fs.statSync(e.file).mtimeMs)
  const site: SiteSpec = mod.default
  if (!site?.commands) throw new BxError('BAD_SITE', `${e.file} 需要 export default { name, commands }`)
  site.name ||= name
  ;(site as any).__file = e.file
  ;(site as any).__scope = e.scope
  return site
}

function usage(site: SiteSpec, name: string, c: CommandSpec) {
  const args = normArgs(c).map(a => (a.optional ? `[${a.name}${a.rest ? '...' : ''}]` : `<${a.name}${a.rest ? '...' : ''}>`))
  const lines = [`bx ${site.name} ${name} ${args.join(' ')}`.trimEnd(), '']
  if (c.summary) lines.push(c.summary)
  if (c.description) lines.push(c.description)
  const argsSpec = normArgs(c).filter(a => a.desc)
  if (argsSpec.length) lines.push('', '参数：', ...argsSpec.map(a => `  ${a.name.padEnd(16)} ${a.desc}`))
  const opts = Object.entries(c.opts || {})
  if (opts.length) {
    lines.push('', '选项：')
    for (const [k, o] of opts) {
      const flag = `--${k}${o.short ? `, -${o.short}` : ''}${o.type && o.type !== 'boolean' ? ` <${o.type}>` : ''}`
      const extra = [o.choices ? `可选: ${o.choices.join('|')}` : '', o.default !== undefined ? `默认: ${o.default}` : ''].filter(Boolean).join('，')
      lines.push(`  ${flag.padEnd(24)} ${o.desc || ''}${extra ? `（${extra}）` : ''}`)
    }
  }
  lines.push('', '通用：-o text|json|jsonl|yaml|csv|table   --browser <名字>   -t <标签>')
  const key = c.key || normArgs(c)[0]?.name
  if (key) lines.push(`管道：第一个参数写 - 表示从 stdin 读 JSONL，取每条记录的 ${[].concat(key as any).join(' / ')} 字段`)
  if (c.examples?.length) lines.push('', '例子：', ...c.examples.map(e => '  ' + e))
  return lines.join('\n')
}

export function siteHelp(site: SiteSpec) {
  const lines = [`bx ${site.name}${site.description ? ' — ' + site.description : ''}`, '', '命令：']
  const names = Object.keys(site.commands)
  const w = Math.max(...names.map(n => n.length)) + 2
  for (const n of names) {
    const c = site.commands[n]
    const args = normArgs(c).map(a => (a.optional ? `[${a.name}]` : `<${a.name}>`)).join(' ')
    lines.push(`  ${(n + ' ' + args).padEnd(w + 14)} ${c.summary || ''}`)
  }
  lines.push('', `详细用法：bx ${site.name} <命令> --help`)
  lines.push(`文件：${(site as any).__file}（${(site as any).__scope}）`)
  return lines.join('\n')
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

export interface GlobalOpts {
  output?: Format
  browser?: string
  tab?: string
}

/** 运行站点命令：bx <site> <command...> [args] [--opts] */
export async function runSite(site: SiteSpec, argv: string[], g: GlobalOpts) {
  // 最长匹配命令名（命令名可以有空格，比如 "video info"）
  const words: string[] = []
  for (const a of argv) {
    if (a.startsWith('-')) break
    words.push(a)
  }
  let cmdName = ''
  for (let n = Math.min(words.length, 4); n > 0; n--) {
    const cand = words.slice(0, n).join(' ')
    if (site.commands[cand]) {
      cmdName = cand
      break
    }
  }
  if (!cmdName) {
    if (words.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      console.log(siteHelp(site))
      return
    }
    throw new BxError('UNKNOWN_COMMAND', `${site.name} 没有命令 "${words.join(' ')}"`, `可用：${Object.keys(site.commands).join(' | ')}`)
  }
  const cmd = site.commands[cmdName]
  const rest = argv.slice(cmdName.split(' ').length)
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(usage(site, cmdName, cmd))
    return
  }

  const options: any = {
    output: { type: 'string', short: 'o' },
    browser: { type: 'string' },
    tab: { type: 'string', short: 't' },
    field: { type: 'string' },
    concurrency: { type: 'string' },
  }
  for (const [k, o] of Object.entries(cmd.opts || {})) options[k] = { type: o.type === 'boolean' ? 'boolean' : 'string', ...(o.short ? { short: o.short } : {}) }
  const { values, positionals } = parseArgs({ args: rest, options, allowPositionals: true, strict: true, allowNegative: true } as any)
  const v: any = values
  const fmt: Format = v.output || g.output || (process.env.BX_FORMAT as Format) || (process.stdout.isTTY ? 'text' : 'jsonl')
  const global = { browser: v.browser || g.browser, tab: v.tab || g.tab, opened: [] as string[] }

  const opts: any = {}
  for (const [k, o] of Object.entries(cmd.opts || {})) {
    let x = v[k] ?? o.default
    if (o.type === 'number' && x !== undefined) {
      x = Number(x)
      if (Number.isNaN(x)) throw new BxError('BAD_ARGS', `--${k} 需要数字`)
    }
    if (o.choices && x !== undefined && !o.choices.includes(x)) throw new BxError('BAD_ARGS', `--${k} 只能是 ${o.choices.join(' | ')}`)
    opts[k] = x
  }

  const argSpecs = normArgs(cmd)
  const bindArgs = (pos: string[]) => {
    const a: any = {}
    argSpecs.forEach((s, i) => {
      a[s.name] = s.rest ? pos.slice(i) : pos[i]
      if (!s.optional && (a[s.name] === undefined || (s.rest && !a[s.name].length)))
        throw new BxError('BAD_ARGS', `缺少参数 <${s.name}>`, usage(site, cmdName, cmd).split('\n')[0])
    })
    return a
  }

  const rpc = await RpcClient.connect()
  const collected: any[] = []
  const stream = fmt === 'jsonl'
  const emit = (x: any) => {
    if (x === undefined) return
    if (stream) process.stdout.write(JSON.stringify(x) + '\n')
    else collected.push(x)
  }
  const runOnce = async (args: any, input?: any) => {
    const ctx = makeCtx(rpc, site, args, opts, input, global)
    const r = cmd.run(ctx)
    if (r && typeof r[Symbol.asyncIterator] === 'function') {
      for await (const x of r) emit(x)
    } else {
      const val = await r
      if (Array.isArray(val)) val.forEach(emit)
      else emit(val)
    }
  }

  try {
    const fromStdin = positionals[0] === '-' || (positionals.length === 0 && argSpecs[0] && !argSpecs[0].optional && !process.stdin.isTTY)
    if (fromStdin) {
      const keys = v.field ? [v.field] : ([] as string[]).concat(cmd.key || argSpecs[0]?.name || 'id', 'id')
      const conc = Math.max(1, Number(v.concurrency || 1))
      const running = new Set<Promise<void>>()
      let failed = 0
      for await (const rec of stdinRecords()) {
        const p = (async () => {
          try {
            await runOnce(bindArgs([String(pickKey(rec, keys)), ...positionals.slice(1)]), rec)
          } catch (e: any) {
            failed++
            process.stderr.write(`✗ ${JSON.stringify(typeof rec === 'object' ? pickKey(rec, keys) : rec)}: ${e.message}${e.hint ? '\n  ' + e.hint : ''}\n`)
          }
        })()
        running.add(p)
        p.finally(() => running.delete(p))
        if (running.size >= conc) await Promise.race(running)
      }
      await Promise.all(running)
      if (failed) process.exitCode = 3
    } else {
      await runOnce(bindArgs(positionals))
    }
  } finally {
    if (global.opened.length && !process.env.BX_KEEP_TABS) await rpc.call('tab.close', { ids: global.opened }).catch(() => {})
    if (!stream) {
      const out = collected.length === 1 && !Array.isArray(collected[0]) && fmt !== 'csv' && fmt !== 'table' ? collected[0] : collected
      const s = render(out, fmt)
      if (s) console.log(s)
    }
    rpc.close()
  }
}
