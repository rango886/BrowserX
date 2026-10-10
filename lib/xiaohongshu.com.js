/* 站点笔记（小红书）：
 * @login required 没登录时搜索页只显示登录框，笔记详情也经常要登录
 * - 接口都要 x-s / x-t 签名，自己发不了。做法是让页面自己发请求，用 tab.collect 接住返回：
 *     搜索 so.xiaohongshu.com/api/sns/web/v2/search/notes（打开 /search_result?keyword= 后，滚到底触发下一页，每页约 20 条）
 *     评论 /api/sns/web/v2/comment/page（打开笔记页后，滚动 .note-scroller 触发翻页）
 *     用户笔记 /api/sns/web/v1/user_posted（打开 /user/profile/<id> 后滚动）
 * - collect 之前要先 tab.c('net.mark') 打开网络记录，再跳转（不然首屏请求记不到）
 * - 打开笔记必须带 xsec_token（搜索结果里每条都有），不带会跳到 404 / 安全限制页。所以返回的 url 都带着它
 * - 笔记正文在 window.__INITIAL_STATE__.note.noteDetailMap[id].note（Vue 响应式对象，要先 JSON 序列化再返回，不然报 “Object reference chain is too long”）
 * - 数字字段是字符串，“1.2万”这种要换算
 * - 发布时间：搜索结果只有 corner_tag_info 里的 “08-14 / 3天前”；详情里 time 是毫秒时间戳
 */

const num = s => {
  const t = String(s ?? '').trim()
  if (!t) return undefined
  if (/万/.test(t)) return Math.round(parseFloat(t) * 1e4)
  return Number(t.replace(/[^\d.]/g, '')) || 0
}
const ms = t => (t ? new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined)
const noteUrl = (id, token, source = 'pc_search') => `https://www.xiaohongshu.com/explore/${id}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=${source}` : ''}`

async function openRecording(url) {
  const tab = await bx.open('about:blank')
  await tab.c('net.mark')
  await tab.goto(url)
  return tab
}

async function checkWall(tab) {
  const s = await tab.eval(() => ({
    login: !!document.querySelector('.login-container, .login-modal') || /登录后查看/.test(document.body.innerText.slice(0, 3000)),
    blocked: /安全限制|访问频繁|验证/.test(document.title + (document.querySelector('.error-container, .verify-container')?.innerText || '')) || /website-login\/captcha|\/404/.test(location.href),
    url: location.href,
  }))
  if (s.blocked) throw new BxError('BLOCKED', `小红书拦截了：${s.url}`, `可能是验证码或缺 xsec_token；bx tab activate ${tab.id} 看看`)
  if (s.login) throw new BxError('NEED_LOGIN', '小红书没有登录', '在浏览器里打开 xiaohongshu.com 登录后重试')
}

/** 搜笔记。sort：general 综合 / time_descending 最新 / popularity_descending 最热；返回的 url 带 xsec_token，可以直接传给 note / comments
 *  @example search('SQLite', { limit: 20 }) */
export async function search(q, { limit = 20, sort = 'general' } = {}) {
  const tab = await openRecording(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}&source=web_search_result_notes${sort !== 'general' ? `&sort=${sort}` : ''}`)
  const out = []
  const seen = new Set()
  try {
    const scroll = async () => {
      await tab.scroll('bottom')
      await bx.sleep(600)
      await tab.scroll('up', { amount: 300 })
      await tab.scroll('bottom')
    }
    for await (const page of tab.collect('/api/sns/web/v2/search/notes', { past: true, more: scroll, timeout: 7000 })) {
      if (page?.code !== 0) {
        if (page?.code === -100 || page?.code === -101) throw new BxError('NEED_LOGIN', '小红书没有登录', '在浏览器里登录 xiaohongshu.com 后重试')
        throw new BxError('BLOCKED', `小红书搜索接口返回 ${page?.code} ${page?.msg}`, '停一会儿再试')
      }
      for (const it of page.data?.items || []) {
        const c = it.note_card
        if (!c || seen.has(it.id)) continue
        seen.add(it.id)
        out.push({
          id: it.id,
          title: c.display_title,
          type: c.type,
          author: c.user?.nickname || c.user?.nick_name,
          authorId: c.user?.user_id,
          likes: num(c.interact_info?.liked_count),
          collects: num(c.interact_info?.collected_count),
          comments: num(c.interact_info?.comment_count),
          time: c.corner_tag_info?.find(x => x.type === 'publish_time')?.text,
          url: noteUrl(it.id, it.xsec_token),
        })
      }
      if (out.length >= limit || !page.data?.has_more) break
    }
    if (!out.length) {
      await checkWall(tab)
      throw new BxError('EMPTY', `小红书没有搜到 ${q}`, '换个关键词')
    }
  } finally {
    await tab.close().catch(() => {})
  }
  return out.slice(0, limit)
}

