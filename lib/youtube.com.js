/* 站点笔记（YouTube）：
 * - 页面数据在 window.ytInitialData（频道 / 搜索 / 视频页）和 window.ytInitialPlayerResponse（视频页播放信息）
 * - 内部接口 InnerTube：POST /youtubei/v1/{browse,search,player,next}?prettyPrint=false，
 *   body 带 { context: ytcfg.get('INNERTUBE_CONTEXT'), ... }。在任意 youtube.com 标签里用页面的 fetch 发就行（带登录态，会员视频也看得到元数据）
 * - 翻页：列表最后一项是 continuationItemRenderer，拿 continuationCommand.token 再 POST browse / search { continuation }
 * - 频道视频列表（2026）是 richItemRenderer.content.lockupViewModel：
 *     标题 metadata.lockupMetadataViewModel.title.content
 *     播放量 / 发布时间在 metadataRows[].metadataParts[].text.content（会员视频没有播放量）
 *     会员专享：badgeViewModel.badgeStyle === 'BADGE_MEMBERS_ONLY'；时长：contentImage 里 thumbnailBadgeViewModel.text
 *   Shorts 是 shortsLockupViewModel（overlayMetadata.primaryText / secondaryText）
 * - 搜索结果还是老的 videoRenderer（另有 channelRenderer、lockupViewModel = 播放列表）
 * - 频道“关于”：页头 description 里的 continuationCommand.token → POST browse → aboutChannelViewModel
 *   （joinedDateText 注册日期、viewCountText 总播放、country、links）
 * - 文字跟着浏览器语言走（zh-CN 是“7.3万次观看”“9个月前”），viewCount 字段把中英文的数字统一解析成整数
 * - 评论还没做（要走 /next 接口 + 评论区的 continuation，参数多）
 */

