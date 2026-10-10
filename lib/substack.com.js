/* 站点笔记（Substack，Newsletter 平台）：都不用登录，Node 直接 fetch 公开接口
 * - 搜索文章 substack.com/api/v1/post/search?query=&page=0&includePlatformResults=true → { results, more }，每条带 canonical_url、
 *   post_date、description、truncated_body_text、reaction_count、comment_count、publishedBylines
 * - 搜索 Newsletter substack.com/api/v1/profile/search?query= → { results }，primaryPublication 是刊物
 * - 分类热榜 substack.com/api/v1/search/explore/web?tab=<分类>&type=category&sort=top|recent&cursor=（翻页用返回的 nextCursor）
 *   → { items }，里面混着 type=post（文章）和 type=comment（其实多是 “Notes” 短帖）；开头的 type=categoryLeaderboard
 *   是这个分类的头部刊物（profiles，带订阅排名）
 * - 某个 Newsletter 的文章列表 <base>/api/v1/archive?sort=new|top&offset=0&limit=（base 是 custom_domain 或 <子域>.substack.com；\n *   裸域经常没配 DNS，连不上换 www. 再试）
 * - 单篇文章 <base>/api/v1/posts/<slug> → 正文 body_html（付费文章只有免费预览，audience 字段能看出来）
 *   /api/v1/publication（刊物信息）不少刊会 403，不用它
 * - 分类 id：GET substack.com/api/v1/categories；substack.com/browse/<分类> 页面是客户端渲染的，抓 HTML 没用
 */
const BASE = 'https://substack.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

async function get(url) {
  let r
  try {
    r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) })
  } catch (e) {
    throw new BxError('NETWORK', `连不上 Substack（${e?.cause?.code || e.message}）`, '检查网络或代理')
  }
  if (r.status === 404) throw new BxError('NOT_FOUND', `Substack 上没有：${url.replace(BASE, '')}`)
  if (r.status === 403 || r.status === 429) throw new BxError('BLOCKED', `Substack 拦了请求（${r.status}）`, '停一会儿再试')
  if (!r.ok) throw new BxError('HTTP_ERROR', `Substack 返回 ${r.status}`)
  return r.json()
}

const trim = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const pubBase = p => (p?.custom_domain ? `https://${p.custom_domain}` : p?.subdomain ? `https://${p.subdomain}.substack.com` : '')
const time = s => (s ? new Date(s).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined)

const post = (p, pub) => ({
  title: trim(p.title),
  author: trim(p.publishedBylines?.[0]?.name) || pub?.name || undefined,
  pub: pub?.name || undefined,
  date: p.post_date?.slice(0, 10),
  reactions: p.reaction_count || p.reactions || undefined,
  comments: p.comment_count || undefined,
  audience: p.audience !== 'everyone' ? p.audience : undefined,
  summary: trim(p.description || p.subtitle || p.truncated_body_text).slice(0, 200) || undefined,
  url: p.canonical_url || pubBase(pub) && `${pubBase(pub)}/p/${p.slug}`,
})

const CATEGORIES = ['technology', 'business', 'culture', 'us-politics', 'world-politics', 'finance', 'news', 'science', 'health', 'health-politics', 'climate', 'education', 'food', 'podcast', 'sports', 'art', 'music', 'film-and-tv', 'literature', 'fiction', 'history', 'philosophy', 'design', 'travel', 'parenting', 'faith', 'comics', 'crypto', 'humor', 'fashionandbeauty', 'home-garden', 'games', 'international']

/** Substack 的热榜（分类推荐流，top 是最火的、new 是最新）。category：technology（默认）business culture finance news science health
 *  politics 等，见 substack.com/browse；want：posts 只要文章（默认）/ all 连 Notes 短帖也要
 *  @example feed({ limit: 20 })
 *  @example feed({ category: 'finance', sort: 'new', limit: 20 }) */
export async function feed({ category = 'technology', sort = 'top', limit = 25, want = 'posts' } = {}) {
  const tab = String(category).trim().toLowerCase().replace(/[^a-z-]/g, '') || 'technology'
  const out = []
  let cursor = ''
  for (let i = 0; out.length < limit && i < 6; i++) {
    const j = await get(`${BASE}/api/v1/search/explore/web?tab=${tab}&type=category&sort=${sort === 'new' ? 'recent' : 'top'}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    for (const it of j.items || []) {
      if (want === 'posts' && it.type !== 'post') continue
      if (it.type === 'post' && it.post) out.push(post(it.post, it.publication))
      else if (it.type === 'comment' && it.comment) out.push({ kind: 'note', author: it.context?.users?.[0]?.name, date: it.comment.date?.slice(0, 10) || it.context?.timestamp?.slice(0, 10), text: trim(it.comment.body).slice(0, 200), url: it.comment.url })
    }
    if (!j.nextCursor) break
    cursor = j.nextCursor
  }
  if (!out.length) throw new BxError('EMPTY', `分类 ${category} 没有内容`, `分类写错了吧，常见的：${CATEGORIES.slice(0, 10).join(' ')}`)
  return out.slice(0, limit).map((x, i) => ({ rank: i + 1, ...x }))
}

/** 搜 Substack：文章（type: posts，默认）或 Newsletter（type: publications，返回刊物名、作者、简介、订阅规模排名）
 *  @example search('AI agents', { limit: 15 })
 *  @example search('econ', { type: 'publications', limit: 10 }) */
export async function search(q, { type = 'posts', limit = 20 } = {}) {
  const query = String(q || '').trim()
  if (!query) throw new BxError('BAD_ARGS', '要给搜索关键词')
  let out = []
  if (type === 'publications') {
    const j = await get(`${BASE}/api/v1/profile/search?query=${encodeURIComponent(query)}&page=0`)
    out = (j.results || []).map(x => {
      const p = x.primaryPublication || x.publicationUsers?.[0]?.publication || {}
      const pub = x.primary_publication
      return {
        name: p.name || pub?.name || x.name,
        author: x.name,
        authorHandle: x.handle,
        ranking: x.status?.leaderboard ? `#${x.status.leaderboard.rank} ${x.status.leaderboard.label}` : undefined,
        description: trim(p.hero_text || x.bio).slice(0, 200) || undefined,
        url: pubBase(p) || pubBase(pub) || (x.handle ? `${BASE}/@${x.handle}` : undefined),
      }
    }).filter(x => x.name)
  } else {
    const j = await get(`${BASE}/api/v1/post/search?query=${encodeURIComponent(query)}&page=0&includePlatformResults=true`)
    out = (j.results || []).map(p => post(p, { name: p.publication?.name }))
  }
  if (!out.length) throw new BxError('EMPTY', `Substack 没搜到 ${q}`)
  return out.slice(0, limit).map((x, i) => ({ rank: i + 1, ...x }))
}

