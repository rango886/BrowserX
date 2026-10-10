/* 站点笔记（微博）：
 * @login required 没登录时 /ajax 接口返回 ok:-100 或跳到 passport 登录页
 * - 在 weibo.com 标签里带 cookie 请求 /ajax 接口：
 *     热搜 /ajax/statuses/hot_band（band_list）
 *     单条 /ajax/statuses/show?id=<mblogid 或数字 id>；长文要再请求 /ajax/statuses/longtext?id=<mblogid>
 *     评论 /ajax/statuses/buildComments?flow=0&is_reload=1&id=<数字id>&uid=<作者uid>&is_show_bulletin=2&count=20，翻页带上返回的 max_id
 *     用户 /ajax/profile/info?uid= | screen_name=；用户微博 /ajax/statuses/mymblog?uid=&page=&feature=0
 * - 搜索没有 JSON 接口，抓 s.weibo.com/weibo?q=&page= 的 HTML（.card-wrap[mid]）；xsort=hot 热门，realtime 页是实时
 * - 标签要匹配 https://weibo.com/*，只写 weibo.com 会匹配到 s.weibo.com / passport.weibo.com
 * - created_at 是 "Fri Oct 10 10:00:00 +0800 2026" 这种格式
 * - 请求快了会 414 / 418 风控，翻页之间停一会儿
 */

const tabOf = () => bx.tab('https://weibo.com/*', { open: 'https://weibo.com/' })
const time = s => {
  if (!s) return undefined
  const d = new Date(s)
  return isNaN(d) ? s : d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)
}
const strip = h => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()

async function ajax(path) {
  const tab = await tabOf()
  const r = await tab.c('page.fetch', { url: 'https://weibo.com' + path, init: { headers: { 'X-Requested-With': 'XMLHttpRequest' } }, as: 'text' })
  if (/passport\.weibo\.com|login\.sina/.test(r.url || '') || r.status === 401) throw new BxError('NEED_LOGIN', '微博没有登录', '在浏览器里登录 weibo.com 后重试')
  if (r.status === 414 || r.status === 418 || r.status === 429) throw new BxError('BLOCKED', `微博风控（${r.status}）`, '停一会儿再试')
  if (r.status === 404) throw new BxError('NOT_FOUND', `微博 404：${path}`)
  let j
  try {
    j = JSON.parse(r.text)
  } catch {
    throw new BxError('NOT_JSON', `微博返回的不是 JSON：${path}`, String(r.text).slice(0, 200))
  }
  if (j.ok === -100) throw new BxError('NEED_LOGIN', '微博没有登录（ok:-100）', '在浏览器里登录 weibo.com 后重试')
  if (j.ok === 0 || j.ok === false) throw new BxError(/不存在|删除/.test(j.msg || j.message || '') ? 'NOT_FOUND' : 'HTTP_ERROR', `微博接口出错：${j.msg || j.message || JSON.stringify(j).slice(0, 100)}`)
  return j
}

const postOf = s => ({
  id: s.idstr,
  mblogid: s.mblogid,
  author: s.user?.screen_name,
  uid: s.user?.idstr || String(s.user?.id || ''),
  text: s.text_raw || strip(s.text),
  time: time(s.created_at),
  reposts: s.reposts_count,
  comments: s.comments_count,
  likes: s.attitudes_count,
  pics: s.pic_num || undefined,
  longText: s.isLongText || undefined,
  retweet: s.retweeted_status ? `@${s.retweeted_status.user?.screen_name}：${(s.retweeted_status.text_raw || strip(s.retweeted_status.text)).slice(0, 200)}` : undefined,
  pinned: s.isTop === 1 || s.isTop === true || s.title?.text === '置顶' || undefined,
  url: `https://weibo.com/${s.user?.idstr || s.user?.id}/${s.mblogid}`,
})

/** 微博热搜榜
 *  @login none
 *  @example hot({ limit: 20 }) */
export async function hot({ limit = 50 } = {}) {
  const j = await ajax('/ajax/statuses/hot_band')
  return (j.data?.band_list || []).filter(b => !b.is_ad).slice(0, limit).map((b, i) => ({
    rank: b.realpos || i + 1,
    word: b.word,
    heat: b.num,
    label: b.label_name || undefined,
    category: b.category || undefined,
    url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent('#' + b.word + '#'),
  }))
}

