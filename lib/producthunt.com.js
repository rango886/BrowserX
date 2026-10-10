/* 站点笔记（Product Hunt，每天发布新产品、大家投票的网站，按太平洋时间算“一天”）：
 * - 都不用登录，Node 直接 fetch 网页；被 Cloudflare 拦（403）时自动改到浏览器的 producthunt.com 标签里请求
 * - 页面里有 Apollo 的 SSR 数据：<script>(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push({rehydrate:{…}})</script>
 *   里面是 JS 不是 JSON（有 :undefined），换成 null 再解析。一页有好几个查询，同名字段（product）会出现多次，要合并
 *   首页 → homefeed.edges[0].node.items（今天发布的，FEATURED-0）；排行榜 /leaderboard/daily/Y/M/D、/weekly/Y/<ISO 周>、
 *   /monthly/Y/M、/yearly/Y → homefeedItems.edges（20 条，再往后要 GraphQL）；分类页 /categories/<slug> → productCategory.products（15 条）；
 *   搜索 /search?q= → productSearch；产品页 /products/<slug> → product（websiteUrl followersCount reviewsRating categories …）
 * - Post 字段：latestScore 是票数，hideVotesCount=true 时（发布后头 4 小时）票数不公开、顺序是随机的；dailyRank weeklyRank monthlyRank
 * - 排行榜带 accept: text/markdown 会返回给 AI 看的 Markdown（只有前 10 名，带官网链接和完整介绍）；月榜、年榜不管 accept 都返回 Markdown，hot 两种都能解析
 * - RSS：/feed（最新 50 条，?category=<slug> 按分类）
 */

const BASE = 'https://www.producthunt.com'
// Cloudflare 很挑 UA：带 “(KHTML, like Gecko)” 和 “Chrome/130.0” 的完整 UA 反而会被 challenge（403 + cf-mitigated: challenge），这个短的能过
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'

async function page(path) {
  let r
  try {
    r = await fetch(BASE + path, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) })
  } catch (e) {
    throw new BxError('NETWORK', `连不上 Product Hunt（${e?.cause?.code || e.message}）`, '检查网络或代理')
  }
  if (r.status === 404) throw new BxError('NOT_FOUND', `Product Hunt 上没有 ${path}`)
  if (r.status === 403 || r.status === 429) return viaBrowser(path, r.status)
  if (!r.ok) throw new BxError('HTTP_ERROR', `Product Hunt 返回 ${r.status}`)
  return r.text()
}

/** 被 Cloudflare 拦了：到浏览器的 producthunt.com 标签里请求（带着 cf_clearance cookie） */
async function viaBrowser(path, status) {
  const tab = await bx.tab('producthunt.com', { open: BASE + '/' })
  const [s, text] = await tab.eval(async p => {
    const r = await fetch(p)
    return [r.status, await r.text()]
  }, path)
  if (s === 404) throw new BxError('NOT_FOUND', `Product Hunt 上没有 ${path}`)
  if (s >= 400) throw new BxError('BLOCKED', `Product Hunt 拦了请求（Node ${status}，浏览器里 ${s}）`, '在浏览器里打开 producthunt.com 过一下验证再试')
  return text
}

/** 页面里所有 Apollo 查询结果（data 对象数组） */
function apollo(html) {
  const out = []
  for (const m of html.matchAll(/\(window\[Symbol\.for\("ApolloSSRDataTransport"\)\] \?\?= \[\]\)\.push\(([\s\S]*?)\)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1].replace(/:undefined([,}\]])/g, ':null$1'))
      for (const v of Object.values(j.rehydrate || {})) if (v?.data) out.push(v.data)
    } catch {}
  }
  if (!out.length) throw new BxError('CHANGED', 'Product Hunt 页面里找不到 Apollo 数据', '页面结构变了，去修 producthunt.com.js')
  return out
}
/** 同名字段在几个查询里各有一部分，合并成一个 */
function pick(ds, key) {
  const m = {}
  for (const d of ds) if (d[key] && typeof d[key] === 'object') for (const [k, v] of Object.entries(d[key])) if (m[k] == null && v != null) m[k] = v
  return Object.keys(m).length ? m : null
}

const ptTime = s => (s ? new Date(s).toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }).slice(0, 16) : undefined)
const post = p => ({
  name: p.name,
  tagline: p.tagline,
  votes: p.hideVotesCount ? undefined : p.latestScore,
  comments: p.commentsCount,
  topics: p.topics?.edges?.map(e => e.node.name).join(', ') || undefined,
  dayRank: p.dailyRank ? Number(p.dailyRank) : undefined,
  launched: ptTime(p.featuredAt || p.createdAt),
  url: `${BASE}/products/${p.product?.slug || p.slug}`,
})

