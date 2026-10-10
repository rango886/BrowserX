/* 站点笔记（X / Twitter）：
 * @login required 没登录时搜索、推文详情都看不到
 * - GraphQL 接口（/i/api/graphql/<queryId>/<操作名>）要 bearer + ct0 + x-client-transaction-id，queryId 还常变，自己拼很脆弱。
 *   做法是打开页面，用 tab.collect 接住页面自己发的请求（按操作名匹配，不管 queryId）：
 *     搜索 /SearchTimeline（x.com/search?q=&f=live|top），滚动翻页
 *     推文 + 回复 /TweetDetail（x.com/<user>/status/<id>），滚动加载更多回复
 *     用户 /UserByScreenName（资料）+ /UserTweets 或 /UserOriginalsTimeline（时间线，2026 年起主页默认是后者），滚动翻页
 * - 回复区里会混进推广推文（entry 上有 promotedMetadata），已经过滤掉
 * - 推文对象：result（可能包在 TweetWithVisibilityResults.tweet 里）→ legacy.full_text / created_at / favorite_count / retweet_count /
 *   reply_count / quote_count / bookmark_count；views.count；作者 core.user_results.result.core.{screen_name,name}；
 *   长推文全文在 note_tweet.note_tweet_results.result.text
 * - 搜索语法：from:user、to:user、lang:zh、since:2025-01-01、until:、min_faves:100、filter:links、-filter:replies
 * - collect 前要先 tab.c('net.mark') 再跳转，不然首屏请求记不到
 */

const time = s => (s ? new Date(s).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined)

/** 从任意 GraphQL 返回里按出现顺序找出推文（不进到被引用 / 被转发的推文里面） */
function tweetsIn(obj, out = new Map()) {
  if (!obj || typeof obj !== 'object') return out
  if (Array.isArray(obj)) {
    for (const x of obj) tweetsIn(x, out)
    return out
  }
  if (obj.promotedMetadata) return out // 推广推文
  const t = obj.__typename === 'TweetWithVisibilityResults' ? obj.tweet : obj
  if (t && t.__typename === 'Tweet' && t.legacy && t.rest_id) {
    if (!out.has(t.rest_id)) out.set(t.rest_id, tweetOf(t))
    return out
  }
  for (const [k, v] of Object.entries(obj)) if (k !== 'quoted_status_result' && k !== 'retweeted_status_result') tweetsIn(v, out)
  return out
}

function tweetOf(t) {
  const L = t.legacy
  const u = t.core?.user_results?.result
  const user = u?.core?.screen_name || u?.legacy?.screen_name
  const rt = L.retweeted_status_result?.result
  const q = t.quoted_status_result?.result
  const qt = q?.__typename === 'TweetWithVisibilityResults' ? q.tweet : q
  let text = t.note_tweet?.note_tweet_results?.result?.text || L.full_text || ''
  for (const e of L.entities?.urls || []) text = text.replace(e.url, e.expanded_url)
  text = text.replace(/\s*https:\/\/t\.co\/\w+$/, m => ((L.extended_entities?.media || []).length ? '' : m))
  return {
    id: t.rest_id,
    user,
    name: u?.core?.name || u?.legacy?.name,
    text,
    time: time(L.created_at),
    likes: L.favorite_count,
    retweets: L.retweet_count,
    replies: L.reply_count,
    quotes: L.quote_count,
    views: t.views?.count ? Number(t.views.count) : undefined,
    lang: L.lang,
    replyTo: L.in_reply_to_screen_name || undefined,
    retweetOf: rt ? `@${rt.core?.user_results?.result?.core?.screen_name}：${(rt.legacy?.full_text || '').slice(0, 280)}` : undefined,
    quote: qt?.legacy ? `@${qt.core?.user_results?.result?.core?.screen_name}：${(qt.note_tweet?.note_tweet_results?.result?.text || qt.legacy.full_text || '').slice(0, 280)}` : undefined,
    media: (L.extended_entities?.media || []).map(m => m.type).join(',') || undefined,
    url: `https://x.com/${user}/status/${t.rest_id}`,
  }
}

async function openRecording(url) {
  const tab = await bx.open('about:blank')
  await tab.c('net.mark')
  await tab.goto(url)
  return tab
}

async function checkLogin(tab) {
  const s = await tab.eval(() => ({ url: location.href, login: /\/(i\/flow\/login|login)/.test(location.pathname) || !!document.querySelector('[data-testid="loginButton"]') }))
  if (s.login) throw new BxError('NEED_LOGIN', 'X 没有登录', '在浏览器里登录 x.com 后重试')
}

