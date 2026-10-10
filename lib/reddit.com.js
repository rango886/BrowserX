/* 站点笔记（Reddit）：
 * - 每个页面加 .json 就是数据：/search.json、/r/<sub>/search.json?restrict_sr=1、<帖子地址>.json
 * - 在已打开的 www.reddit.com 标签里请求（tab.fetch 带登录状态）；不登录也能用，但更容易被限流（429）
 * - 帖子 .json 返回 [帖子, 评论树]；评论树里 kind=t1 是评论，kind=more 是“加载更多”（这里不展开）
 * - 时间是秒级时间戳 created_utc
 */

const tabOf = () => bx.tab('reddit.com', { open: 'https://www.reddit.com/' })
const iso = s => (s ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') : undefined)

/** 搜索帖子。time：hour day week month year all；sort：relevance hot top new comments；sub 限定在某个版块
 *  @example search('sqlite production', { time: 'year', limit: 50 }) */
export async function search(q, { time = 'year', sort = 'relevance', limit = 25, sub = '' } = {}) {
  const tab = await tabOf()
  const out = []
  let after = ''
  while (out.length < limit) {
    const base = sub ? `https://www.reddit.com/r/${sub}/search.json?restrict_sr=1&` : 'https://www.reddit.com/search.json?'
    const j = await tab.fetch(`${base}q=${encodeURIComponent(q)}&t=${time}&sort=${sort}&type=link&limit=${Math.min(100, limit - out.length)}${after ? `&after=${after}` : ''}`)
    const list = j?.data?.children
    if (!Array.isArray(list)) throw new BxError('CHANGED', 'Reddit 搜索接口返回的结构变了', '去修 reddit.com.js 的 search')
    for (const { data: p } of list)
      out.push({ site: 'reddit', id: p.id, title: p.title, url: `https://www.reddit.com${p.permalink}`, sub: p.subreddit, author: p.author, score: p.score, comments: p.num_comments, time: iso(p.created_utc) })
    after = j.data.after
    if (!after || !list.length) break
    await bx.sleep(500)
  }
  return out.slice(0, limit)
}

/** 帖子的评论，拍平成列表（depth 是楼层深度）。sort：top best new controversial
 *  @example comments('https://www.reddit.com/r/sqlite/comments/abc123/xxx/', { limit: 80 }) */
export async function comments(url, { limit = 100, sort = 'top' } = {}) {
  const tab = await tabOf()
  const u = new URL(String(url).startsWith('http') ? url : `https://www.reddit.com${url}`)
  u.pathname = u.pathname.replace(/\/?$/, '.json')
  u.search = `?limit=500&sort=${sort}&raw_json=1`
  const j = await tab.fetch(u.href)
  if (!Array.isArray(j) || !j[1]?.data) throw new BxError('NOT_FOUND', `不是帖子地址：${url}`, '需要 https://www.reddit.com/r/<版块>/comments/<id>/... 这种地址')
  const out = []
  const walk = (children, depth) => {
    for (const c of children || []) {
      if (out.length >= limit) return
      if (c.kind !== 't1') continue
      const d = c.data
      out.push({ author: d.author, text: d.body, score: d.score, depth, time: iso(d.created_utc) })
      if (d.replies?.data) walk(d.replies.data.children, depth + 1)
    }
  }
  walk(j[1].data.children, 0)
  return out
}
