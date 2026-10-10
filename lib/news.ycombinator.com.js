/* 站点笔记（Hacker News）：
 * - 用 Algolia 的公开接口，不需要浏览器，直接用 Node 的 fetch
 *   搜索：hn.algolia.com/api/v1/search（按相关度）、search_by_date（按时间）；numericFilters=created_at_i>时间戳
 *   帖子 + 全部评论：hn.algolia.com/api/v1/items/<id>（children 是嵌套的评论树）
 * - 评论正文是 HTML，这里去掉标签、还原常见实体
 */

const ALGOLIA = 'https://hn.algolia.com/api/v1'
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
  const item = await getJson(`${ALGOLIA}/items/${id}`)
  const out = []
  const walk = (n, depth) => {
    for (const c of n.children || []) {
      if (out.length >= limit) return
      if (c.text) out.push({ author: c.author, text: plain(c.text), depth, time: c.created_at?.slice(0, 16).replace('T', ' ') })
      walk(c, depth + 1)
    }
  }
  walk(item, 0)
  return out
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
