/* 站点笔记（V2EX）：
 * @login none 公开接口就够；me() 要登录
 * - 公开 JSON 接口（v1）：/api/topics/hot.json、/api/topics/show.json?id= | node_name= | username=、/api/replies/show.json?topic_id=、/api/members/show.json?username=
 * - 搜索站内没有接口，用第三方 sov2ex：https://www.sov2ex.com/api/search?q=&from=&size=&sort=sumup|created
 * - Node 直连偶尔会被 Cloudflare 拦（返回 HTML），这时自动改在 v2ex.com 标签里请求
 * - created 是秒级时间戳
 */

const time = s => (s ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') : undefined)

async function api(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
    if (r.ok && /json/.test(r.headers.get('content-type') || '')) return await r.json()
  } catch {}
  const tab = await bx.tab('v2ex.com', { open: 'https://www.v2ex.com/' })
  return tab.fetch(url)
}

const topicOf = t => ({
  id: t.id,
  title: t.title,
  node: t.node?.title,
  author: t.member?.username,
  replies: t.replies,
  time: time(t.created),
  url: t.url || `https://www.v2ex.com/t/${t.id}`,
})

/** 搜帖子（sov2ex）。sort：sumup 相关度 / created 最新
 *  @example search('sqlite', { limit: 20 }) */
export async function search(q, { limit = 20, sort = 'sumup' } = {}) {
  const r = await fetch(`https://www.sov2ex.com/api/search?q=${encodeURIComponent(q)}&size=${Math.min(limit, 50)}&sort=${sort}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!r.ok) throw new BxError('HTTP_ERROR', `sov2ex ${r.status}`, '换 google.com search "site:v2ex.com 关键词"')
  const j = await r.json()
  const hits = j.hits || []
  if (!hits.length) throw new BxError('EMPTY', `没有搜到 ${q}`, '换个关键词')
  return hits.slice(0, limit).map(h => ({
    id: h._source.id,
    title: h._source.title,
    node: h._source.node,
    author: h._source.member,
    replies: h._source.replies,
    time: h._source.created?.slice(0, 16).replace('T', ' '),
    snippet: (h.highlight?.content || h.highlight?.postscript_list || [h._source.content || ''])[0]?.replace(/<\/?em>/g, '').slice(0, 200),
    url: `https://www.v2ex.com/t/${h._source.id}`,
  }))
}

/** 热门话题
 *  @example hot({ limit: 10 }) */
export async function hot({ limit = 20 } = {}) {
  return (await api('https://www.v2ex.com/api/topics/hot.json')).slice(0, limit).map(topicOf)
}

/** 节点里的最新话题（name 如 python、programmer、apple；接口最多 20 条）
 *  @example node('programmer', { limit: 10 }) */
export async function node(name, { limit = 20 } = {}) {
  return (await api(`https://www.v2ex.com/api/topics/show.json?node_name=${encodeURIComponent(name)}`)).slice(0, limit).map(topicOf)
}

/** 主题正文 + 回复。id 是数字或帖子链接
 *  @example topic('https://www.v2ex.com/t/1000000', { limit: 50 }) */
export async function topic(id, { limit = 100 } = {}) {
  id = String(id).match(/(\d+)/)?.[1]
  if (!id) throw new BxError('BAD_ARGS', '要帖子 id 或 /t/<id> 链接')
  const [t] = await api(`https://www.v2ex.com/api/topics/show.json?id=${id}`)
  if (!t) throw new BxError('NOT_FOUND', `帖子 ${id} 不存在`)
  const replies = await api(`https://www.v2ex.com/api/replies/show.json?topic_id=${id}`)
  return {
    ...topicOf(t),
    content: t.content,
    replyList: replies.slice(0, limit).map((r, i) => ({ floor: i + 1, author: r.member?.username, text: r.content, time: time(r.created) })),
  }
}

/** 用户资料 + 最近发的帖子
 *  @example user('livid') */
export async function user(username, { limit = 20 } = {}) {
  const m = await api(`https://www.v2ex.com/api/members/show.json?username=${encodeURIComponent(username)}`)
  if (!m || m.status === 'notfound') throw new BxError('NOT_FOUND', `没有用户 ${username}`)
  const topics = await api(`https://www.v2ex.com/api/topics/show.json?username=${encodeURIComponent(username)}`).catch(() => [])
  return { username: m.username, tagline: m.tagline, bio: m.bio, website: m.website, github: m.github, location: m.location, created: time(m.created), url: m.url, topics: topics.slice(0, limit).map(topicOf) }
}

/** 当前登录的账号（余额、未读提醒）
 *  @login required */
export async function me() {
  const tab = await bx.tab('v2ex.com', { open: 'https://www.v2ex.com/' })
  const r = await tab.eval(() => {
    const link = document.querySelector('#Top a[href^="/member/"]')
    if (!link) return null
    const bal = document.querySelector('a.balance_area')
    const unread = document.querySelector('a[href="/notifications"]')?.textContent.match(/(\d+)\s*未读提醒/)?.[1]
    return { username: link.getAttribute('href').replace('/member/', ''), balance: bal ? [...bal.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim() : undefined, unread: Number(unread || 0) }
  })
  if (!r) throw new BxError('NEED_LOGIN', 'V2EX 没有登录', '在浏览器里打开 v2ex.com 登录后重试')
  return r
}

/** 帖子页的读法：正文 + 回复 */
export async function read(tab, { limit = 100 } = {}) {
  const url = await tab.url()
  if (!/\/t\/\d+/.test(url)) return null
  const t = await topic(url, { limit })
  return {
    title: t.title,
    meta: { author: t.author, published: t.time, site: 'V2EX', node: t.node },
    content: [t.content, '', `## 回复（${t.replies}）`, ...t.replyList.map(r => `- #${r.floor} **${r.author}**：${r.text.replace(/\n+/g, ' ')}`)].join('\n'),
  }
}
