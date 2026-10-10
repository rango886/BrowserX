/* 站点笔记（Reddit）：
 * @login optional 不登录也能用，但更容易被限流（429）；home() 要登录
 * - 每个页面加 .json 就是数据：/search.json、/r/<sub>/search.json?restrict_sr=1、<帖子地址>.json、/r/<sub>/hot.json、/user/<名字>/submitted.json
 * - 在已打开的 www.reddit.com 标签里请求（tab.fetch 带登录状态）；加 raw_json=1 拿到没转义的正文
 * - 帖子 .json 返回 [帖子, 评论树]；评论树里 kind=t1 是评论，kind=more 是“加载更多”：
 *   data.children 是藏起来的评论 id，用 GET /api/morechildren.json?api_type=json&link_id=t3_<帖子id>&children=id1,id2…（一次最多 100 个）
 *   拿回来的是扁平列表，按 parent_id（t3_ 顶层 / t1_ 某条评论）挂回树上；里面可能又有新的 more，所以要多轮
 * - 当前登录用户 /api/me.json（data.name）
 * - 时间是秒级时间戳 created_utc
 */

const tabOf = () => bx.tab('reddit.com', { open: 'https://www.reddit.com/' })
const iso = s => (s ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') : undefined)
const R = 'https://www.reddit.com'

const postOf = p => ({
  site: 'reddit',
  id: p.id,
  title: p.title,
  url: `${R}${p.permalink}`,
  sub: p.subreddit,
  author: p.author,
  score: p.score,
  comments: p.num_comments,
  time: iso(p.created_utc),
  flair: p.link_flair_text || undefined,
  link: !p.is_self && p.url && !p.url.includes(p.permalink) ? p.url : undefined,
  text: p.selftext ? p.selftext.slice(0, 500) : undefined,
})

/** 翻页拉一个列表接口（/xxx.json），返回 data.children 里的 data */
async function listing(path, limit, kind = 't3') {
  const tab = await tabOf()
  const out = []
  let after = ''
  while (out.length < limit) {
    const sep = path.includes('?') ? '&' : '?'
    const j = await tab.fetch(`${R}${path}${sep}limit=${Math.min(100, limit - out.length)}&raw_json=1${after ? `&after=${after}` : ''}`)
    const list = j?.data?.children
    if (!Array.isArray(list)) throw new BxError('CHANGED', `Reddit ${path} 返回的结构变了`, '去修 reddit.com.js')
    out.push(...list.filter(c => !kind || c.kind === kind).map(c => c.data))
    after = j.data.after
    if (!after || !list.length) break
    await bx.sleep(500)
  }
  return out.slice(0, limit)
}

/** 搜索帖子。time：hour day week month year all；sort：relevance hot top new comments；sub 限定在某个版块
 *  @example search('sqlite production', { time: 'year', limit: 50 }) */
export async function search(q, { time = 'year', sort = 'relevance', limit = 25, sub = '' } = {}) {
  const base = sub ? `/r/${sub}/search.json?restrict_sr=1&` : '/search.json?'
  const list = await listing(`${base}q=${encodeURIComponent(q)}&t=${time}&sort=${sort}&type=link`, limit)
  return list.map(postOf)
}

/** 版块里的帖子。sub 不写 = 登录用户的首页（没登录是热门）；也可以写 popular / all。sort：hot new top rising；time 只对 top 有用
 *  @example posts('LocalLLaMA', { sort: 'top', time: 'week', limit: 30 })
 *  @example posts('popular', { limit: 20 }) */
export async function posts(sub = '', { sort = 'hot', time = 'day', limit = 25 } = {}) {
  const s = String(sub).replace(/^\/?r\//, '')
  const list = await listing(`${s ? `/r/${s}` : ''}/${sort}.json?t=${time}`, limit)
  if (!list.length) throw new BxError('EMPTY', `r/${s || '首页'} 没有帖子`, '检查版块名')
  return list.map(postOf)
}

/** 登录用户的首页推荐（best）
 *  @login required
 *  @example home({ limit: 20 }) */
export async function home({ limit = 25 } = {}) {
  await me()
  return (await listing('/best.json', limit)).map(postOf)
}

/** 当前登录的账号（检查登录状态用）
 *  @login required
 *  @example me() */
export async function me() {
  const tab = await tabOf()
  const j = await tab.fetch(`${R}/api/me.json`).catch(() => null)
  const d = j?.data
  if (!d?.name) throw new BxError('NEED_LOGIN', '没有登录 Reddit', '请用户在浏览器里登录 reddit.com')
  return { name: d.name, karma: d.total_karma ?? (d.link_karma || 0) + (d.comment_karma || 0), created: iso(d.created_utc), url: `${R}/user/${d.name}/` }
}

/** 帖子的评论，拍平成列表（depth 是楼层深度）。sort：top best new controversial old；
 *  more：展开“加载更多”的轮数（0 = 不展开，大帖子开着会多发几次请求）
 *  @example comments('https://www.reddit.com/r/sqlite/comments/abc123/xxx/', { limit: 80 })
 *  @example comments('https://www.reddit.com/r/AskReddit/comments/abc123/', { limit: 500, more: 3 }) */
export async function comments(url, { limit = 100, sort = 'top', more = 2 } = {}) {
  const tab = await tabOf()
  const u = new URL(String(url).startsWith('http') ? url : `${R}${url.startsWith('/') ? '' : '/'}${url}`)
  u.pathname = u.pathname.replace(/\/?$/, '.json')
  u.search = `?limit=500&sort=${sort}&raw_json=1`
  const j = await tab.fetch(u.href)
  if (!Array.isArray(j) || !j[1]?.data) throw new BxError('NOT_FOUND', `不是帖子地址：${url}`, '需要 https://www.reddit.com/r/<版块>/comments/<id>/... 这种地址')
  const linkId = j[0]?.data?.children?.[0]?.data?.name

  // 建一棵树：节点 { d, kids }，more 存成 { more: [ids] }
  const byName = new Map()
  const build = children =>
    (children || []).flatMap(c => {
      if (c.kind === 'more') return c.data.children?.length ? [{ more: c.data.children }] : []
      if (c.kind !== 't1') return []
      const n = { d: c.data, kids: build(c.data.replies?.data?.children) }
      byName.set(c.data.name, n)
      return [n]
    })
  const root = { kids: build(j[1].data.children) }
  const count = () => byName.size

  for (let round = 0; round < more && linkId && count() < limit; round++) {
    // 收集所有 more（记住在哪个父节点下）
    const stubs = []
    const collect = n => {
      for (const k of n.kids) k.more ? stubs.push({ parent: n, stub: k }) : collect(k)
    }
    collect(root)
    if (!stubs.length) break
    const ids = [...new Set(stubs.flatMap(s => s.stub.more))].slice(0, Math.max(100, (limit - count()) * 1.2))
    for (const s of stubs) s.parent.kids = s.parent.kids.filter(k => k !== s.stub)
    for (let i = 0; i < ids.length && count() < limit; i += 100) {
      const r = await tab.fetch(`${R}/api/morechildren.json?api_type=json&link_id=${linkId}&children=${ids.slice(i, i + 100).join(',')}&sort=${sort}&raw_json=1`).catch(() => null)
      const things = r?.json?.data?.things
      if (!Array.isArray(things)) break
      for (const t of things) {
        const parent = t.data.parent_id?.startsWith('t1_') ? byName.get(t.data.parent_id) : root
        if (!parent) continue
        if (t.kind === 'more') {
          if (t.data.children?.length) parent.kids.push({ more: t.data.children })
          continue
        }
        if (t.kind !== 't1' || byName.has(t.data.name)) continue
        const n = { d: t.data, kids: [] }
        byName.set(t.data.name, n)
        parent.kids.push(n)
      }
      await bx.sleep(300)
    }
  }

  const out = []
  let hidden = 0
  const walk = (n, depth) => {
    for (const k of n.kids) {
      if (k.more) {
        hidden += k.more.length
        continue
      }
      if (out.length >= limit) return
      out.push({ author: k.d.author, text: k.d.body, score: k.d.score, depth, time: iso(k.d.created_utc), id: k.d.id })
      walk(k, depth + 1)
    }
  }
  walk(root, 0)
  if (hidden && out.length < limit) bx.log(`还有 ${hidden} 条评论没展开（加大 more 再试）`)
  return out
}

/** 用户资料（karma、注册时间）
 *  @example user('spez') */
export async function user(name) {
  const n = String(name).replace(/^\/?u(ser)?\//, '').replace(/\/$/, '')
  const tab = await tabOf()
  const j = await tab.fetch(`${R}/user/${n}/about.json`).catch(e => {
    if (e.code === 'NEED_LOGIN') throw new BxError('NOT_FOUND', `用户 ${n} 不存在或被封了`)
    throw e
  })
  const d = j?.data
  if (!d?.name) throw new BxError('NOT_FOUND', `用户 ${n} 不存在`)
  return { name: d.name, karma: d.total_karma, linkKarma: d.link_karma, commentKarma: d.comment_karma, created: iso(d.created_utc), bio: d.subreddit?.public_description || undefined, url: `${R}/user/${d.name}/` }
}

/** 用户发的帖子。sort：new hot top
 *  @example userPosts('spez', { limit: 20 }) */
export async function userPosts(name, { sort = 'new', limit = 25 } = {}) {
  const n = String(name).replace(/^\/?u(ser)?\//, '')
  return (await listing(`/user/${n}/submitted.json?sort=${sort}`, limit)).map(postOf)
}

/** 用户发的评论（带所在帖子）。sort：new hot top
 *  @example userComments('spez', { limit: 30 }) */
export async function userComments(name, { sort = 'new', limit = 25 } = {}) {
  const n = String(name).replace(/^\/?u(ser)?\//, '')
  const list = await listing(`/user/${n}/comments.json?sort=${sort}`, limit, 't1')
  return list.map(c => ({ author: c.author, text: c.body, score: c.score, time: iso(c.created_utc), sub: c.subreddit, post: c.link_title, url: `${R}${c.permalink}` }))
}

/** 版块信息：订阅数、在线人数、简介、创建时间
 *  @example subreddit('LocalLLaMA') */
export async function subreddit(name) {
  const n = String(name).replace(/^\/?r\//, '').replace(/\/$/, '')
  const tab = await tabOf()
  const j = await tab.fetch(`${R}/r/${n}/about.json`)
  const d = j?.data
  if (!d?.display_name) throw new BxError('NOT_FOUND', `版块 r/${n} 不存在`)
  return { name: d.display_name, title: d.title, subscribers: d.subscribers, online: d.active_user_count ?? d.accounts_active, created: iso(d.created_utc), nsfw: d.over18 || undefined, description: d.public_description, url: `${R}/r/${d.display_name}/` }
}
