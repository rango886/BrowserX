// 第 1 步：几个站并行搜，规整成同一种结构，写文件；只把摘要返回给自己看
// 用法：bx run -f step1.js            （在一个工作目录里跑，结果写到 ./research/）
import fs from 'node:fs'

// ← 每次只改这里：问题拆成几组关键词（英文站用英文，中文站用中文）
const Q = { en: 'sqlite production', zh: 'SQLite 生产环境' }

// 每个来源：怎么搜 + 怎么规整成 { title, url, heat, time, snippet }
// 先 `bx lib list` 看有哪些现成函数；没有函数库的网站，用 google 的 site: 搜索兜底
const sources = {
  hn: {
    search: () => bx.lib('news.ycombinator.com').search(Q.en, { days: 365, limit: 30 }),
    norm: p => ({ title: p.title, url: p.url, heat: `${p.points ?? 0}分 ${p.comments ?? 0}评`, time: p.time }),
  },
  reddit: {
    search: () => bx.lib('reddit.com').search(Q.en, { time: 'year', limit: 30 }),
    norm: p => ({ title: p.title, url: p.url, heat: `${p.score ?? 0}赞 ${p.comments ?? 0}评`, time: p.time, snippet: `r/${p.sub}` }),
  },
  bili: {
    search: () => bx.lib('bilibili.com').search(Q.zh, { limit: 20 }),
    norm: p => ({ title: p.title, url: p.url, heat: `${p.play ?? 0}播放`, time: p.pubdate, snippet: p.author }),
  },
  google: {
    search: () => bx.lib('google.com').search(Q.zh, { limit: 20, time: 'year' }),
    norm: p => ({ title: p.title, url: p.url, snippet: p.snippet }),
  },
}

const names = Object.keys(sources)
// allSettled：一个站失败（没登录 / 被风控）不影响其它站，失败原因也要报出来
const settled = await Promise.allSettled(names.map(n => sources[n].search()))
const status = {}
let posts = []
settled.forEach((r, i) => {
  const site = names[i]
  if (r.status === 'rejected') return (status[site] = `失败 [${r.reason?.code || 'ERROR'}] ${r.reason?.message}`)
  status[site] = `${r.value.length} 条`
  for (const p of r.value) posts.push({ site, ...sources[site].norm(p) })
})
await bx.cleanup() // 关掉这次自己开的标签（用户原来的标签不动）

// 去重；保留各站自己的相关度顺序（按评论数排会把跑题的热帖排到前面）
const seen = new Set()
posts = posts.filter(p => p.url && !seen.has(p.url) && seen.add(p.url))
fs.mkdirSync('research', { recursive: true })
fs.writeFileSync('research/posts.json', JSON.stringify(posts, null, 1))

// 给 AI 看的：每个来源的状态 + 一行一条（每站最多 15 条），序号就是 posts.json 里的下标
const line = (p, i) => `${i} [${p.site}] ${p.heat ? p.heat + ' ' : ''}${(p.time || '').slice(0, 10)} ${p.title.slice(0, 80)}${p.snippet ? ' — ' + p.snippet.slice(0, 50) : ''}`
return [
  `来源：${names.map(s => `${s} ${status[s]}`).join('；')}`,
  `共 ${posts.length} 条，完整列表：research/posts.json`,
  ...names.flatMap(s => posts.map((p, i) => [p, i]).filter(([p]) => p.site === s).slice(0, 15).map(([p, i]) => line(p, i))),
].join('\n')
