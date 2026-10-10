/* 站点笔记（B 站）：
 * @login optional 不登录时评论只给前几条、下载画质最高 480P，也更容易被风控
 * - 思路：在已登录的 B 站标签里直接调 B 站自己的接口（tab.fetch 带着登录状态），签名在 Node 里算
 * - 路径里带 /wbi/ 的接口要签名，见 _bili-wbi.js（密钥来自 nav 接口的 wbi_img，10 分钟缓存）
 * - 评论接口的 oid 要用 aid，不是 bvid：先用 x/web-interface/view 换一下
 * - code -101 没登录；-352 / -412 / -799 是风控（请求太快），翻页之间停 300ms 以上
 * - 排行榜分区的 rid 是在页面上把每个分区点一遍、从网络记录里读出来的（RANK_RID）
 * - 番剧 / 影视类榜单走 pgc 接口，还没做
 * - 字幕：x/player/wbi/v2?bvid=&cid=（签名）→ subtitle.subtitles[].subtitle_url（//aisubtitle.hdslb.com/…，Node 直接取，body=[{from,to,content}]）；
 *   AI 字幕要登录（need_login_subtitle）
 * - AI 总结：x/web-interface/view/conclusion/get?bvid=&cid=&up_mid=（签名）→ model_result.summary / outline；没生成时 model_result 是空的
 * - 热门 x/web-interface/popular；收藏夹 x/v3/fav/folder/created/list-all?up_mid= 和 x/v3/fav/resource/list?media_id=；
 *   历史 x/web-interface/history/cursor（用返回的 cursor.max / view_at 翻页）；关注 x/relation/followings?vmid=（别人的只给前 5 页）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { wbiKey, signQuery } from './_bili-wbi.js'

const API = 'https://api.bilibili.com'
const stripTags = (s = '') => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const time = sec => (sec ? new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16) : undefined)
const dur = s => (typeof s === 'number' ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : s)

/** 接受 BV 号 / av 号 / 视频链接 */
function parseVideo(x) {
  const s = String(x)
  const bv = s.match(/BV[0-9A-Za-z]{10}/)
  if (bv) return { bvid: bv[0] }
  const av = s.match(/(?:^|av)(\d+)$/i)
  if (av) return { aid: Number(av[1]) }
  throw new BxError('BAD_ARGS', `认不出视频：${s}`, '需要 BV 号、av 号或视频链接')
}

function parseMid(x) {
  const s = String(x)
  if (/\/video\/|BV[0-9A-Za-z]{10}/.test(s)) throw new BxError('BAD_ARGS', `这是视频，不是用户：${s}`, '管道里传的是视频记录时，加 --field mid')
  const m = s.match(/(\d+)/)
  if (!m) throw new BxError('BAD_ARGS', `认不出用户：${s}`, '需要 mid 或空间链接 https://space.bilibili.com/<mid>')
  return Number(m[1])
}

const biliTab = () => bx.tab('bilibili.com', { open: 'https://www.bilibili.com' })

async function api(p, params = {}, { sign = false } = {}) {
  const tab = await biliTab()
  const qs = sign ? signQuery(params, await wbiKey(u => tab.fetch(u))) : new URLSearchParams(params).toString()
  const j = await tab.fetch(`${API}/${p}?${qs}`)
  if (j.code === 0) return j.data
  const msg = `B 站接口 ${p} 返回 ${j.code} ${j.message || ''}`
  if (j.code === -101) throw new BxError('NEED_LOGIN', msg, '在浏览器里登录 B 站后重试')
  if ([-352, -412, -799, -509].includes(j.code)) throw new BxError('BLOCKED', msg, '被风控了：停一会儿再试，或者降低频率')
  if ([-404, 62002, 62004, 62012, 12002].includes(j.code)) throw new BxError('NOT_FOUND', msg, '视频 / 用户不存在或已删除，检查参数')
  throw new BxError('API_ERROR', msg)
}

const view = v => api('x/web-interface/view', v)