/** 在页面里执行的全部逻辑：op 选功能，a 是参数。函数会被序列化，所以所有辅助函数都写在里面 */
async function yt(op, a) {
  const cfg = window.ytcfg
  const api = async (ep, body) => {
    const r = await fetch(`/youtubei/v1/${ep}?prettyPrint=false`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: cfg.get('INNERTUBE_CONTEXT'), ...body }),
    })
    if (!r.ok) throw new Error(`${ep} ${r.status}`)
    return r.json()
  }
  const find = (o, key, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 40) return undefined
    if (key in o) return o[key]
    for (const v of Object.values(o)) {
      const x = find(v, key, depth + 1)
      if (x !== undefined) return x
    }
  }
  const findAll = (o, key, out = [], depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 40) return out
    for (const [k, v] of Object.entries(o)) {
      if (k === key) out.push(v)
      else findAll(v, key, out, depth + 1)
    }
    return out
  }
  const text = t => (t == null ? undefined : typeof t === 'string' ? t : t.content ?? t.simpleText ?? (t.runs ? t.runs.map(r => r.text).join('') : undefined))
  /** “7.3万次观看”“155,496次观看”“1.2M views”“14.2万位订阅者” → 整数 */
  const count = s => {
    if (!s) return undefined
    const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([万亿KMB]?)/i)
    if (!m) return undefined
    const mul = { 万: 1e4, 亿: 1e8, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1
    return Math.round(parseFloat(m[1]) * mul)
  }
  const isViews = s => /观看|觀看|views?\b|次播放/i.test(s)
  const isTime = s => /前|ago|直播|streamed|premiered|首播/i.test(s)
  const contToken = list => list?.at?.(-1)?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token

  /** 频道列表里的一项（lockupViewModel / shortsLockupViewModel / 老的 videoRenderer）→ 统一结构 */
  const item = x => {
    const c = x.richItemRenderer?.content || x
    if (c.lockupViewModel) {
      const l = c.lockupViewModel
      const md = l.metadata?.lockupMetadataViewModel
      const parts = (md?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap(r => r.metadataParts || []).map(p => p.accessibilityLabel || text(p.text)).filter(Boolean)
      const badges = findAll(md, 'badgeViewModel')
      const dur = findAll(l.contentImage, 'thumbnailBadgeViewModel').map(b => b.text).find(t => /^\d+(:\d+)+$/.test(t || ''))
      const views = parts.find(isViews)
      const kind = /PLAYLIST|PODCAST/.test(l.contentType || '') || /^(PL|OL|VL)/.test(l.contentId || '') ? (/PODCAST/.test(l.contentType || '') ? 'podcast' : 'playlist') : 'video'
      return {
        kind,
        id: l.contentId,
        url: kind === 'video' ? `https://www.youtube.com/watch?v=${l.contentId}` : `https://www.youtube.com/playlist?list=${l.contentId}`,
        title: text(md?.title),
        duration: dur,
        views: kind === 'video' ? views : undefined,
        viewCount: kind === 'video' ? count(views) : undefined,
        published: parts.find(isTime),
        members: badges.some(b => b.badgeStyle === 'BADGE_MEMBERS_ONLY') || undefined,
      }
    }
    if (c.shortsLockupViewModel) {
      const s = c.shortsLockupViewModel
      const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || s.entityId?.replace(/^shorts-shelf-item-/, '')
      const views = text(s.overlayMetadata?.secondaryText)
      return { kind: 'short', id, url: `https://www.youtube.com/shorts/${id}`, title: text(s.overlayMetadata?.primaryText), views, viewCount: count(views) }
    }
    if (c.videoRenderer) {
      const v = c.videoRenderer
      const views = text(v.viewCountText)
      return {
        kind: 'video',
        id: v.videoId,
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        title: text(v.title),
        channel: text(v.ownerText),
        channelUrl: v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ? 'https://www.youtube.com' + v.ownerText.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl : undefined,
        duration: text(v.lengthText),
        views,
        viewCount: count(views),
        published: text(v.publishedTimeText),
        members: (v.badges || []).some(b => /MEMBERS/i.test(b.metadataBadgeRenderer?.style || '')) || undefined,
        snippet: (v.detailedMetadataSnippets || []).map(s => text(s.snippetText)).join(' ') || undefined,
      }
    }
    if (c.channelRenderer) {
      const ch = c.channelRenderer
      const base = ch.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl
      return { kind: 'channel', id: ch.channelId, url: base ? 'https://www.youtube.com' + base : `https://www.youtube.com/channel/${ch.channelId}`, title: text(ch.title), subscribers: text(ch.videoCountText) || text(ch.subscriberCountText), snippet: text(ch.descriptionSnippet) }
    }
    return null
  }

  if (op === 'channel') {
    const d = window.ytInitialData
    const meta = d.metadata?.channelMetadataRenderer || {}
    const header = d.header?.pageHeaderRenderer?.content?.pageHeaderViewModel
    const rows = (header?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap(r => r.metadataParts || []).map(p => text(p.text))
    const out = {
      id: meta.externalId,
      title: meta.title,
      handle: rows.find(r => r?.startsWith('@')),
      url: meta.vanityChannelUrl?.replace('http://', 'https://') || location.href.replace(/\/(videos|featured|streams|shorts|about)\/?$/, ''),
      subscribers: rows.find(r => /订阅|訂閱|subscriber/i.test(r || '')),
      videos: rows.find(r => /视频|影片|video/i.test(r || '')),
      description: meta.description,
      keywords: meta.keywords || undefined,
      avatar: meta.avatar?.thumbnails?.at(-1)?.url,
    }
    out.subscriberCount = count(out.subscribers)
    out.videoCount = count(out.videos)
    const tok = find(header?.description, 'continuationCommand')?.token || find(header, 'continuationCommand')?.token
    if (tok) {
      try {
        const ab = find(await api('browse', { continuation: tok }), 'aboutChannelViewModel')
        if (ab) {
          out.joined = text(ab.joinedDateText)
          out.views = text(ab.viewCountText)
          out.viewCount = count(out.views)
          out.country = ab.country || undefined
          out.subscribers ||= text(ab.subscriberCountText)
          out.links = (ab.links || []).map(l => l.channelExternalLinkViewModel).filter(Boolean).map(l => ({ title: text(l.title), url: text(l.link) }))
          if (!out.links.length) delete out.links
        }
      } catch (e) {
        out.aboutError = String(e.message || e)
      }
    }
    return out
  }

  if (op === 'list') {
    // 频道某个 tab 的列表：先读页面数据，不够就用 continuation 翻页
    const d = window.ytInitialData
    const tabs = d.contents?.twoColumnBrowseResultsRenderer?.tabs || []
    const sel = tabs.find(t => t.tabRenderer?.selected)?.tabRenderer
    let list = sel?.content?.richGridRenderer?.contents || find(sel?.content, 'contents') || []
    const out = []
    for (let page = 0; page < 50; page++) {
      for (const x of list) {
        const it = item(x)
        if (it && it.id && !out.some(o => o.id === it.id)) out.push(it)
      }
      const tok = contToken(list)
      if (out.length >= a.limit || !tok) break
      const j = await api('browse', { continuation: tok })
      list = find(j, 'continuationItems') || []
      if (!list.length) break
    }
    return { tab: sel?.title, items: out.slice(0, a.limit) }
  }

  if (op === 'search') {
    let j = await api('search', { query: a.q, ...(a.params ? { params: a.params } : {}) })
    let sec = find(j, 'sectionListRenderer')?.contents || []
    const out = []
    for (let page = 0; page < 10; page++) {
      for (const s of sec) for (const x of s.itemSectionRenderer?.contents || []) {
        const it = item(x)
        if (it && it.id && !out.some(o => o.id === it.id)) out.push(it)
      }
      const tok = contToken(sec)
      if (out.length >= a.limit || !tok) break
      j = await api('search', { continuation: tok })
      sec = find(j, 'continuationItems') || []
      if (!sec.length) break
    }
    return out.slice(0, a.limit)
  }

  if (op === 'video') {
    // player 给播放信息（时长、播放量、发布时间、点赞）；next 给完整简介。
    // 注意：不带播放令牌时 player 对普通视频也常回 UNPLAYABLE“视频无法播放”，所以只认明确的原因（会员 / 地区 / 私享 / 年龄）
    const [p, n] = await Promise.all([
      api('player', { videoId: a.id, contentCheckOk: true, racyCheckOk: true }),
      api('next', { videoId: a.id }).catch(() => null),
    ])
    const vd = p.videoDetails || {}
    const mf = p.microformat?.playerMicroformatRenderer || {}
    const ps = p.playabilityStatus || {}
    if (!vd.videoId && !n && ps.status === 'ERROR') return { error: ps.reason || 'ERROR' }
    const reason = [ps.reason, text(ps.errorScreen?.playerErrorMessageRenderer?.subreason)].filter(Boolean).join(' ')
    const members = /会员|會員|member/i.test(reason) || undefined
    const restricted = !members && ps.status !== 'OK' && /地区|地區|country|region|私享|private|年龄|age|删除|removed|terminated/i.test(reason) ? reason : undefined
    const sec = +vd.lengthSeconds || +mf.lengthSeconds || 0
    const hms = sec ? [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map((n, i) => (i ? String(n).padStart(2, '0') : n)).join(':').replace(/^0:/, '') : undefined
    const nextDesc = find(n, 'attributedDescription')?.content
    return {
      id: vd.videoId || a.id,
      url: `https://www.youtube.com/watch?v=${vd.videoId || a.id}`,
      title: vd.title || text(mf.title) || text(find(n, 'videoPrimaryInfoRenderer')?.title),
      channel: vd.author || mf.ownerChannelName,
      channelId: vd.channelId || mf.externalChannelId,
      channelUrl: mf.ownerProfileUrl?.replace('http://', 'https://'),
      duration: hms,
      seconds: sec || undefined,
      viewCount: vd.viewCount ? +vd.viewCount : mf.viewCount ? +mf.viewCount : undefined,
      likeCount: mf.likeCount ? +mf.likeCount : undefined,
      published: mf.publishDate || text(find(n, 'dateText')),
      category: mf.category,
      live: vd.isLiveContent || undefined,
      members,
      restricted,
      keywords: vd.keywords,
      description: (nextDesc && nextDesc.length >= (vd.shortDescription || '').trim().length ? nextDesc : vd.shortDescription) || text(mf.description),
    }
  }
  throw new Error('unknown op ' + op)
}

// ---------------- 工具 ----------------

/** 任意一个 youtube.com 标签（复用已打开的，带登录态）；只用来发接口请求，不会跳转它 */
const anyTab = () => bx.tab('youtube.com', { open: 'https://www.youtube.com/' })

/** '@doctorx2023' / 'doctorx2023' / 'UCxxxx' / 频道网址 → 频道首页网址 */
function channelUrl(h) {
  h = String(h).trim()
  if (/^https?:\/\//.test(h)) return h.replace(/\/(videos|featured|streams|shorts|about|podcasts|playlists)\/?$/, '').replace(/\/$/, '')
  if (/^UC[\w-]{22}$/.test(h)) return `https://www.youtube.com/channel/${h}`
  return `https://www.youtube.com/@${h.replace(/^@/, '')}`
}

/** 'dQw4w9WgXcQ' / watch?v= / youtu.be / shorts 网址 → 视频 id */
function videoId(v) {
  v = String(v).trim()
  const m = v.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/) || v.match(/^([\w-]{11})$/)
  if (!m) throw new BxError('BAD_ARGS', `看不出视频 id：${v}`, "传 11 位 id 或视频网址，如 'dQw4w9WgXcQ'")
  return m[1]
}

/** 后台开一个频道页，等 ytInitialData 出来，在里面执行 op，结束关掉 */
async function onChannelPage(url, op, arg) {
  const tab = await bx.open(url)
  try {
    await tab.waitFor({ fn: 'window.ytInitialData && window.ytcfg && window.ytcfg.get("INNERTUBE_CONTEXT")', timeout: 20000 }).catch(() => {})
    const ok = await tab.eval(() => !!(window.ytInitialData?.metadata?.channelMetadataRenderer))
    if (!ok) {
      const t = await tab.eval(() => document.title)
      throw new BxError('NOT_FOUND', `频道打不开：${url}（页面标题：${t}）`, '检查频道 handle / id；handle 区分不了大小写时直接传频道网址')
    }
    return await tab.eval(yt, op, arg)
  } finally {
    if (!process.env.BX_KEEP_TABS) await tab.close().catch(() => {})
  }
}

// ---------------- 函数 ----------------

/** 频道信息：名称、handle、订阅数、视频数、总播放、注册日期、国家、简介、外链
 *  @example channel('@doctorx2023') */
export async function channel(handle) {
  return onChannelPage(channelUrl(handle), 'channel')
}

/** 频道的视频列表（新的在前）：标题、时长、播放量、发布时间、是否会员专享。tab：videos / streams / shorts / podcasts
 *  @example videos('@doctorx2023', { limit: 100 })
 *  @example videos('@doctorx2023', { tab: 'streams' }) */
export async function videos(handle, { limit = 30, tab = 'videos' } = {}) {
  const r = await onChannelPage(`${channelUrl(handle)}/${tab}`, 'list', { limit })
  if (!r.items.length) throw new BxError('EMPTY', `频道 ${handle} 的 ${tab} 下没有内容`, "换个 tab：videos / streams / shorts / podcasts")
  return r.items.map((it, i) => ({ rank: i + 1, ...it }))
}

/** 视频详情：标题、频道、时长、播放量、点赞数、发布日期、分类、标签、完整简介；members / restricted 标出会员专享、地区 / 年龄限制
 *  @example video('0Ch3BmsWJYo') */
export async function video(idOrUrl) {
  const id = videoId(idOrUrl)
  const t = await anyTab()
  await t.waitFor({ fn: 'window.ytcfg && window.ytcfg.get("INNERTUBE_CONTEXT")', timeout: 15000 }).catch(() => {})
  const r = await t.eval(yt, 'video', { id })
  if (r.error) throw new BxError('NOT_FOUND', `视频 ${id} 拿不到：${r.error}`, '检查 id；私享 / 已删除的视频拿不到')
  return r
}

/** 搜视频（也会混进频道、播放列表，kind 字段区分）。type：'video' 只要视频
 *  @example search('X博士 大玄学', { limit: 20 })
 *  @example search('sqlite tutorial', { type: 'video', limit: 50 }) */
export async function search(q, { limit = 20, type = '' } = {}) {
  const t = await anyTab()
  await t.waitFor({ fn: 'window.ytcfg && window.ytcfg.get("INNERTUBE_CONTEXT")', timeout: 15000 }).catch(() => {})
  // EgIQAQ== 是搜索筛选“类型：视频”的 params
  const items = await t.eval(yt, 'search', { q, limit: type === 'video' ? limit * 2 : limit, params: type === 'video' ? 'EgIQAQ%3D%3D' : undefined })
  const out = (type === 'video' ? items.filter(x => x.kind === 'video') : items).slice(0, limit).map((it, i) => ({ rank: i + 1, ...it }))
  if (!out.length) throw new BxError('EMPTY', `YouTube 没有搜到“${q}”`, '换个关键词')
  return out
}

/** bx read 打开 YouTube 网址时用：频道页给频道信息 + 最近视频，视频页给详情；其他页面交给通用提取 */
export async function read(tab, { limit = 30 } = {}) {
  const url = await tab.url()
  if (/\/(watch|shorts\/|live\/)/.test(url) || /youtu\.be\//.test(url)) {
    const v = await tab.eval(yt, 'video', { id: videoId(url) })
    if (v.error) return null
    const { description, ...rest } = v
    return { type: 'video', title: v.title, meta: { author: v.channel, published: v.published, site: 'YouTube' }, ...rest, content: description }
  }
  if (/youtube\.com\/(@|channel\/|c\/)/.test(url)) {
    await tab.waitFor({ fn: 'window.ytInitialData', timeout: 15000 }).catch(() => {})
    const ch = await tab.eval(yt, 'channel')
    if (!ch?.id) return null
    const list = await tab.eval(yt, 'list', { limit }).catch(() => ({ items: [] }))
    const { description, ...rest } = ch
    return {
      type: 'list',
      title: ch.title,
      meta: { site: 'YouTube', description },
      channel: rest,
      items: list.items.map(it => Object.fromEntries(Object.entries({ title: it.title, url: it.url, duration: it.duration, views: it.views, published: it.published, members: it.members }).filter(([, v]) => v !== undefined))),
    }
  }
  return null
}
