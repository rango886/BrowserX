/* 站点笔记（抖音）：
 * @login optional 不登录也能搜、能看评论，但结果更少、更容易出验证码
 * - 接口都要 a_bogus 签名，自己发不了；做法是打开页面，用 tab.collect 接住页面自己发的请求：
 *     搜索 /aweme/v1/web/search/item/（打开 /search/<词>?type=video 时发一次，第一页 15 条左右；没接到就从 DOM 读 [data-e2e="scroll-list"] li）
 *     评论 /aweme/v1/web/comment/list/（打开 /video/<id> 时自动发，滚动 [data-e2e="comment-list"] 所在的滚动容器翻页）
 *     用户作品 /aweme/v1/web/aweme/post/（打开 /user/<sec_uid> 后滚动）
 * - 热榜 /aweme/v1/web/hot/search/list/ 不用签名，在 douyin.com 标签里直接请求
 * - 视频详情直接读页面：[data-e2e="detail-video-info"] 里依次是 点赞 评论 收藏 分享，和“发布时间：…”
 * - 打开抖音页面时会换渲染进程（调试连接断开重连），bx 会自动重新打开网络记录；collect 前先 tab.c('net.mark')
 * - 数字有“4.2万”这种，统一换算成整数
 */

const num = s => {
  const t = String(s ?? '').trim()
  if (!t) return undefined
  const n = parseFloat(t.replace(/[^\d.]/g, ''))
  return /亿/.test(t) ? Math.round(n * 1e8) : /万|w/i.test(t) ? Math.round(n * 1e4) : n || 0
}
const sec = t => (t ? new Date(t * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined)
const vid = x => String(x).match(/(?:video|note|modal_id=)\/?(\d{15,})/)?.[1] || String(x).match(/^\d{15,}$/)?.[0]

async function openRecording(url) {
  const tab = await bx.open('about:blank')
  await tab.c('net.mark')
  await tab.goto(url)
  return tab
}

const keep = new WeakSet() // 出验证码的标签留着，让用户去处理
async function checkWall(tab) {
  // 验证码有两种：页面里弹层；或者整页换成“验证码中间页”，里面只有一个 rmc.bytedance.com/verifycenter/captcha 的 iframe
  const s = await tab.eval(() => ({ captcha: !!document.querySelector('#captcha_container, .captcha_verify_container, [class*="captcha"], iframe[src*="verifycenter/captcha"]') || /验证码/.test(document.title), login: !!document.querySelector('[data-e2e="login-panel"], .login-mask'), url: location.href }))
  if (s.captcha) keep.add(tab)
  if (s.captcha) throw new BxError('BLOCKED', '抖音出了验证码', `bx tab activate ${tab.id} 在浏览器里处理一下再试`)
  if (s.login) throw new BxError('NEED_LOGIN', '抖音要求登录', '在浏览器里登录 douyin.com 后重试')
}

const awemeOf = a => ({
  id: a.aweme_id,
  desc: a.desc,
  author: a.author?.nickname,
  authorId: a.author?.sec_uid,
  time: sec(a.create_time),
  duration: a.video?.duration ? Math.round(a.video.duration / 1000) : undefined,
  likes: a.statistics?.digg_count,
  comments: a.statistics?.comment_count,
  collects: a.statistics?.collect_count,
  shares: a.statistics?.share_count,
  url: `https://www.douyin.com/video/${a.aweme_id}`,
})

/** 抖音热榜
 *  @example hot({ limit: 20 }) */
export async function hot({ limit = 50 } = {}) {
  const tab = await bx.tab('www.douyin.com', { open: 'https://www.douyin.com/' })
  const j = await tab.fetch('https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1')
  const list = j.data?.word_list || []
  if (!list.length) throw new BxError('CHANGED', '抖音热榜接口没返回数据', '去修 hot')
  return list.slice(0, limit).map((w, i) => ({ rank: w.position || i + 1, word: w.word, heat: w.hot_value, label: w.label ? String(w.label) : undefined, videos: w.video_count, url: `https://www.douyin.com/search/${encodeURIComponent(w.word)}` }))
}

/** 搜视频（第一页约 15 条）。sort：0 综合 / 1 最多点赞 / 2 最新
 *  @example search('美食', { limit: 10 }) */
export async function search(q, { limit = 20, sort = 0 } = {}) {
  const tab = await openRecording(`https://www.douyin.com/search/${encodeURIComponent(q)}?type=video${sort ? `&sort_type=${sort}` : ''}`)
  try {
    const out = []
    for await (const page of tab.collect('/aweme/v1/web/search/item', { past: true, timeout: 10000, idle: 1, more: () => tab.eval(() => document.querySelector('[data-e2e="scroll-list"] li:last-child')?.scrollIntoView()) })) {
      for (const d of page?.data || []) if (d.aweme_info) out.push(awemeOf(d.aweme_info))
      if (out.length >= limit || !page?.has_more) break
    }
    if (out.length) return out.slice(0, limit)
    // 没接到接口：从页面读
    await tab.waitFor({ selector: '[data-e2e="scroll-list"] li a[href*="/video/"]', timeout: 8000 }).catch(() => {})
    const rows = await tab.eval(() =>
      [...document.querySelectorAll('[data-e2e="scroll-list"] li')].map(li => {
        const href = li.querySelector('a[href*="/video/"]')?.getAttribute('href') || ''
        const t = li.innerText.split('\n').map(s => s.trim()).filter(Boolean)
        return { href, lines: t }
      }),
    )
    for (const r of rows) {
      const id = r.href.match(/video\/(\d+)/)?.[1]
      if (!id) continue
      const author = r.lines.find(l => l.startsWith('@'))?.slice(1)
      out.push({ id, desc: r.lines.filter(l => l.length > 8 && !l.startsWith('@')).sort((a, b) => b.length - a.length)[0], author, likes: num(r.lines.find(l => /^[\d.]+[万亿]?$/.test(l))), time: r.lines.at(-1), url: `https://www.douyin.com/video/${id}` })
    }
    if (!out.length) {
      await checkWall(tab)
      throw new BxError('EMPTY', `抖音没有搜到 ${q}`, '换个关键词')
    }
    return out.slice(0, limit)
  } finally {
    if (!keep.has(tab)) await tab.close().catch(() => {})
  }
}

function scrollComments() {
  let e = document.querySelector('[data-e2e="comment-list"]')
  while (e && !(e.scrollHeight > e.clientHeight + 10)) e = e.parentElement
  if (e) e.scrollTop = e.scrollHeight
  return !document.querySelector('[data-e2e="comment-list"] .comment-end, [class*="no-more"]')
}

async function videoOn(tab) {
  await tab.waitFor({ selector: '[data-e2e="detail-video-info"], [data-e2e="video-desc"]', timeout: 15000 }).catch(() => {})
  const v = await tab.eval(() => {
    const info = document.querySelector('[data-e2e="detail-video-info"]')
    if (!info) return null
    const txt = info.innerText
    const nums = txt.split('\n').map(s => s.trim()).filter(s => /^[\d.]+[万亿w]?$/.test(s))
    return {
      desc: (document.querySelector('[data-e2e="video-desc"]') || document.querySelector('h1'))?.innerText.trim(),
      author: (document.querySelector('[data-e2e="user-info"] a[href*="/user/"] span span, [data-e2e="user-info"] a[href*="/user/"] span')?.innerText || document.querySelector('[data-e2e="user-info"] a[href*="/user/"]')?.innerText || '').split('\n')[0].replace(/认证徽章.*$/, '').trim() || undefined,
      authorUrl: document.querySelector('[data-e2e="user-info"] a[href*="/user/"]')?.href?.split('?')[0],
      nums,
      time: txt.match(/发布时间[：:]\s*([\d-]+ [\d:]+)/)?.[1],
    }
  })
  if (!v) {
    await checkWall(tab)
    throw new BxError('CHANGED', '视频页没找到信息（可能是图文 / 已删除，或页面结构变了）', '用 bx read 看看')
  }
  return { desc: v.desc, author: v.author, authorUrl: v.authorUrl, time: v.time, likes: num(v.nums[0]), comments: num(v.nums[1]), collects: num(v.nums[2]), shares: num(v.nums[3]) }
}

async function commentsOn(tab, limit) {
  const out = []
  for await (const page of tab.collect('/aweme/v1/web/comment/list', { past: true, timeout: 10000, idle: 1, more: () => tab.eval(scrollComments) })) {
    for (const c of page?.comments || [])
      out.push({ author: c.user?.nickname, text: c.text, likes: c.digg_count, replies: c.reply_comment_total || undefined, location: c.ip_label || undefined, time: sec(c.create_time) })
    if (out.length >= limit || !page?.has_more) break
  }
  return out.slice(0, limit)
}

/** 视频信息（描述、作者、点赞评论收藏分享、发布时间）+ 热门评论
 *  @example video('https://www.douyin.com/video/7694699331592490249', { comments: 20 }) */
export async function video(url, { comments = 20 } = {}) {
  const id = vid(url)
  if (!id) throw new BxError('BAD_ARGS', '要视频链接或视频 id')
  const tab = await openRecording(`https://www.douyin.com/video/${id}`)
  try {
    const v = await videoOn(tab)
    return { id, ...v, url: `https://www.douyin.com/video/${id}`, commentList: comments > 0 ? await commentsOn(tab, comments) : [] }
  } finally {
    if (!keep.has(tab)) await tab.close().catch(() => {})
  }
}

/** 视频评论（按热度）
 *  @example comments('https://www.douyin.com/video/7694699331592490249', { limit: 50 }) */
export async function comments(url, { limit = 50 } = {}) {
  const id = vid(url)
  if (!id) throw new BxError('BAD_ARGS', '要视频链接或视频 id')
  const tab = await openRecording(`https://www.douyin.com/video/${id}`)
  try {
    const out = await commentsOn(tab, limit)
    if (!out.length) await checkWall(tab)
    return out
  } finally {
    if (!keep.has(tab)) await tab.close().catch(() => {})
  }
}

/** 用户主页的作品列表。url 是 /user/<sec_uid> 链接
 *  @example userVideos('https://www.douyin.com/user/MS4wLjABAAAA7XpEbISHnNcUzdrK8Xinzr4irjk0QXNtbVkcfrR8BV0', { limit: 30 }) */
export async function userVideos(url, { limit = 30 } = {}) {
  if (!/\/user\//.test(url)) url = `https://www.douyin.com/user/${url}`
  const tab = await openRecording(url)
  const out = []
  try {
    for await (const page of tab.collect('/aweme/v1/web/aweme/post', { past: true, timeout: 10000, idle: 1, more: () => tab.scroll('bottom') })) {
      for (const a of page?.aweme_list || []) out.push(awemeOf(a))
      if (out.length >= limit || !page?.has_more) break
    }
    if (!out.length) await checkWall(tab)
  } finally {
    if (!keep.has(tab)) await tab.close().catch(() => {})
  }
  return out.slice(0, limit)
}

/** 视频页的读法：描述 + 数据（评论用 comments 取） */
export async function read(tab) {
  const url = await tab.url()
  if (!/douyin\.com\/video\/\d+/.test(url)) return null
  const v = await videoOn(tab)
  return {
    title: v.desc?.slice(0, 60),
    meta: { author: v.author, published: v.time, site: '抖音', likes: v.likes, comments: v.comments, collects: v.collects, shares: v.shares },
    content: [v.desc, '', `评论 ${v.comments} 条：bx call douyin.com comments ${url}`].join('\n'),
  }
}