// 排行榜分区 → [网址里的名字, rid]
const RANK_RID = {
  全部: ['all', 0], 动画: ['douga', 1005], 游戏: ['game', 1008], 鬼畜: ['kichiku', 1007], 音乐: ['music', 1003], 舞蹈: ['dance', 1004],
  影视: ['cinephile', 1001], 娱乐: ['ent', 1002], 知识: ['knowledge', 1010], 科技数码: ['tech', 1012], 美食: ['food', 1020], 汽车: ['car', 1013],
  时尚美妆: ['fashion', 1014], 体育运动: ['sports', 1018], 动物: ['animal', 1024],
}
const PGC_RANK = ['番剧', '国创', '纪录片', '电影', '电视剧', '综艺', 'anime', 'guochuang', 'documentary', 'movie', 'tv', 'variety']

/** 当前浏览器登录的账号
 *  @login required */
export async function me() {
  const tab = await biliTab()
  const d = (await tab.fetch(`${API}/x/web-interface/nav`)).data || {}
  if (!d.isLogin) throw new BxError('NEED_LOGIN', 'B 站没有登录', '在浏览器里打开 bilibili.com 登录后重试')
  return { mid: d.mid, name: d.uname, level: d.level_info?.current_level, vip: d.vipStatus === 1 }
}

/** 搜索视频（type: 'user' 搜用户）。order：totalrank 综合 / click 播放 / pubdate 最新 / dm 弹幕 / stow 收藏
 *  @example search('纪录片', { limit: 10, order: 'click' }) */
export async function search(keyword, { limit = 20, type = 'video', order = 'totalrank' } = {}) {
  const st = type === 'user' ? 'bili_user' : 'video'
  const out = []
  for (let page = 1; out.length < limit && page <= 50; page++) {
    const d = await api('x/web-interface/wbi/search/type', { search_type: st, keyword, page, order }, { sign: true })
    const list = d.result || []
    if (!list.length) break
    for (const r of list) {
      if (st === 'video' && !r.bvid) continue // 课程、专栏这类混进来的结果没有 BV 号
      if (st === 'video')
        out.push({ bvid: r.bvid, title: stripTags(r.title), author: r.author, mid: r.mid, play: r.play, danmaku: r.video_review, duration: r.duration, pubdate: time(r.pubdate), url: `https://www.bilibili.com/video/${r.bvid}` })
      else out.push({ mid: r.mid, name: r.uname, fans: r.fans, videos: r.videos, sign: r.usign, url: `https://space.bilibili.com/${r.mid}` })
      if (out.length >= limit) break
    }
    if (page >= (d.numPages || 1)) break
    await bx.sleep(300)
  }
  if (!out.length) throw new BxError('EMPTY', `没有搜到“${keyword}”`, '换个关键词')
  return out
}

/** 热门排行榜。分区：全部 动画 游戏 鬼畜 音乐 舞蹈 影视 娱乐 知识 科技数码 美食 汽车 时尚美妆 体育运动 动物（也可以写 douga 这种英文）
 *  @example rank('知识', { limit: 10 }) */
export async function rank(category = '全部', { limit = 100 } = {}) {
  const hit = Object.entries(RANK_RID).find(([k, v]) => k === category || v[0] === category)
  if (!hit) {
    if (PGC_RANK.includes(category)) throw new BxError('UNSUPPORTED', `${category} 是番剧/影视类榜单，走的是 pgc 接口，还没支持`)
    throw new BxError('BAD_ARGS', `没有分区“${category}”`, `可选：${Object.keys(RANK_RID).join(' / ')}`)
  }
  const d = await api('x/web-interface/ranking/v2', { rid: hit[1][1], type: 'all', web_location: '333.934' }, { sign: true })
  return (d.list || []).slice(0, limit).map((v, i) => ({
    rank: i + 1,
    bvid: v.bvid,
    title: v.title,
    author: v.owner?.name,
    mid: v.owner?.mid,
    view: v.stat?.view,
    like: v.stat?.like,
    danmaku: v.stat?.danmaku,
    reply: v.stat?.reply,
    duration: dur(v.duration),
    pubdate: time(v.pubdate),
    url: `https://www.bilibili.com/video/${v.bvid}`,
  }))
}

