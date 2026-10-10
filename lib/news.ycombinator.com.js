/* 站点笔记（Hacker News）：
 * - 用 Algolia 的公开接口，不需要浏览器，直接用 Node 的 fetch
 *   搜索：hn.algolia.com/api/v1/search（按相关度）、search_by_date（按时间）；numericFilters=created_at_i>时间戳
 *   帖子 + 全部评论：hn.algolia.com/api/v1/items/<id>（children 是嵌套的评论树）
 * - 坑：Algolia 的 children 按 id（时间）排，不是 HN 页面上的排名顺序。HN 帖子页 HTML 有正确顺序，但 Node 的 fetch 会被拦（419，curl 能过），
 *   所以用 Firebase：帖子的 kids 就是顶层评论的排名顺序，再取前 60 条顶层评论的 kids 排第二层；更深的保持时间顺序
 * - 榜单 / 用户用官方 Firebase 接口：hacker-news.firebaseio.com/v0/{top,new,best,ask,show,job}stories.json（只给 id，再逐个取 item/<id>.json）、user/<id>.json
 * - 评论正文是 HTML，这里去掉标签、还原常见实体
 */

const ALGOLIA = 'https://hn.algolia.com/api/v1'
const FB = 'https://hacker-news.firebaseio.com/v0'
const plain = (html = '') =>
  html
    .replace(/<p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&')
    .trim()

async function getJson(url) {
  const r = await fetch(url)
  if (r.status === 429) throw new BxError('BLOCKED', 'HN 接口请求太频繁', '停一会儿再试')
  if (r.status === 404) throw new BxError('NOT_FOUND', `没有这个帖子：${url}`)
  if (!r.ok) throw new BxError('HTTP_ERROR', `${r.status} ${url}`)
  return r.json()
}

/** 搜索帖子（最近 days 天）。sort：relevance 相关度 / date 最新
 *  @example search('sqlite production', { days: 365 }) */
export async function search(q, { days = 365, limit = 50, sort = 'relevance' } = {}) {
  const since = Math.floor(Date.now() / 1000) - days * 86400
  const api = sort === 'date' ? 'search_by_date' : 'search'
  const j = await getJson(`${ALGOLIA}/${api}?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=${Math.min(limit, 1000)}`)
  return j.hits.map(h => ({
    site: 'hn',
    id: h.objectID,
    title: h.title,
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    link: h.url || undefined,
    points: h.points,
    comments: h.num_comments,
    time: h.created_at?.slice(0, 16).replace('T', ' '),
  }))
}

/** 帖子的全部评论，拍平成列表（depth 是楼层深度）
 *  @example comments('https://news.ycombinator.com/item?id=12345', { limit: 100 }) */
export async function comments(url, { limit = 200 } = {}) {
  const id = String(url).match(/id=(\d+)/)?.[1] || String(url).match(/^\d+$/)?.[0]
  if (!id) throw new BxError('BAD_ARGS', `认不出帖子：${url}`, '需要 https://news.ycombinator.com/item?id=<数字> 或帖子 id')
  const [item, order] = await Promise.all([getJson(`${ALGOLIA}/items/${id}`), rankOrder(id)])
  // 按 HN 的排名顺序重排 children（Firebase 里没有的放到后面，保持原顺序）
  const sortKids = n => {
    if (!n.children?.length) return
    const kids = order.get(String(n.id))
    if (kids) {
      const rank = new Map(kids.map((x, i) => [x, i]))
      n.children.sort((a, b) => (rank.get(String(a.id)) ?? 1e9) - (rank.get(String(b.id)) ?? 1e9))
    }
    n.children.forEach(sortKids)
  }
  sortKids(item)
  const out = []
  const walk = (n, depth) => {
    for (const c of n.children || []) {
      if (out.length >= limit) return
      if (c.text) out.push({ author: c.author, text: plain(c.text), depth, time: c.created_at?.slice(0, 16).replace('T', ' '), id: c.id })
      walk(c, depth + 1)
    }
  }
  walk(item, 0)
  return out
}

/** 评论的排名顺序：Firebase 里帖子的 kids 是顶层评论的顺序，再取前 60 条顶层评论自己的 kids（第二层）。
 *  返回 Map<父 id, [子 id…]>；更深的楼层保持 Algolia 的时间顺序 */
async function rankOrder(id) {
  const order = new Map()
  try {
    const story = await getJson(`${FB}/item/${id}.json`)
    const top = story?.kids || []
    order.set(String(id), top.map(String))
    const many = top.slice(0, 60)
    for (let i = 0; i < many.length; i += 20) {
      const items = await Promise.all(many.slice(i, i + 20).map(k => getJson(`${FB}/item/${k}.json`).catch(() => null)))
      for (const it of items) if (it?.kids?.length > 1) order.set(String(it.id), it.kids.map(String))
    }
  } catch {}
  return order
}
const LISTS = { top: 'topstories', new: 'newstories', best: 'beststories', ask: 'askstories', show: 'showstories', job: 'jobstories', jobs: 'jobstories' }

/** 首页榜单。list：top 首页 new 最新 best 最佳 ask（Ask HN）show（Show HN）job 招聘
 *  @example stories({ list: 'top', limit: 30 })
 *  @example stories({ list: 'show', limit: 20 }) */
export async function stories({ list = 'top', limit = 30 } = {}) {
  const name = LISTS[list]
  if (!name) throw new BxError('BAD_ARGS', `list 只能是 ${Object.keys(LISTS).join(' / ')}`)
  const ids = (await getJson(`${FB}/${name}.json`)).slice(0, limit)
  const items = []
  for (let i = 0; i < ids.length; i += 10) items.push(...(await Promise.all(ids.slice(i, i + 10).map(x => getJson(`${FB}/item/${x}.json`).catch(() => null)))))
  return items.filter(Boolean).map((h, i) => ({
    site: 'hn',
    rank: i + 1,
    id: String(h.id),
    title: h.title,
    url: `https://news.ycombinator.com/item?id=${h.id}`,
    link: h.url || undefined,
    points: h.score,
    comments: h.descendants,
    author: h.by,
    time: h.time ? new Date(h.time * 1000).toISOString().slice(0, 16).replace('T', ' ') : undefined,
  }))
}

/** 用户资料（karma、注册时间、简介）
 *  @example user('pg') */
export async function user(id) {
  const u = await getJson(`${FB}/user/${encodeURIComponent(id)}.json`)
  if (!u) throw new BxError('NOT_FOUND', `HN 没有用户 ${id}`)
  return { id: u.id, karma: u.karma, created: new Date(u.created * 1000).toISOString().slice(0, 10), about: u.about ? plain(u.about) : undefined, submissions: u.submitted?.length, url: `https://news.ycombinator.com/user?id=${u.id}` }
}

/** 帖子页的读法：标题、链接、正文和评论（按楼层缩进） */
export async function read(tab, { limit = 80 } = {}) {
  const id = (await tab.url()).match(/item\?id=(\d+)/)?.[1]
  if (!id) return null
  const item = await getJson(`${ALGOLIA}/items/${id}`)
  const list = await comments(id, { limit })
  return {
    title: item.title,
    type: 'discussion',
    meta: { author: item.author, published: item.created_at?.slice(0, 10), site: 'Hacker News' },
    link: item.url || undefined,
    content: [item.text ? plain(item.text) + '\n' : '', ...list.map(c => `${'  '.repeat(c.depth)}- **${c.author}**：${c.text.replace(/\n+/g, ' ')}`)].join('\n'),
  }
}
