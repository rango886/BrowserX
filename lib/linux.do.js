/* 站点笔记（linux.do，Discourse 论坛）：
 * @login required 大部分板块要登录才看得到，没登录时接口返回 403 或者只给公开板块
 * - Discourse 标准接口：每个页面加 .json 就是数据。/search.json?q=、/latest.json、/hot.json、/top.json?period=daily、/t/<id>.json
 * - /t/<id>.json?include_raw=true 带 raw（原始 Markdown），比 cooked（HTML）好读；帖子超过 20 楼时，post_stream.stream 是全部楼层 id，
 *   剩下的用 /t/<id>/posts.json?post_ids[]=… 分批取（每批 ≤ 20）
 * - 搜索语法：关键词后面可以加 order:latest、in:title、@用户名、#分类、tags:xxx、after:2025-01-01
 * - 有 Cloudflare：Node 直连会被拦；页面里的 fetch 不带 X-Requested-With 也会被拦（403 + “Just a moment”），所以统一在标签里带 XHR 头请求
 */

const BASE = 'https://linux.do'
const tabOf = () => bx.tab('linux.do', { open: BASE + '/' })
const time = s => (s ? new Date(s).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined)
const strip = h => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()

const XHR = { 'X-Requested-With': 'XMLHttpRequest', 'Discourse-Present': 'true', Accept: 'application/json, text/javascript, */*; q=0.01' }

async function get(path) {
  const tab = await tabOf()
  return tab.fetch(BASE + path, { headers: XHR })
}

const topicOf = t => ({
  id: t.id,
  title: t.fancy_title || t.title,
  replies: Math.max(0, (t.posts_count || 1) - 1),
  views: t.views,
  likes: t.like_count,
  tags: (t.tags || []).map(x => (typeof x === 'string' ? x : x.name)).join(',') || undefined,
  time: time(t.created_at),
  lastReply: time(t.last_posted_at || t.bumped_at),
  url: `${BASE}/t/topic/${t.id}`,
})

/** 搜索话题。q 里可以带 Discourse 搜索语法，比如 'claude order:latest'、'docker after:2025-01-01'
 *  @example search('claude code', { limit: 20 }) */
export async function search(q, { limit = 20, page = 1 } = {}) {
  const j = await get(`/search.json?q=${encodeURIComponent(q)}&page=${page}`)
  const topics = j.topics || []
  if (!topics.length) {
    const me = await get('/session/current.json').catch(() => null)
    if (!me?.current_user) throw new BxError('NEED_LOGIN', 'linux.do 没有登录，搜不到内容', '在浏览器里登录 linux.do 后重试')
    throw new BxError('EMPTY', `没有搜到 ${q}`, '换个关键词')
  }
  const blurb = new Map((j.posts || []).filter(p => p.post_number === 1 || !p.topic_id).map(p => [p.topic_id, p.blurb]))
  return topics.slice(0, limit).map(t => ({ ...topicOf(t), snippet: blurb.get(t.id) }))
}

/** 话题列表。view：latest 最新 / hot 热门 / top 排行（period：daily weekly monthly quarterly yearly all）
 *  @example feed({ view: 'top', period: 'daily', limit: 20 }) */
export async function feed({ view = 'latest', period = 'weekly', limit = 30 } = {}) {
  const path = view === 'top' ? `/top.json?period=${period}` : `/${view}.json`
  const j = await get(path)
  const topics = j.topic_list?.topics
  if (!Array.isArray(topics)) throw new BxError('CHANGED', 'linux.do 列表接口返回结构变了', '去修 feed')
  return topics.slice(0, limit).map(topicOf)
}

/** 话题正文 + 回复（按楼层）。id 是数字或帖子链接
 *  @example topic('https://linux.do/t/topic/1000000', { limit: 50 }) */
export async function topic(id, { limit = 100 } = {}) {
  id = String(id).match(/\/t\/(?:[^/]+\/)?(\d+)/)?.[1] || String(id).match(/^\d+$/)?.[0]
  if (!id) throw new BxError('BAD_ARGS', '要话题 id 或 /t/<slug>/<id> 链接')
  const j = await get(`/t/${id}.json?include_raw=true`)
  let posts = j.post_stream?.posts || []
  const stream = j.post_stream?.stream || []
  const want = stream.slice(0, limit).filter(pid => !posts.some(p => p.id === pid))
  for (let i = 0; i < want.length; i += 20) {
    const q = want.slice(i, i + 20).map(p => `post_ids[]=${p}`).join('&')
    const more = await get(`/t/${id}/posts.json?${q}&include_raw=true`)
    posts = posts.concat(more.post_stream?.posts || [])
  }
  posts.sort((a, b) => a.post_number - b.post_number)
  const main = posts.find(p => p.post_number === 1)
  return {
    id: j.id,
    title: j.title,
    author: main?.username,
    time: time(j.created_at),
    views: j.views,
    likes: j.like_count,
    replies: Math.max(0, (j.posts_count || 1) - 1),
    tags: (j.tags || []).map(x => (typeof x === 'string' ? x : x.name)).join(',') || undefined,
    url: `${BASE}/t/topic/${j.id}`,
    content: main ? main.raw || strip(main.cooked) : '',
    replyList: posts
      .filter(p => p.post_number > 1)
      .slice(0, limit)
      .map(p => ({ floor: p.post_number, author: p.username, likes: p.like_count, replyTo: p.reply_to_post_number || undefined, text: p.raw || strip(p.cooked), time: time(p.created_at) })),
  }
}

/** 某个用户发的话题
 *  @example userTopics('neo', { limit: 20 }) */
export async function userTopics(username, { limit = 30 } = {}) {
  const j = await get(`/topics/created-by/${encodeURIComponent(username)}.json`)
  return (j.topic_list?.topics || []).slice(0, limit).map(topicOf)
}

/** 当前登录的账号
 *  @example me() */
export async function me() {
  const j = await get('/session/current.json').catch(() => null)
  const u = j?.current_user
  if (!u) throw new BxError('NEED_LOGIN', 'linux.do 没有登录', '在浏览器里登录 linux.do 后重试')
  return { username: u.username, name: u.name, trustLevel: u.trust_level }
}

/** 话题页的读法：正文 + 回复 */
export async function read(tab, { limit = 100 } = {}) {
  const url = await tab.url()
  if (!/\/t\/(?:[^/]+\/)?\d+/.test(url)) return null
  const t = await topic(url, { limit })
  return {
    title: t.title,
    meta: { author: t.author, published: t.time, site: 'linux.do', tags: t.tags },
    content: [t.content, '', `## 回复（${t.replies}）`, ...t.replyList.map(r => `- #${r.floor} **${r.author}**${r.likes ? `（👍${r.likes}）` : ''}：${r.text.replace(/\n+/g, ' ').slice(0, 1000)}`)].join('\n'),
  }
}