/** 今天（太平洋时间）发布的产品。发布后头 4 小时票数不公开、顺序随机，这时 votes 是空的；之后按票数排
 *  @example today({ limit: 20 }) */
export async function today({ limit = 30 } = {}) {
  const ds = apollo(await page('/'))
  const hf = ds.find(d => d.homefeed)?.homefeed
  const items = (hf?.edges?.[0]?.node?.items || []).filter(x => x.__typename === 'Post')
  if (!items.length) throw new BxError('CHANGED', '首页里没有今天的产品列表', '去修 today')
  const list = items.map(post)
  if (list.some(x => x.votes != null)) list.sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1))
  return list.slice(0, limit).map((x, i) => ({ rank: i + 1, ...x }))
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y = t.getUTCFullYear()
  return [y, Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7)]
}
function ptToday(offset = 0) {
  const s = new Date(Date.now() + offset * 864e5).toLocaleDateString('sv-SE', { timeZone: 'America/Los_Angeles' })
  return new Date(s + 'T12:00:00')
}

/** 排行榜（按票数，日榜周榜前 20，月榜年榜前 10）。period：day（默认）/ week / month / year；date：那一天所在的周期（'2026-10-09'），不写是当前周期。
 *  当天的榜头 4 小时是空的，这时自动改看昨天
 *  @example hot({ limit: 10 })
 *  @example hot({ period: 'week', limit: 20 })
 *  @example hot({ period: 'month', date: '2026-09-01' }) */
export async function hot({ period = 'day', date = '', limit = 20 } = {}) {
  const P = { day: 'daily', daily: 'daily', week: 'weekly', weekly: 'weekly', month: 'monthly', monthly: 'monthly', year: 'yearly', yearly: 'yearly' }[period]
  if (!P) throw new BxError('BAD_ARGS', 'period 只能是 day / week / month / year')
  const path = d => {
    const y = d.getFullYear(), m = d.getMonth() + 1
    if (P === 'daily') return `/leaderboard/daily/${y}/${m}/${d.getDate()}`
    if (P === 'weekly') return `/leaderboard/weekly/${isoWeek(d).join('/')}`
    if (P === 'monthly') return `/leaderboard/monthly/${y}/${m}`
    return `/leaderboard/yearly/${y}`
  }
  const load = async d => {
    const text = await page(path(d))
    if (/^#\s/.test(text.trimStart())) return fromMarkdown(text)
    return (apollo(text).find(x => x.homefeedItems)?.homefeedItems?.edges || []).map(e => e.node).filter(n => n?.__typename === 'Post').map(post)
  }
  const d0 = date ? new Date(date + 'T12:00:00') : ptToday()
  if (isNaN(d0)) throw new BxError('BAD_ARGS', 'date 写成 2026-10-09 这样')
  let items = await load(d0), used = d0
  if (!items.length && !date && P === 'daily') items = await load((used = ptToday(-1)))
  if (!items.length) throw new BxError('EMPTY', `${path(used)} 是空的`, '换个日期')
  return items.slice(0, limit).map((p, i) => ({ rank: i + 1, ...p, period: path(used).replace('/leaderboard/', '') }))
}

/** 有的榜（月榜、年榜）不管 accept 都直接返回 Markdown：“1. 名字 - 一句话”下面挂着 “- Score: / - Comments: / - Product Hunt page: …” */
function fromMarkdown(md) {
  return [...md.matchAll(/^\d+\.\s+(.+)\n((?:[ \t]+- .*\n?)*)/gm)].map(([, head, body]) => {
    const f = k => body.match(new RegExp(`- ${k}:\\s*(.*)`))?.[1]?.trim()
    const [name, ...rest] = head.split(' - ')
    const names = s => s ? [...s.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]).join(', ') : undefined
    return {
      name: name.trim(),
      tagline: rest.join(' - ').trim() || undefined,
      votes: Number(f('Score')) || undefined,
      comments: Number(f('Comments')) || 0,
      topics: names(f('Launch tags')),
      website: f('External URL'),
      description: f('Description'),
      url: f('Product Hunt page'),
    }
  })
}

const dec = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** 最新发布的产品（RSS，最多 50 条）。category 按分类过滤，slug 见 browse 的说明
 *  @example posts({ limit: 20 })
 *  @example posts({ category: 'developer-tools', limit: 20 }) */
