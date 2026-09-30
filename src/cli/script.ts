import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { BX_HOME, REPO_ROOT, ensureDir, findProjectDir } from '../common/paths.ts'
import { BxError } from '../common/util.ts'
import { digestTrace, loadTrace, candidatesFrom, guessSite, type Digest } from '../trace/digest.ts'
import { yaml, table } from './output.ts'

export function traceDirOf(name: string) {
  const d = path.join(BX_HOME, 'traces', name)
  if (!fs.existsSync(path.join(d, 'trace.json'))) throw new BxError('NO_TRACE', `没有 trace ${name}`, '`bx trace list` 查看已有的录制')
  return d
}

// =====================================================================
// bx script new：根据 trace 生成脚本骨架
// =====================================================================

const ident = (s: string) => (/^[A-Za-z_$][\w$]*$/.test(s) ? s : JSON.stringify(s))

function accessor(p: string) {
  // data.replies → j.data?.replies
  return p
    .split('.')
    .filter(Boolean)
    .map(k => (/^[A-Za-z_$][\w$]*$/.test(k) ? `?.${k}` : `?.[${JSON.stringify(k)}]`))
    .join('')
    .replace(/^\?\./, '')
}

function genFromDigest(site: string, traceName: string, tr: ReturnType<typeof loadTrace>, dg: Digest) {
  const g = guessSite(tr)
  const ep = dg.endpoints.find(e => e.matched.size > 0) || dg.endpoints.find(e => e.reqs.some(r => ['xhr', 'fetch'].includes(r.type)))
  const lines: string[] = []
  const P = (s = '') => lines.push(s)
  P(`// ${site} 站点脚本 —— 由 \`bx script new\` 根据 trace "${traceName}" 生成的骨架`)
  P(`// 调查报告：./TRACE.md（先读它：数据来自哪个接口、哪些参数要变、有没有签名）`)
  P(`// 写法：${path.join(REPO_ROOT, 'docs', 'sites.md')}`)
  P(`// 验证：bx script test ${site} <命令> [参数] --from-trace ${traceName}`)
  P('')
  P('export default {')
  P(`  name: ${JSON.stringify(site)},`)
  P(`  description: ${JSON.stringify(tr.goal || 'TODO: 一句话说明')},`)
  if (g.home) P(`  home: ${JSON.stringify(g.home)},`)
  if (g.domain) P(`  domains: [${JSON.stringify(g.domain)}],`)
  P('  commands: {')
  P(`    // TODO: 改成有意义的命令名，比如 'search' / 'video comments' / 'user posts'`)
  P('    list: {')
  P(`      summary: ${JSON.stringify(tr.goal || 'TODO')},`)

  if (!ep) {
    P(`      args: [{ name: 'url', desc: '页面地址' }],`)
    P(`      opts: { limit: { type: 'number', default: 20 } },`)
    P('      async *run(ctx) {')
    P('        // 报告里没找到合适的接口：先用页面提取')
    P('        const tab = await ctx.open(ctx.args.url)')
    P('        const r = await tab.read({ limit: ctx.opts.limit })')
    P('        yield* r.items || [{ title: r.title, content: r.content }]')
    P('      },')
  } else {
    const r0 = ep.reqs[0]
    const u = new URL(r0.url)
    // 列表字段：命中最多的、带 [] 的路径
    const hot = [...ep.hits.entries()].sort((a, b) => b[1].size - a[1].size).map(([p]) => p)
    const listPath = hot.find(p => p.includes('[]'))?.split('[]')[0] || ''
    const itemFields = [...new Set(hot.filter(p => listPath && p.startsWith(listPath + '[]')).map(p => p.slice(listPath.length + 2).replace(/^\./, '')).filter(f => f && !f.includes('[]')))].slice(0, 8)
    const params = ep.params.filter(p => !p.key.startsWith('body.'))
    const signed = params.some(p => p.notes.some(n => n.includes('签名')))
    const pageP = params.find(p => p.notes.some(n => n.includes('翻页')))
    const inputP = params.find(p => p.notes.some(n => n.startsWith('来自输入')))
    const kind = r0.type === 'document' ? 'html' : 'json'

    P(`      args: [{ name: ${JSON.stringify(inputP ? 'query' : 'id')}, desc: 'TODO' }],`)
    P(`      opts: { limit: { type: 'number', default: 20, desc: '最多多少条' } },`)
    P('      async *run(ctx) {')
    P(`        // 数据来源：${ep.key}（命中 ${ep.matched.size} 条看到的内容）`)
    for (const p of params) P(`        //   ${p.key} = ${JSON.stringify(p.values[0] ?? '').slice(0, 60)}${p.notes.length ? '   ← ' + p.notes.join('；') : ''}`)
    const steps = tr.events.filter(e => ['action', 'user', 'navigate'].includes(e.type)).slice(0, 12)
    if (steps.length) {
      P(`        // 录制时的操作（要在页面上触发接口时参考）：`)
      for (const e of steps) {
        const tg = e.target?.selector ? ` [${e.target.selector}]` : ''
        const what = e.type === 'navigate' ? `打开 ${e.url}` : e.type === 'user' ? `手动 ${e.kind}${tg}${e.value ? ' = ' + JSON.stringify(e.value) : ''}` : `${e.method}${tg}${e.args?.text ? ' = ' + JSON.stringify(e.args.text) : ''}${e.args?.submit ? ' + 回车' : ''}${e.args?.url ? ' ' + e.args.url : ''}`
        P(`        //   - ${what}`)
      }
    }
    if (kind === 'html') {
      P(`        // 数据在 HTML 里：打开页面后从 DOM / 页面变量读`)
      P(`        const tab = await ctx.open(${JSON.stringify(r0.url)})`)
      P(`        const data = await tab.eval(() => {`)
      P(`          // TODO: 比如 return window.__INITIAL_STATE__，或者 querySelectorAll(...).map(...)`)
      P(`          return [...document.querySelectorAll('a')].slice(0, 20).map(a => ({ title: a.innerText.trim(), url: a.href }))`)
      P(`        })`)
      P(`        yield* data.slice(0, ctx.opts.limit)`)
    } else if (signed) {
      P(`        // ⚠ 有签名参数：让页面自己发请求，我们截获响应（方案 A）。也可以研究签名算法在 Node 里实现（方案 B，参考 sites/bili/wbi.js）`)
      P(`        const tab = await ctx.open('about:blank')`)
      P(`        const wait = tab.waitResponse(${JSON.stringify(u.pathname)})`)
      P(`        await tab.goto(${JSON.stringify(tr.events.find(e => e.type === 'navigate' && e.tab === r0.tab)?.url || g.home || '')}) // TODO: 触发这个接口的页面`)
      P(`        const j = await wait`)
      P(`        const list = ${listPath ? 'j' + (accessor(listPath) ? '?.' + accessor(listPath) : '') : 'j'} || []`)
      P(`        for (const x of list.slice(0, ctx.opts.limit)) yield ${itemFields.length ? '{ ' + itemFields.map(f => `${ident(f.replace(/[^\w]+/g, '_'))}: x${'?.' + accessor(f)}`).join(', ') + ' }' : 'x'}`)
      P(`        // TODO: 翻页 —— 在页面上点"下一页"（tab.click）后再 waitResponse 一次`)
    } else {
      const qs = params.map(p => {
        const k = JSON.stringify(p.key)
        if (p === pageP) return `${k}: String(page)`
        if (p === inputP) return `${k}: ctx.args.query`
        if (p.notes.includes('时间戳')) return `${k}: String(Math.floor(Date.now() / ${p.values[0].length === 13 ? 1 : 1000}))`
        return `${k}: ${JSON.stringify(p.values[0] ?? '')}${p.notes.some(n => n.startsWith('来自')) ? ' /* TODO: ' + p.notes.join('；') + ' */' : ''}`
      })
      P(`        const tab = await ctx.tab() // 复用已打开的本站标签（带登录状态）`)
      P(`        let n = 0`)
      P(`        for (let page = ${pageP && /^\d+$/.test(pageP.values[0]) ? pageP.values[0] : 1}; n < ctx.opts.limit && page <= 50; page++) {`)
      P(`          const qs = new URLSearchParams({`)
      for (const q of qs) P(`            ${q},`)
      P(`          })`)
      if (r0.method !== 'GET') P(`          // TODO: 这是 ${r0.method} 请求，请求体见报告：tab.fetch(url, { method: '${r0.method}', headers: { 'content-type': 'application/json' }, body: JSON.stringify({...}) })`)
      P(`          const j = await tab.fetch(\`${u.origin}${u.pathname}?\${qs}\`)`)
      P(`          const list = ${listPath ? 'j' + (accessor(listPath) ? '?.' + accessor(listPath) : '') : '[j]'} || []`)
      P(`          if (!list.length) break`)
      P(`          for (const x of list) {`)
      P(`            yield ${itemFields.length ? '{ ' + itemFields.map(f => `${ident(f.replace(/[^\w]+/g, '_'))}: x${'?.' + accessor(f)}`).join(', ') + ' }' : 'x'} // TODO: 挑需要的字段，带上能给下一个命令用的主键（id / url）`)
      P(`            if (++n >= ctx.opts.limit) return`)
      P(`          }`)
      if (!pageP) P(`          break // TODO: 报告里没识别出翻页参数，需要的话自己加`)
      P(`          await ctx.sleep(300)`)
      P(`        }`)
    }
    P('      },')
  }
  P('    },')
  P('  },')
  P('}')
  return lines.join('\n') + '\n'
}