/** 收集一个页面上某个 GraphQL 操作的返回，直到够数或没有更多 */
async function gather(tab, op, limit, { first = [] } = {}) {
  const all = new Map(first.map(t => [t.id, t]))
  let stale = 0
  for await (const page of tab.collect(op instanceof RegExp ? op : `/${op}`, { past: true, timeout: 8000, more: () => tab.scroll('bottom') })) {
    const before = all.size
    for (const [id, t] of tweetsIn(page?.data)) if (!all.has(id)) all.set(id, t)
    if (all.size >= limit) break
    stale = all.size === before ? stale + 1 : 0
    if (stale >= 2) break
  }
  return [...all.values()]
}

/** 搜推文。mode：live 最新 / top 热门。q 支持 X 搜索语法（from:user since:2025-01-01 min_faves:100 lang:zh）
 *  @example search('sqlite production', { limit: 40 })
 *  @example search('from:badlogicgames rust', { mode: 'top' }) */
export async function search(q, { limit = 40, mode = 'live' } = {}) {
  const tab = await openRecording(`https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query${mode === 'live' ? '&f=live' : ''}`)
  try {
    const out = await gather(tab, 'SearchTimeline', limit)
    if (!out.length) {
      await checkLogin(tab)
      throw new BxError('EMPTY', `X 没有搜到 ${q}`, '换个关键词，或者 mode 换成 top')
    }
    return out.slice(0, limit)
  } finally {
    await tab.close().catch(() => {})
  }
}

/** 一条推文 + 它的回复（第一条是这条推文本身，后面是对话串和回复）
 *  @example status('https://x.com/badlogicgames/status/2107176943846039859', { limit: 50 }) */
export async function status(url, { limit = 50 } = {}) {
  const id = String(url).match(/status\/(\d+)/)?.[1] || String(url).match(/^\d+$/)?.[0]
  if (!id) throw new BxError('BAD_ARGS', '要推文链接或推文 id')
  const tab = await openRecording(/^https?:/.test(url) ? url : `https://x.com/i/status/${id}`)
  try {
    const out = await gather(tab, 'TweetDetail', limit + 1)
    if (!out.length) {
      await checkLogin(tab)
      throw new BxError('NOT_FOUND', `推文 ${id} 打不开（删除了或受保护）`)
    }
    const i = out.findIndex(t => t.id === id)
    if (i > 0) out.unshift(...out.splice(i, 1))
    return out.slice(0, limit + 1)
  } finally {
    await tab.close().catch(() => {})
  }
}

/** 用户资料 + 最近的推文。handle 是 @用户名 或主页链接
 *  @example user('badlogicgames', { limit: 20 }) */
export async function user(handle, { limit = 20 } = {}) {
  const name = String(handle).replace(/^@/, '').match(/^(?:https?:\/\/(?:x|twitter)\.com\/)?([\w]+)/)?.[1]
  if (!name) throw new BxError('BAD_ARGS', '要用户名或主页链接')
  const tab = await openRecording(`https://x.com/${name}`)
  try {
    let profile
    for await (const page of tab.collect('/UserByScreenName', { past: true, timeout: 10000, idle: 1, limit: 1 })) profile = page?.data?.user?.result
    if (!profile) {
      await checkLogin(tab)
      throw new BxError('NOT_FOUND', `没有用户 ${name}`)
    }
    const tweets = limit > 0 ? (await gather(tab, /\/graphql\/[^/]+\/(UserTweets|UserOriginalsTimeline)\b/, limit)).filter(t => t.user?.toLowerCase() === name.toLowerCase() || t.retweetOf) : []
    const L = profile.legacy || {}
    return {
      user: profile.core?.screen_name || L.screen_name,
      name: profile.core?.name || L.name,
      bio: profile.profile_bio?.description || L.description,
      location: profile.location?.location || L.location || undefined,
      followers: L.followers_count ?? profile.relationship_counts?.followers,
      following: L.friends_count ?? profile.relationship_counts?.following,
      tweets: L.statuses_count ?? profile.tweet_counts?.tweets,
      created: time(profile.core?.created_at || L.created_at),
      verified: profile.is_blue_verified || undefined,
      url: `https://x.com/${name}`,
      recent: tweets.slice(0, limit),
    }
  } finally {
    await tab.close().catch(() => {})
  }
}

/** 推文页的读法：推文 + 回复 */
export async function read(tab, { limit = 30 } = {}) {
  const url = await tab.url()
  if (!/x\.com\/\w+\/status\/\d+/.test(url)) return null
  const [t, ...rs] = await status(url, { limit })
  return {
    title: `@${t.user}：${t.text.slice(0, 50)}`,
    meta: { author: `${t.name} (@${t.user})`, published: t.time, site: 'X', likes: t.likes, retweets: t.retweets, views: t.views },
    content: [t.text, t.quote ? `\n> 引用 ${t.quote}` : '', '', `## 回复（${t.replies}）`, ...rs.map(r => `- **@${r.user}**（❤${r.likes}）：${r.text.replace(/\n+/g, ' ')}`)].join('\n'),
  }
}