/** 视频详细信息（播放、点赞、分P、简介…）。id 是 BV 号 / av 号 / 视频链接
 *  @example video('BV1GJ411x7h7') */
export async function video(id) {
  const d = await view(parseVideo(id))
  return {
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    owner: { mid: d.owner.mid, name: d.owner.name },
    pubdate: time(d.pubdate),
    duration: dur(d.duration),
    stat: { view: d.stat.view, like: d.stat.like, coin: d.stat.coin, favorite: d.stat.favorite, share: d.stat.share, reply: d.stat.reply, danmaku: d.stat.danmaku },
    tname: d.tname,
    desc: d.desc,
    pages: d.pages.map(p => ({ page: p.page, cid: p.cid, part: p.part, duration: dur(p.duration) })),
    url: `https://www.bilibili.com/video/${d.bvid}`,
  }
}

/** 视频评论。sort：hot 热门 / time 最新
 *  @example comments('BV1GJ411x7h7', { limit: 20 }) */
export async function comments(id, { limit = 50, sort = 'hot' } = {}) {
  const v = parseVideo(id)
  const aid = v.aid || (await view(v)).aid
  const out = []
  let offset = ''
  for (let i = 0; i < 100 && out.length < limit; i++) {
    const d = await api('x/v2/reply/wbi/main', { oid: aid, type: 1, mode: sort === 'time' ? 2 : 3, pagination_str: JSON.stringify({ offset }), plat: 1 }, { sign: true })
    const list = [...(i === 0 ? d.top_replies || [] : []), ...(d.replies || [])]
    for (const r of list) {
      out.push({ bvid: v.bvid, rpid: r.rpid_str, user: r.member.uname, mid: Number(r.mid), text: r.content.message, like: r.like, replies: r.rcount, time: time(r.ctime) })
      if (out.length >= limit) break
    }
    offset = d.cursor?.pagination_reply?.next_offset
    if (!offset || d.cursor?.is_end || !list.length) break
    await bx.sleep(300)
  }
  return out
}

/** 下载视频（DASH 音视频分离，有 ffmpeg 时自动合并）。quality：4k 1080+ 1080 720 480 360（超出账号权限时自动降级）
 *  @example download('BV1GJ411x7h7', { out: './videos', quality: '720' }) */