export function scriptNew(site: string, o: { fromTrace?: string; project?: boolean }) {
  if (!/^[a-z][\w-]*$/i.test(site)) throw new BxError('BAD_ARGS', '站点名只能用字母、数字、- 和 _')
  let base: string
  if (o.project) base = path.join(findProjectDir() || path.join(process.cwd(), '.bx'), 'sites')
  else base = path.join(BX_HOME, 'sites')
  const dir = path.join(base, site)
  const file = path.join(dir, 'index.js')
  if (fs.existsSync(file)) throw new BxError('EXISTS', `已经有 ${file}`, '直接编辑它，或者换个名字')
  ensureDir(dir)
  let code: string
  const out: any = { file }
  if (o.fromTrace) {
    const td = traceDirOf(o.fromTrace)
    const tr = loadTrace(td)
    const dg = digestTrace(td)
    fs.writeFileSync(path.join(dir, 'TRACE.md'), dg.text)
    code = genFromDigest(site, o.fromTrace, tr, dg)
    out.report = path.join(dir, 'TRACE.md')
  } else {
    code = `// ${site} 站点脚本，写法见 ${path.join(REPO_ROOT, 'docs', 'sites.md')}
export default {
  name: ${JSON.stringify(site)},
  description: 'TODO',
  home: 'https://example.com',
  domains: ['example.com'],
  commands: {
    hello: {
      summary: '示例：读页面标题',
      async run(ctx) {
        const tab = await ctx.tab()
        return { title: await tab.eval(() => document.title), url: await tab.url() }
      },
    },
  },
}
`
  }
  fs.writeFileSync(file, code)
  out.next = [
    out.report ? `1. 读调查报告 ${out.report}` : '1. 想清楚要从哪个接口 / 页面拿数据（可以先 bx trace start 录一遍）',
    `2. 编辑 ${file}（骨架里的 TODO）`,
    `3. bx ${site} --help 看命令；bx script test ${site} <命令> [参数]${o.fromTrace ? ` --from-trace ${o.fromTrace}` : ''} 验证`,
  ]
  return out
}