/** 搜微博（抓搜索结果页）。sort：default 综合 / hot 热门 / time 实时；pages 翻几页（每页约 10 条）
 *  @example search('武汉 晚自习 家长', { pages: 2, sort: 'hot' }) */
export async function search(q, { pages = 1, sort = 'default', limit = 50 } = {}) {
  const out = []
  const tab = await bx.open('about:blank')
  try {
    for (let p = 1; p <= pages && out.length < limit; p++) {
      const base = sort === 'time' ? 'https://s.weibo.com/realtime' : 'https://s.weibo.com/weibo'
      await tab.goto(`${base}?q=${encodeURIComponent(q)}${sort === 'hot' ? '&xsort=hot&suball=1' : ''}${sort === 'time' ? '&rd=realtime&tw=realtime&Refer=weibo_realtime' : ''}&page=${p}`)
      await tab.waitFor({ selector: '.card-wrap, .card-no-result, .m-error', timeout: 15000 }).catch(() => {})
      const r = await tab.eval(() => {
        if (/passport|login/.test(location.host + location.pathname)) return { login: true }
        const clean = s => (s || '').replace(/\s+/g, ' ').trim()
        const num = s => {
          const t = clean(s).replace(/[^\d.万]/g, '')
          return t.includes('万') ? Math.round(parseFloat(t) * 1e4) : Number(t) || 0
        }
        const rows = []
        for (const card of document.querySelectorAll('.card-wrap[mid]')) {
          const full = card.querySelector('[node-type="feed_list_content_full"]')
          const txt = full || card.querySelector('[node-type="feed_list_content"]') || card.querySelector('.txt')
          const text = clean(txt?.innerText).replace(/\s*收起d?$/, '')
          if (!text) continue
          const from = card.querySelector('.from a')
          const href = from?.href || ''
          const acts = [...card.querySelectorAll('.card-act li, .card-act .item')].map(li => li.innerText)
          rows.push({
            id: card.getAttribute('mid'),
            mblogid: href.match(/weibo\.com\/\d+\/(\w+)/)?.[1],
            author: clean(card.querySelector('.info .name, .name')?.textContent),
            text,
            time: clean(from?.textContent),
            reposts: num(acts.find(a => /转发/.test(a)) || acts[0]),
            comments: num(acts.find(a => /评论/.test(a)) || acts[1]),
            likes: num(card.querySelector('.woo-like-count, [action-type="feed_list_like"] em')?.textContent || acts[2]),
            url: href.split('?')[0],
          })
        }
        return { rows, noResult: !!document.querySelector('.card-no-result') }
      })
      if (r.login) throw new BxError('NEED_LOGIN', '微博搜索跳到了登录页', '在浏览器里登录 weibo.com 后重试')
      out.push(...r.rows)
      if (!r.rows.length) break
      await bx.sleep(800)
    }
  } finally {
    await tab.close().catch(() => {})
  }
  if (!out.length) throw new BxError('EMPTY', `微博没有搜到 ${q}`, '换个关键词')
  return out.slice(0, limit)
}

/** 单条微博（含长文全文）。url 是微博链接、mblogid 或数字 id
 *  @example post('https://weibo.com/2803301701/RlZmsl77c') */
export async function post(url) {
  const id = String(url).match(/weibo\.(?:com|cn)\/(?:\d+|detail|status)\/(\w+)/)?.[1] || String(url).trim()
  const s = await ajax(`/ajax/statuses/show?id=${encodeURIComponent(id)}&isGetLongText=true`)
  const p = postOf(s)
  if (s.isLongText) {
    const lt = await ajax(`/ajax/statuses/longtext?id=${s.mblogid}`).catch(() => null)
    if (lt?.data?.longTextContent) p.text = strip(lt.data.longTextContent)
  }
  return p
}

/** 微博评论（按热度）。url 是微博链接 / mblogid / 数字 id；replies 每条带几条楼中楼
 *  @example comments('https://weibo.com/2803301701/RlZmsl77c', { limit: 50 }) */