export async function download(id, { out = '.', quality = '1080', page = 1, audioOnly = false } = {}) {
  const info = await view(parseVideo(id))
  const p = info.pages[page - 1]
  if (!p) throw new BxError('NOT_FOUND', `没有第 ${page} P（共 ${info.pages.length} P）`)
  const qn = { '4k': 120, '1080+': 112, '1080': 80, '720': 64, '480': 32, '360': 16 }[String(quality)]
  if (!qn) throw new BxError('BAD_ARGS', `清晰度只能是 4k 1080+ 1080 720 480 360`)
  const d = await api('x/player/wbi/playurl', { bvid: info.bvid, cid: p.cid, qn, fnval: 4048, fourk: 1 }, { sign: true })
  if (!d.dash) throw new BxError('UNSUPPORTED', '没有拿到 DASH 地址（可能是付费 / 地区限制视频）')
  const vid = d.dash.video.filter(x => x.id <= qn).sort((a, b) => b.id - a.id || b.bandwidth - a.bandwidth)[0] || d.dash.video[0]
  const audio = [...(d.dash.audio || []), ...(d.dash.flac?.audio ? [d.dash.flac.audio] : [])].sort((a, b) => b.bandwidth - a.bandwidth)[0]
  const cookie = (await (await biliTab()).cookies('https://www.bilibili.com')).map(c => `${c.name}=${c.value}`).join('; ')
  const safe = s => s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  const dir = path.resolve(out)
  fs.mkdirSync(dir, { recursive: true })
  const base = path.join(dir, safe(`${info.title}${info.pages.length > 1 ? ` P${p.page} ${p.part}` : ''} [${info.bvid}]`))

  const get = async (url, file, label) => {
    const res = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0', Cookie: cookie } })
    if (!res.ok) throw new BxError('DOWNLOAD_FAILED', `下载失败 ${res.status}：${label}`)
    const total = Number(res.headers.get('content-length')) || 0
    const ws = fs.createWriteStream(file)
    let got = 0
    let last = 0
    for await (const chunk of res.body) {
      ws.write(chunk)
      got += chunk.length
      if (Date.now() - last > 500) {
        last = Date.now()
        process.stderr.write(`\r${label} ${(got / 1e6).toFixed(1)}MB${total ? ` / ${(total / 1e6).toFixed(1)}MB` : ''}   `)
      }
    }
    await new Promise(r => ws.end(r))
    process.stderr.write(`\r${label} ${(got / 1e6).toFixed(1)}MB 完成            \n`)
    return got
  }

  const qdesc = d.accept_description?.[d.accept_quality?.indexOf(vid.id)] || vid.id
  if (audioOnly) {
    const file = base + '.m4a'
    const size = await get(audio.baseUrl || audio.base_url, file, '音频')
    return { bvid: info.bvid, title: info.title, file, size }
  }
  const vf = base + '.video.m4s'
  const af = base + '.audio.m4s'
  await get(vid.baseUrl || vid.base_url, vf, `视频(${qdesc})`)
  if (audio) await get(audio.baseUrl || audio.base_url, af, '音频')
  const mp4 = base + '.mp4'
  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vf, ...(audio ? ['-i', af] : []), '-c', 'copy', mp4], { stdio: ['ignore', 'ignore', 'pipe'] })
  if (ff.status === 0) {
    fs.rmSync(vf, { force: true })
    fs.rmSync(af, { force: true })
    return { bvid: info.bvid, title: info.title, quality: qdesc, file: mp4, size: fs.statSync(mp4).size }
  }
  return { bvid: info.bvid, title: info.title, quality: qdesc, files: [vf, af], note: '没找到 ffmpeg（或合并失败），音视频是分开的文件：ffmpeg -i 视频 -i 音频 -c copy out.mp4' }
}

/** UP 主信息。mid 或空间链接
 *  @example user(486906719) */
export async function user(mid) {
  const id = parseMid(mid)
  const d = await api('x/web-interface/card', { mid: id })
  const c = d.card
  return { mid: id, name: c.name, sign: c.sign, level: c.level_info?.current_level, fans: d.follower, following: c.attention, videos: d.archive_count, likes: d.like_num, url: `https://space.bilibili.com/${id}` }
}

/** UP 主的投稿视频。order：pubdate 最新 / click 最多播放 / stow 最多收藏
 *  @example videos(486906719, { limit: 10 }) */
export async function videos(mid, { limit = 30, order = 'pubdate' } = {}) {
  const id = parseMid(mid)
  const out = []
  for (let pn = 1; out.length < limit && pn <= 100; pn++) {
    const d = await api(
      'x/space/wbi/arc/search',
      { mid: id, pn, ps: 30, order, dm_img_list: '[]', dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ', dm_cover_img_str: 'QU5HTEUgKEludGVsKQ', dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}' },
      { sign: true },
    )
    const list = d.list?.vlist || []
    for (const v of list) {
      out.push({ bvid: v.bvid, title: v.title, play: v.play, comment: v.comment, length: v.length, created: time(v.created), url: `https://www.bilibili.com/video/${v.bvid}` })
      if (out.length >= limit) break
    }
    if (!list.length || pn * 30 >= (d.page?.count || 0)) break
    await bx.sleep(400)
  }
  return out
}

/** UP 主动态
 *  @example dynamics(486906719, { limit: 10 }) */
