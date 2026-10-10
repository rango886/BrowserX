// 第 2 步：把挑中的条目的评论 / 正文拉下来
// 用法：bx run -f step2.js 0,3,31,47      ← 序号来自第 1 步的输出（PowerShell 里要加引号："0,3,31,47"）
import fs from 'node:fs'

// ← 可选：只看和问题相关的段落（正则，不分大小写）。留空就看每条的开头几段
const KEY = '' // 例：'production|WAL|concurren|并发'

const posts = JSON.parse(fs.readFileSync('research/posts.json', 'utf8'))
const picked = String(bx.args[0] || '').split(',').filter(Boolean).map(Number).map(i => posts[i]).filter(Boolean)
if (!picked.length) throw new BxError('BAD_ARGS', '要挑哪几条？', '例：bx run -f step2.js 0,2,5（序号见第 1 步的输出）')

// 每个来源怎么取详情：有函数库的用函数库（评论是一条一段），其余当普通网页读正文，按段落拆开
async function detail(p) {
  if (p.site === 'hn') return (await bx.lib('news.ycombinator.com').comments(p.url, { limit: 80 })).map(c => c.text)
  if (p.site === 'reddit') return (await bx.lib('reddit.com').comments(p.url, { limit: 80 })).map(c => c.text)
  if (p.site === 'bili') return (await bx.lib('bilibili.com').comments(p.url, { limit: 40 })).map(c => c.text)
  // 文章：设了 KEY 就让 read 只返回命中的段落（带前后一段上下文），没设就取全文按空行拆段
  if (KEY) return (await bx.read(p.url, { grep: KEY, context: 1, budget: 8000 })).matches.map(m => m.text)
  const r = await bx.read(p.url, { budget: 8000 })
  return String(r.content || '').split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length > 20)
}

// 限并发：同时最多 3 个，别一下开一堆标签，也别被限流
async function pool(items, n, fn) {
  const out = []
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const k = next++
      out[k] = await fn(items[k]).then(v => ({ v }), e => ({ e }))
    }
  }))
  return out
}

const rs = await pool(picked, 3, detail)
await bx.cleanup()
const threads = picked.map((p, k) => ({ ...p, texts: rs[k].v || [], error: rs[k].e && `[${rs[k].e.code || 'ERROR'}] ${rs[k].e.message}` }))
fs.writeFileSync('research/threads.json', JSON.stringify(threads, null, 1))

// 给 AI 看的：评论 / 段落都是一条一段。设了 KEY 时评论也按它过滤（文章已经在 read 里过滤过了）
const re = KEY ? new RegExp(KEY, 'i') : null
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
return threads
  .map(t => {
    const isArticle = !['hn', 'reddit', 'bili'].includes(t.site)
    const texts = re && !isArticle ? t.texts.filter(s => re.test(s)) : t.texts
    const head = t.error ? `⚠ ${t.error}` : `（共 ${t.texts.length} 段${re ? `，命中 ${texts.length} 段` : ''}，下面是前 12 段）`
    return [`## [${t.site}] ${t.title}`, t.url, head, ...texts.slice(0, 12).map(s => `- ${clip(s, isArticle ? 400 : 250)}`)].join('\n')
  })
  .join('\n\n')