// =====================================================================
// bx script test：跑一遍命令，检查输出，和 trace 里看到的内容对比
// =====================================================================

export async function scriptTest(site: string, argv: string[], o: { fromTrace?: string; min?: number; timeout?: number }) {
  const t0 = Date.now()
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'bin', 'bx.js'), site, ...argv, '-o', 'jsonl'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', d => (out += d))
  child.stderr.on('data', d => (err += d))
  const timeout = o.timeout || 120000
  const code: number = await new Promise(r => {
    const t = setTimeout(() => {
      child.kill()
      err += `\n(超时 ${timeout}ms，已终止)`
      r(124)
    }, timeout)
    child.on('close', c => {
      clearTimeout(t)
      r(c ?? 1)
    })
  })
  const records: any[] = []
  const bad: string[] = []
  for (const line of out.split('\n').filter(l => l.trim())) {
    try {
      records.push(JSON.parse(line))
    } catch {
      bad.push(line.slice(0, 100))
    }
  }
  const problems: string[] = []
  const min = o.min ?? 1
  if (code !== 0) problems.push(`退出码 ${code}`)
  if (records.length < min) problems.push(`只输出了 ${records.length} 条（至少要 ${min} 条）`)
  if (bad.length) problems.push(`${bad.length} 行不是 JSON（数据要 yield / return，日志用 ctx.log）`)
  for (const m of err.matchAll(/⚠ 字段 (\S+) 在全部 \d+ 条记录里都是 undefined/g)) problems.push(`字段 ${m[1]} 全是 undefined（字段路径写错了？）`)

  // 字段统计
  const fields = new Map<string, { filled: number; sample: any; types: Set<string> }>()
  const objs = records.filter(r => r && typeof r === 'object' && !Array.isArray(r))
  for (const r of objs)
    for (const [k, v] of Object.entries(r)) {
      const f = fields.get(k) || fields.set(k, { filled: 0, sample: undefined, types: new Set() }).get(k)!
      if (v !== null && v !== undefined && v !== '') {
        f.filled++
        if (f.sample === undefined) f.sample = v
        f.types.add(Array.isArray(v) ? 'array' : typeof v)
      }
    }
  const fieldRows = [...fields.entries()].map(([k, f]) => ({
    field: k,
    filled: `${Math.round((f.filled / Math.max(1, objs.length)) * 100)}%`,
    type: [...f.types].join('/'),
    sample: typeof f.sample === 'object' ? JSON.stringify(f.sample).slice(0, 60) : String(f.sample ?? '').slice(0, 60),
  }))
  for (const r of fieldRows) if (r.filled === '0%') problems.push(`字段 ${r.field} 全是空的（字段路径写错了？）`)
  if (objs.length > 1) {
    const allUndef = fieldRows.filter(r => r.filled !== '100%' && r.filled !== '0%').map(r => r.field)
    if (allUndef.length) problems.push(`这些字段有时为空：${allUndef.join(', ')}（正常的话可以忽略）`)
  }
  const hasKey = fieldRows.some(r => /^(id|.*_?id|url|bvid|mid|uid|rpid|href)$/i.test(r.field))
  if (objs.length && !hasKey) problems.push('记录里没有像主键的字段（id / url …），管道里下一个命令不好用')

  // 和 trace 对比
  let coverage: any
  if (o.fromTrace) {
    const tr = loadTrace(traceDirOf(o.fromTrace))
    const cands = candidatesFrom(
      tr.events.filter(e => e.type === 'observe' && e.output).map(e => String(e.output)),
      500,
      tr.events.filter(e => e.url).map(e => String(e.url).replace(/#.*$/, '')),
    )
    const blob = records.map(r => JSON.stringify(r)).join('\n')
    const blobPlain = JSON.stringify(records.map(r => JSON.parse(JSON.stringify(r)))).replace(/\\n/g, ' ')
    const hit = cands.filter(c => {
      if (blob.includes(c) || blobPlain.includes(c) || blob.includes(JSON.stringify(c).slice(1, -1))) return true
      // 一行字由多个字段拼成（"标题 作者 播放 123"）：拆成词，大部分词都在输出里也算
      const words = c.split(/\s+/).filter(w => w.length >= 2)
      return words.length >= 2 && words.filter(w => blobPlain.includes(w)).length / words.length >= 0.75
    })
    coverage = { seen: cands.length, found: hit.length, examples: hit.slice(0, 3), missing: cands.filter(c => !hit.includes(c)).slice(0, 5) }
  }

  const ok = problems.filter(p => !p.includes('有时为空') && !p.includes('主键')).length === 0
  const lines: string[] = []
  lines.push(`${ok ? '✓' : '✗'} bx ${site} ${argv.join(' ')}`)
  lines.push(`输出 ${records.length} 条 · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 退出码 ${code}`)
  if (problems.length) lines.push('', '问题：', ...problems.map(p => '  - ' + p))
  if (fieldRows.length) lines.push('', '字段：', table(fieldRows))
  if (coverage) {
    lines.push('', `和 trace "${o.fromTrace}" 对比：录制时看到的 ${coverage.seen} 条内容里，${coverage.found} 条出现在输出里`)
    if (coverage.examples.length) lines.push(`  对上的：${coverage.examples.map((x: string) => JSON.stringify(x.slice(0, 40))).join('，')}`)
    if (coverage.found === 0 && coverage.seen) lines.push('  ⚠ 一条都没对上：数据来源可能不对，或者参数和录制时不同（录制时看的是别的关键词 / 页面？）')
    else if (coverage.missing.length) lines.push(`  没对上的例子（可能是页面文案，不一定是问题）：${coverage.missing.slice(0, 3).map((x: string) => JSON.stringify(x.slice(0, 30))).join('，')}`)
  }
  if (records.length) lines.push('', '前 2 条：', yaml(records.slice(0, 2)))
  if (err.trim()) lines.push('', 'stderr：', err.trim().split('\n').slice(-15).join('\n'))
  return { ok, text: lines.join('\n') }
}