export async function dynamics(mid, { limit = 20 } = {}) {
  const id = parseMid(mid)
  const out = []
  let offset = ''
  for (let i = 0; i < 50 && out.length < limit; i++) {
    const d = await api('x/polymer/web-dynamic/v1/feed/space', { host_mid: id, offset, features: 'itemOpusStyle' }, { sign: true })
    for (const it of d.items || []) {
      const m = it.modules || {}
      const dyn = m.module_dynamic || {}
      const major = dyn.major || {}
      const text = dyn.desc?.text || major.opus?.summary?.text || ''
      const x = { id: it.id_str, type: it.type.replace('DYNAMIC_TYPE_', '').toLowerCase(), time: m.module_author?.pub_time, text: text.slice(0, 500) }
      if (major.archive) Object.assign(x, { bvid: major.archive.bvid, title: major.archive.title })
      if (major.opus?.title) x.title = major.opus.title
      x.url = `https://t.bilibili.com/${it.id_str}`
      out.push(x)
      if (out.length >= limit) break
    }
    if (!d.has_more) break
    offset = d.offset
    await bx.sleep(400)
  }
  return out
}

/** 视频页的读法：标题、UP、数据、简介、标签、分P；分段 comments（按热度）/ related（相关推荐） */
export async function read(tab, { section, limit = 20 } = {}) {
  if (!/\/video\//.test(await tab.url())) return null // 别的页面交给通用提取
  for (let i = 0; i < 25 && !(await tab.eval(() => !!window.__INITIAL_STATE__?.videoData)); i++) await bx.sleep(200)
  const s = await tab.eval(() => {
    const st = window.__INITIAL_STATE__
    if (!st?.videoData) return null
    const v = st.videoData
    return {
      v: { bvid: v.bvid, aid: v.aid, title: v.title, desc: v.desc, duration: v.duration, pubdate: v.pubdate, owner: v.owner, stat: v.stat, pages: v.pages },
      tags: (st.tags || []).map(x => x.tag_name),
      related: (st.related || []).map(r => ({ title: r.title, bvid: r.bvid, author: r.owner?.name, view: r.stat?.view })),
    }
  })
  if (!s) return null
  const { v } = s
  if (section === 'comments') {
    const list = await comments(v.bvid, { limit })
    const lines = list.map(c => `- **${c.user}**（👍${c.like}${c.replies ? ` · ${c.replies} 回复` : ''}）：${c.text.replace(/\n+/g, ' ')}`)
    return { title: v.title, section, content: lines.join('\n'), range: [0, lines.length], total: v.stat.reply }
  }
  if (section === 'related') {
    const lines = s.related.map(r => `- ${r.title}（${r.author} · 播放 ${r.view}）https://www.bilibili.com/video/${r.bvid}`)
    return { title: v.title, section, content: lines.join('\n'), range: [0, lines.length], total: lines.length }
  }
  if (section) throw new BxError('BAD_ARGS', `没有分段 ${section}`, '可用：comments, related')
  const out = {
    title: v.title,
    type: 'video',
    meta: { author: v.owner.name, published: time(v.pubdate), site: '哔哩哔哩' },
    video: {
      bvid: v.bvid,
      duration: dur(v.duration),
      up: `${v.owner.name} (mid ${v.owner.mid})`,
      stat: `播放 ${v.stat.view} · 点赞 ${v.stat.like} · 投币 ${v.stat.coin} · 收藏 ${v.stat.favorite} · 评论 ${v.stat.reply} · 弹幕 ${v.stat.danmaku}`,
      tags: s.tags.join(' / ') || undefined,
    },
    content: v.desc || '(无简介)',
    sections: [
      { id: 'comments', title: `评论（${v.stat.reply} 条，按热度）`, chars: '按需加载' },
      { id: 'related', title: `相关推荐（${s.related.length} 个）` },
    ],
  }
  if (v.pages?.length > 1) out.items = v.pages.map(p => ({ title: `P${p.page} ${p.part}`, text: dur(p.duration) }))
  return out
}


/** 视频字幕（CC 字幕或 AI 字幕），按时间一句一行。lang 不写取第一个（常见 zh-CN、ai-zh、en-US）；page 是分 P
 *  @login optional 不登录多半拿不到 AI 字幕
 *  @example subtitles('BV1GJ411x7h7')
 *  @example subtitles('BV1GJ411x7h7', { lang: 'ai-zh', text: true }) */
export async function subtitles(id, { lang = '', page = 1, text = false } = {}) {
  const v = await view(parseVideo(id))
  const cid = v.pages?.[page - 1]?.cid || v.cid
  const d = await api('x/player/wbi/v2', { bvid: v.bvid, cid }, { sign: true })
  const list = d.subtitle?.subtitles || []
  if (!list.length) throw new BxError('EMPTY', `${v.bvid} 没有字幕`, d.need_login_subtitle ? '要登录才能看 AI 字幕：请用户在浏览器里登录 B 站' : '这个视频没有 CC / AI 字幕；可以试试 summary 看 AI 总结')
  const s = (lang && list.find(x => x.lan === lang)) || list[0]
  if (!s.subtitle_url) throw new BxError('NEED_LOGIN', '字幕地址是空的（没登录或被风控）', '在浏览器里登录 B 站后重试')
  const r = await fetch(s.subtitle_url.replace(/^\/\//, 'https://'))
  const j = await r.json().catch(() => null)
  if (!Array.isArray(j?.body)) throw new BxError('CHANGED', '字幕文件格式变了', s.subtitle_url)
  const ts = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  if (text) return { bvid: v.bvid, title: v.title, lang: s.lan, langs: list.map(x => x.lan).join(','), text: j.body.map(x => x.content).join('\n') }
  return j.body.map(x => ({ time: ts(x.from), to: ts(x.to), text: x.content, lang: s.lan }))
}

/** B 站官方的 AI 视频总结：一段摘要 + 带时间点的提纲
 *  @example summary('BV1gTHd6aE5e') */
export async function summary(id, { page = 1 } = {}) {
  const v = await view(parseVideo(id))
  const cid = v.pages?.[page - 1]?.cid || v.cid
  const d = await api('x/web-interface/view/conclusion/get', { bvid: v.bvid, cid, up_mid: v.owner?.mid }, { sign: true })
  const m = d.model_result
  if (!m || (!m.summary && !m.outline?.length)) throw new BxError('EMPTY', `${v.bvid} 还没有 AI 总结`, '可以试试 subtitles 取字幕')
  const ts = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  return {
    bvid: v.bvid,
    title: v.title,
    summary: m.summary,
    outline: (m.outline || []).map(o => `[${ts(o.timestamp)}] ${o.title}${o.part_outline?.length ? '\n' + o.part_outline.map(p => `  [${ts(p.timestamp)}] ${p.content}`).join('\n') : ''}`).join('\n'),
    url: `https://www.bilibili.com/video/${v.bvid}`,
  }
}

const vidOf = x => ({
  bvid: x.bvid,
  title: x.title,
  author: x.owner?.name || x.upper?.name || x.author_name,
  mid: x.owner?.mid || x.upper?.mid,
  play: x.stat?.view ?? x.cnt_info?.play,
  danmaku: x.stat?.danmaku ?? x.cnt_info?.danmaku,
  likes: x.stat?.like,
  duration: dur(x.duration),
  pubdate: time(x.pubdate || x.pubtime),
  reason: x.rcmd_reason?.content || undefined,
  url: `https://www.bilibili.com/video/${x.bvid}`,
})

/** 综合热门（首页“热门”栏目，不分区）。分区排行用 rank
 *  @example hot({ limit: 20 }) */
export async function hot({ limit = 20 } = {}) {
  const out = []
  for (let pn = 1; out.length < limit && pn <= 10; pn++) {
    const d = await api('x/web-interface/popular', { ps: 20, pn })
    out.push(...(d.list || []).map(vidOf))
    if (d.no_more || !d.list?.length) break
    await bx.sleep(300)
  }
  return out.slice(0, limit)
}

/** 收藏夹列表（不写 mid = 自己的）
 *  @login optional 看自己的收藏夹要登录；别人的只能看公开的
 *  @example favorites() */
export async function favorites(mid = '') {
  const up = mid ? parseMid(mid) : (await me()).mid
  const d = await api('x/v3/fav/folder/created/list-all', { up_mid: up })
  return (d?.list || []).map(f => ({ id: f.id, title: f.title, count: f.media_count, url: `https://space.bilibili.com/${up}/favlist?fid=${f.id}` }))
}

/** 收藏夹里的视频。folder 是 favorites() 结果里的 id 或 favlist?fid= 链接；不写 = 自己的默认收藏夹
 *  @login optional 不写 folder 要登录；别人的收藏夹对方公开了才看得到
 *  @example favoriteVideos('', { limit: 50 }) */
export async function favoriteVideos(folder = '', { limit = 40 } = {}) {
  const s = String(folder)
  const id = folder ? (s.match(/fid=(\d+)/) || s.match(/^\s*(\d+)\s*$/))?.[1] : String((await favorites())[0]?.id || '')
  if (!id) throw new BxError('BAD_ARGS', `认不出收藏夹：${folder}`, '传 favorites() 结果里的 id，或 favlist?fid= 链接')
  const out = []
  for (let pn = 1; out.length < limit && pn <= 50; pn++) {
    const d = await api('x/v3/fav/resource/list', { media_id: id, pn, ps: 20, platform: 'web' })
    if (pn === 1) {
      // 别人设了“隐藏收藏”时，接口照样回 code 0 和收藏夹信息（有 media_count），但 medias 是 null
      const info = d?.info
      if (!info) throw new BxError('NOT_FOUND', `收藏夹 ${id} 不存在`, '用 favorites(mid) 查真实的收藏夹 id')
      if (!d.medias && info.media_count > 0) {
        throw new BxError('NOT_FOUND', `收藏夹「${info.title}」（${info.upper?.name || info.mid} 的，共 ${info.media_count} 条）看不到内容：对方没公开收藏`, '对方设了隐藏收藏，只能看公开的收藏夹；换一个 favorites(mid) 里的 id')
      }
    }
    out.push(...(d.medias || []).filter(m => m.bvid).map(m => ({ ...vidOf(m), faved: time(m.fav_time) })))
    if (!d.has_more) break
    await bx.sleep(300)
  }
  return out.slice(0, limit)
}

/** 自己的观看历史（最近看的在前）
 *  @login required
 *  @example history({ limit: 30 }) */
export async function history({ limit = 30 } = {}) {
  const out = []
  let max = 0
  let viewAt = 0
  for (let i = 0; out.length < limit && i < 20; i++) {
    const d = await api('x/web-interface/history/cursor', { ps: 30, max, view_at: viewAt, business: '' })
    for (const x of d.list || []) {
      const bvid = x.history?.bvid
      out.push({ title: x.title, author: x.author_name, mid: x.author_mid, viewed: time(x.view_at), progress: x.progress === -1 ? '看完' : dur(x.progress), duration: dur(x.duration), type: x.history?.business, url: bvid ? `https://www.bilibili.com/video/${bvid}` : x.uri || undefined, bvid: bvid || undefined })
    }
    if (!d.list?.length || !d.cursor?.max) break
    ;({ max, view_at: viewAt } = d.cursor)
    await bx.sleep(300)
  }
  return out.slice(0, limit)
}

/** 关注列表（不写 mid = 自己的；别人的 B 站只给前 5 页、而且对方可能设了隐私）
 *  @login optional
 *  @example following() */
export async function following(mid = '', { limit = 100 } = {}) {
  const up = mid ? parseMid(mid) : (await me()).mid
  const out = []
  for (let pn = 1; out.length < limit && pn <= 20; pn++) {
    let d
    try {
      d = await api('x/relation/followings', { vmid: up, pn, ps: 50, order: 'desc' })
    } catch (e) {
      if (out.length && /22115|2207|前5页/.test(e.message)) break
      throw e
    }
    out.push(...(d.list || []).map(u => ({ mid: u.mid, name: u.uname, sign: u.sign || undefined, followed: time(u.mtime), url: `https://space.bilibili.com/${u.mid}` })))
    if ((d.list || []).length < 50) break
    await bx.sleep(300)
  }
  return out.slice(0, limit)
}