export async function comments(url, { limit = 50, replies = 2 } = {}) {
  const p = await post(url)
  const out = []
  let maxId = ''
  for (let i = 0; i < 30 && out.length < limit; i++) {
    const j = await ajax(`/ajax/statuses/buildComments?flow=0&is_reload=1&id=${p.id}&uid=${p.uid}&is_show_bulletin=2&is_mix=0&count=20&fetch_level=0${maxId ? `&max_id=${maxId}` : ''}`)
    for (const c of j.data || []) {
      out.push({
        author: c.user?.screen_name,
        text: c.text_raw || strip(c.text),
        likes: c.like_counts ?? c.like_count,
        replies: c.total_number || undefined,
        location: c.source?.replace(/^来自/, '') || undefined,
        time: time(c.created_at),
        sub: replies && c.comments?.length ? c.comments.slice(0, replies).map(x => `${x.user?.screen_name}：${x.text_raw || strip(x.text)}`).join(' / ') : undefined,
      })
      if (out.length >= limit) break
    }
    maxId = j.max_id
    if (!maxId || !(j.data || []).length) break
    await bx.sleep(500)
  }
  return out
}

/** 用户资料。uid（数字）、昵称或主页链接
 *  @example user('人民日报') */
export async function user(who) {
  const u = await userInfo(who)
  return {
    uid: u.idstr,
    name: u.screen_name,
    description: u.description,
    followers: u.followers_count_str || u.followers_count,
    following: u.friends_count,
    posts: u.statuses_count,
    verified: u.verified_reason || undefined,
    location: u.location || undefined,
    url: `https://weibo.com/u/${u.idstr}`,
  }
}

async function userInfo(who) {
  const s = String(who).trim()
  const uid = s.match(/weibo\.com\/(?:u\/)?(\d+)/)?.[1] || (/^\d+$/.test(s) ? s : '')
  const j = await ajax(uid ? `/ajax/profile/info?uid=${uid}` : `/ajax/profile/info?screen_name=${encodeURIComponent(s.replace(/^@/, ''))}`)
  if (!j.data?.user) throw new BxError('NOT_FOUND', `没有用户 ${who}`)
  return j.data.user
}

/** 用户发的微博（新的在前）
 *  @example userPosts('人民日报', { limit: 20 }) */
export async function userPosts(who, { limit = 20 } = {}) {
  const u = await userInfo(who)
  const out = []
  for (let page = 1; page <= 20 && out.length < limit; page++) {
    const j = await ajax(`/ajax/statuses/mymblog?uid=${u.idstr}&page=${page}&feature=0`)
    const list = j.data?.list || []
    out.push(...list.map(postOf))
    if (!list.length) break
    await bx.sleep(500)
  }
  return out.slice(0, limit)
}

/** 当前登录的账号 */
export async function me() {
  const tab = await tabOf()
  const r = await tab.eval(() => window.$CONFIG?.user || null)
  if (r?.idstr) return { uid: r.idstr, name: r.screen_name, url: `https://weibo.com/u/${r.idstr}` }
  const j = await ajax('/ajax/config/get_config')
  if (!j.data?.uid) throw new BxError('NEED_LOGIN', '微博没有登录', '在浏览器里登录 weibo.com 后重试')
  return { uid: String(j.data.uid), url: `https://weibo.com/u/${j.data.uid}` }
}

/** 单条微博页的读法：正文 + 热门评论 */
export async function read(tab, { limit = 30 } = {}) {
  const url = await tab.url()
  if (!/^https:\/\/(www\.)?weibo\.com\/\d+\/\w+/.test(url)) return null
  const p = await post(url)
  const cs = await comments(url, { limit }).catch(() => [])
  return {
    title: p.text.slice(0, 40),
    meta: { author: p.author, published: p.time, site: '微博', reposts: p.reposts, comments: p.comments, likes: p.likes },
    content: [p.text, p.retweet ? `\n> 转发 ${p.retweet}` : '', '', `## 评论（${p.comments}）`, ...cs.map(c => `- **${c.author}**（👍${c.likes}）：${c.text}${c.sub ? `\n  ↳ ${c.sub}` : ''}`)].join('\n'),
  }
}