/** 把 Newsletter 的各种写法换成 base 网址：'oneusefulthing.org' / 'https://xxx.substack.com/p/yyy' / 'noahpinion' 都行。
 *  有的刊的裸域能用，有的只认 www（DNS 没配裸域），所以把两个候选都返回 */
function baseOf(s) {
  const m = String(s).trim().match(/^(?:https?:\/\/)?([\w-]+)\.substack\.com/i)
  if (m) return [`https://${m[1]}.substack.com`]
  const h = String(s).trim().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
  if (!/[a-z]/i.test(h)) throw new BxError('BAD_ARGS', `看不懂这个 Newsletter 地址：${s}`)
  const dom = /\./.test(h) ? h : null
  if (!dom && !/^[\w-]+$/.test(h)) throw new BxError('BAD_ARGS', `看不懂这个 Newsletter 地址：${s}`)
  return dom ? [`https://${dom}`, `https://www.${dom}`] : [`https://${h}.substack.com`]
}

/** 依次试几个 base，哪个能连上用哪个 */
async function pubGet(bases, path) {
  let err
  for (const b of bases) {
    try { return await get(b + path) } catch (e) { err = e; if (e.code !== 'NETWORK') throw e }
  }
  throw new BxError('NOT_FOUND', `连不上这个 Newsletter（${err?.message}）`, '检查名字有没有写对')
}

/** 某个 Newsletter 的最新文章。sort：new 最新（默认）/ top 最受欢迎。输入例子：'oneusefulthing.org'、
 *  'noahpinion'（会试 noahpinion.substack.com）、完整文章网址也行
 *  @example publication('oneusefulthing.org', { limit: 10 })
 *  @example publication('noahpinion', { sort: 'top', limit: 10 }) */
export async function publication(name, { sort = 'new', limit = 20 } = {}) {
  const base = baseOf(name)
  const list = await pubGet(base, `/api/v1/archive?sort=${sort === 'top' ? 'top' : 'new'}&offset=0&limit=${Math.min(Math.max(limit, 1), 50)}`)
  if (!Array.isArray(list) || !list.length) throw new BxError('EMPTY', `${base[0]} 没有文章`)
  const pub = { name: list[0].publishedBylines?.[0]?.name, custom_domain: base[0].replace('https://', '') }
  return list.slice(0, limit).map((p, i) => ({ rank: i + 1, ...post(p, pub) }))
}

const html2text = html => html
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<h(\d)[^>]*>/gi, (m, n) => `\n${'#'.repeat(+n > 4 ? 4 : +n)} `)
  .replace(/<li[^>]*>/gi, '\n- ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|blockquote|tr|h\d)>/gi, '\n')
  .replace(/<blockquote[^>]*>/gi, '\n> ')
  .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2（$1）')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')

/** 文章正文（按网址取，付费文章只有免费预览的部分，会标出来）
 *  @example article('https://www.oneusefulthing.org/p/the-dot-and-the-swarm') */
export async function article(url) {
  const m = String(url).trim().match(/^https?:\/\/([\w.-]+?)\/p\/([\w-]+)/)
  if (!m) throw new BxError('BAD_ARGS', '要给 Substack 文章网址（…/p/…）', '搜索用 search，Newsletter 列表用 publication')
  const [, host, slug] = m
  const p = await pubGet(baseOf(`https://${host}`), `/api/v1/posts/${slug}`)
  const body = html2text(p.body_html || '')
  return {
    title: trim(p.title),
    subtitle: trim(p.subtitle) || undefined,
    author: trim(p.publishedBylines?.[0]?.name) || undefined,
    published: p.post_date?.slice(0, 10),
    audience: p.audience !== 'everyone' ? p.audience : undefined,
    paywalled: p.has_dynamic_content || p.audience !== 'everyone' || undefined,
    words: p.wordcount,
    reactions: p.reaction_count,
    comments: p.comment_count,
    tags: p.postTags?.map(t => t.name || t).join(', ') || undefined,
    url: p.canonical_url || String(url),
    content: body || trim(p.truncated_body_text) || undefined,
  }
}

/** Substack 文章页的读法 */
export async function read(tab) {
  const u = await tab.url()
  if (!/\/p\/[\w-]+/.test(u)) return null
  const a = await article(u).catch(() => null)
  if (!a?.content) return null
  return { title: a.title, type: 'article', meta: { author: a.author, published: a.published, site: `Substack · ${a.audience || ''}` }, content: [a.subtitle, a.content].filter(Boolean).join('\n\n') }
}