async function noteOn(tab) {
  await tab.waitFor({ selector: '#noteContainer, #detail-desc, .error-container, .login-container', timeout: 15000 }).catch(() => {})
  const n = await tab.eval(() => {
    const m = window.__INITIAL_STATE__?.note?.noteDetailMap
    const raw = m && (m._rawValue || m._value || m)
    const id = location.pathname.match(/\/(?:explore|discovery\/item|item)\/(\w+)/)?.[1]
    const note = raw && (raw[id] || raw[Object.keys(raw)[0]])?.note
    if (!note?.noteId) return null
    return JSON.parse(JSON.stringify(note, (k, v) => (k === 'imageList' ? (v || []).map(i => i.urlDefault || i.url) : k === 'video' ? { duration: v?.capa?.duration } : v)))
  })
  if (!n) {
    await checkWall(tab)
    throw new BxError('CHANGED', '笔记页里没找到数据', '页面结构可能变了；也可能笔记已删除')
  }
  return {
    id: n.noteId,
    title: n.title,
    type: n.type,
    author: n.user?.nickname,
    authorId: n.user?.userId,
    time: ms(n.time),
    location: n.ipLocation || undefined,
    likes: num(n.interactInfo?.likedCount),
    collects: num(n.interactInfo?.collectedCount),
    comments: num(n.interactInfo?.commentCount),
    shares: num(n.interactInfo?.shareCount),
    tags: (n.tagList || []).map(t => t.name).join(',') || undefined,
    desc: n.desc,
    images: n.imageList,
    duration: n.video?.duration,
    url: await tab.url(),
  }
}

/** 笔记正文、标签、互动数据、图片地址。url 要带 xsec_token（用 search 返回的 url）
 *  @example note('https://www.xiaohongshu.com/explore/6a7ed74f000000002800769f?xsec_token=…&xsec_source=pc_search') */
export async function note(url) {
  const tab = await bx.open(url)
  try {
    return await noteOn(tab)
  } finally {
    await tab.close().catch(() => {})
  }
}

/** 笔记评论（带前几条楼中楼）。url 要带 xsec_token
 *  @example comments('https://www.xiaohongshu.com/explore/6a7ed74f000000002800769f?xsec_token=…', { limit: 50 }) */
export async function comments(url, { limit = 50 } = {}) {
  const tab = await openRecording(url)
  const out = []
  try {
    const more = async () => {
      const done = await tab.eval(() => {
        const box = document.querySelector('.note-scroller') || document.scrollingElement
        box.scrollTop = box.scrollHeight
        return !!document.querySelector('.end-container')
      })
      return !done
    }
    for await (const page of tab.collect('/api/sns/web/v2/comment/page', { past: true, more, timeout: 6000 })) {
      if (page?.code !== 0) throw new BxError('BLOCKED', `评论接口返回 ${page?.code} ${page?.msg}`)
      for (const c of page.data?.comments || []) {
        out.push({
          author: c.user_info?.nickname,
          text: c.content,
          likes: num(c.like_count),
          replies: num(c.sub_comment_count),
          location: c.ip_location || undefined,
          time: ms(c.create_time),
          sub: (c.sub_comments || []).slice(0, 3).map(s => `${s.user_info?.nickname}：${s.content}`).join(' / ') || undefined,
        })
      }
      if (out.length >= limit || !page.data?.has_more) break
    }
    if (!out.length) await checkWall(tab)
  } finally {
    await tab.close().catch(() => {})
  }
  return out.slice(0, limit)
}

/** 用户主页的笔记列表。url 是 /user/profile/<id> 链接（最好带 xsec_token）
 *  @example userNotes('https://www.xiaohongshu.com/user/profile/66ebdc14000000000b03259c', { limit: 30 }) */
export async function userNotes(url, { limit = 30 } = {}) {
  if (!/user\/profile\//.test(url)) url = `https://www.xiaohongshu.com/user/profile/${url}`
  const tab = await openRecording(url)
  const out = []
  try {
    const first = await tab.eval(() => {
      const n = window.__INITIAL_STATE__?.user?.notes
      const raw = n && (n._rawValue || n._value || n)
      return raw ? JSON.parse(JSON.stringify((raw[0] || []).map(x => ({ id: x.id || x.noteCard?.noteId, token: x.xsecToken, card: x.noteCard })))) : []
    }).catch(() => [])
    for (const x of first) {
      const c = x.card || {}
      out.push({ id: x.id, title: c.displayTitle, type: c.type, likes: num(c.interactInfo?.likedCount), url: noteUrl(x.id, x.token, 'pc_user') })
    }
    const scroll = async () => {
      await tab.scroll('bottom')
      await bx.sleep(500)
    }
    if (out.length < limit)
      for await (const page of tab.collect('/api/sns/web/v1/user_posted', { past: true, more: scroll, timeout: 6000 })) {
        for (const n of page.data?.notes || []) {
          if (out.some(o => o.id === n.note_id)) continue
          out.push({ id: n.note_id, title: n.display_title, type: n.type, likes: num(n.interact_info?.liked_count), url: noteUrl(n.note_id, n.xsec_token, 'pc_user') })
        }
        if (out.length >= limit || !page.data?.has_more) break
      }
    if (!out.length) await checkWall(tab)
  } finally {
    await tab.close().catch(() => {})
  }
  return out.slice(0, limit)
}

/** 笔记页的读法：正文 + 标签 + 互动数据 */
export async function read(tab) {
  const url = await tab.url()
  if (!/xiaohongshu\.com\/(explore|discovery\/item)\/\w+/.test(url)) return null
  const n = await noteOn(tab)
  return {
    title: n.title,
    meta: { author: n.author, published: n.time, site: '小红书', likes: n.likes, collects: n.collects, comments: n.comments, location: n.location },
    content: [n.desc, n.tags ? `\n标签：${n.tags}` : '', n.images?.length ? `\n图片 ${n.images.length} 张` : ''].join('\n'),
  }
}