export async function posts({ category = '', limit = 30 } = {}) {
  const xml = await page('/feed' + (category ? `?category=${encodeURIComponent(category)}` : ''))
  const out = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, b]) => {
    const content = dec(b.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1])
    return {
      name: dec(b.match(/<title>([\s\S]*?)<\/title>/)?.[1]).trim(),
      tagline: content.match(/<p>\s*([\s\S]*?)\s*<\/p>/)?.[1]?.replace(/<[^>]+>/g, '').trim(),
      author: dec(b.match(/<name>([\s\S]*?)<\/name>/)?.[1]).trim(),
      launched: ptTime(b.match(/<published>(.*?)<\/published>/)?.[1]),
      url: b.match(/<link[^>]*href="([^"]+)"/)?.[1]?.replace(/\?utm_[^"]*$/, ''),
    }
  })
  if (!out.length) throw new BxError('EMPTY', 'Product Hunt RSS 是空的', category ? '分类 slug 可能写错了' : undefined)
  return out.slice(0, limit).map((x, i) => ({ rank: i + 1, ...x }))
}

const product = p => ({
  name: p.name,
  tagline: p.tagline,
  rating: p.reviewsRating || undefined,
  reviews: p.reviewsCount ?? p.detailedReviewsCount,
  launches: p.postsCount,
  categories: p.categories?.map(c => c.name).join(', ') || undefined,
  lastLaunch: p.latestLaunch?.scheduledAt?.slice(0, 10),
  url: `${BASE}/products/${p.slug}`,
})

/** 某个分类里评价最好的产品（按评论数和评分，前 15）。常用分类：ai-agents ai-coding-agents ai-code-editors ai-chatbots
 *  ai-workflow-automation vibe-coding llms productivity no-code-platforms finance design-creative marketing-sales（网址 /categories/<slug>）
 *  @example browse('ai-agents')
 *  @example browse('vibe-coding', { limit: 10 }) */
export async function browse(category, { limit = 15 } = {}) {
  const slug = String(category).trim().toLowerCase().replace(/^.*\/categories\//, '')
  const ds = apollo(await page(`/categories/${encodeURIComponent(slug)}`))
  const c = pick(ds, 'productCategory')
  const list = c?.products?.edges?.map(e => e.node) || []
  if (!list.length) throw new BxError('EMPTY', `分类 ${slug} 下没有产品`, '分类 slug 看 producthunt.com/categories')
  return list.slice(0, limit).map((p, i) => ({ rank: i + 1, ...product(p), category: c.name }))
}

/** 搜产品（按名字，返回评分和评论数）
 *  @example search('notion')
 *  @example search('screen recorder', { limit: 10 }) */
export async function search(q, { limit = 20 } = {}) {
  const ds = apollo(await page(`/search?q=${encodeURIComponent(q)}`))
  const list = ds.find(d => d.productSearch)?.productSearch?.edges?.map(e => e.node) || []
  if (!list.length) throw new BxError('EMPTY', `Product Hunt 没搜到 ${q}`)
  return list.slice(0, limit).map((p, i) => ({ rank: i + 1, ...product(p) }))
}

/** 产品详情：介绍、官网、评分、关注数、发布次数、分类、评论摘要
 *  @example detail('notion')
 *  @example detail('https://www.producthunt.com/products/cursor') */
export async function detail(slug) {
  const s = String(slug).trim().replace(/^.*\/products\//, '').replace(/[/?#].*$/, '')
  const html = await page(`/products/${encodeURIComponent(s)}`)
  const p = pick(apollo(html), 'product')
  if (!p?.name) throw new BxError('CHANGED', '产品页里没有 product 数据', '去修 detail')
  const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(m => { try { return JSON.parse(m[1]) } catch { return null } }).find(x => x?.aggregateRating)
  return {
    ...product(p),
    description: p.description,
    website: p.websiteUrl,
    followers: p.followersCount,
    makers: ld?.author?.map(a => a.name).join(', ') || undefined,
    firstLaunch: (p.firstLaunch?.scheduledAt || p.firstPost?.scheduledAt || ld?.datePublished)?.slice(0, 10),
    github: p.githubUrl || undefined,
    twitter: p.twitterUrl || undefined,
    reviewSummary: p.aiDetailedReviewSummary?.summary || (typeof p.aiDetailedReviewSummary === 'string' ? p.aiDetailedReviewSummary : undefined),
  }
}
