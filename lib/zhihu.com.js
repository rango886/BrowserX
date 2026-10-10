/* 站点笔记（知乎）：
 * @login required 没登录时搜索、回答列表基本拿不到（403 或者只给几条）
 * - 在 www.zhihu.com 标签里带 cookie 请求它自己的接口：
 *     搜索 /api/v4/search_v3?q=&t=general&offset=&limit=20（翻页用返回的 paging.next，host 是 api.zhihu.com，要换成 www.zhihu.com/api/v4）
 *     热榜 /api/v3/feed/topstory/hot-lists/total?limit=50
 *     问题 /api/v4/questions/<id>?include=detail,answer_count,follower_count,visit_count
 *     回答列表 /api/v4/questions/<id>/answers?limit=20&offset=&sort_by=default|created&include=data[*].content,voteup_count,comment_count,author
 *     单个回答 /api/v4/answers/<id>?include=content,voteup_count,comment_count,author,created_time,question
 *     专栏文章 /api/v4/articles/<id>（zhuanlan.zhihu.com/p/<id>）
 *     评论 /api/v4/comment_v5/{answers|articles}/<id>/root_comment?order_by=score|ts&limit=20&offset=
 * - 问题详情 /api/v4/questions/<id> 和文章 /api/v4/articles/<id> 要 x-zse-96 签名（不带返回 403 code 10003），
 *   所以这两个改成打开页面读 <script id="js-initialData"> 里的 initialState.entities.questions / articles
 * - 其余接口（搜索、热榜、回答列表、单个回答、评论）不用签名，在 www.zhihu.com 标签里带 cookie 直接请求就行
 * - 标签要匹配 www.zhihu.com；只写 zhihu.com 会匹配到 zhuanlan.zhihu.com 的标签，接口是跨域的
 * - id 有 16 位以上的（JSON 数字会丢精度），所以先拿文本，把长数字加上引号再解析
 * - 请求太快会触发 403 + 验证码页，翻页之间停 300ms
 */

const tabOf = () => bx.tab('www.zhihu.com', { open: 'https://www.zhihu.com/' })
const time = s => (s ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') : undefined)
const strip = h => String(h || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d|blockquote)>/gi, '\n').replace(/<li>/gi, '- ')
  .replace(/<figure[\s\S]*?<\/figure>/gi, '[图]')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim()

async function api(url) {
  const tab = await tabOf()
  const r = await tab.c('page.fetch', { url, init: {}, as: 'text' })
  if (r.status === 401 || r.status === 403) {
    const me = await tab.eval(async () => (await fetch('/api/v4/me', { credentials: 'include' })).status).catch(() => 0)
    if (me !== 200) throw new BxError('NEED_LOGIN', '知乎没有登录', '在浏览器里登录 zhihu.com 后重试')
    throw new BxError('BLOCKED', `知乎拦截了请求（${r.status}）`, `可能触发了验证码：bx tab activate ${tab.id} 打开看看，处理完再试`)
  }
  if (r.status === 404) throw new BxError('NOT_FOUND', `知乎 404：${url}`)
  if (r.status >= 400) throw new BxError('HTTP_ERROR', `知乎 ${r.status}：${url}`, String(r.text).slice(0, 200))
  try {
    return JSON.parse(String(r.text).replace(/("(?:id|target_id|question_id|token)"\s*:\s*)(\d{16,})/g, '$1"$2"'))
  } catch {
    throw new BxError('NOT_JSON', `知乎返回的不是 JSON：${url}`, String(r.text).slice(0, 200))
  }
}

/** 页面里 js-initialData 的 entities.<kind>[id]；传 tab 就读它，否则后台开个标签读完关掉 */
async function pageEntity(url, kind, id, tab) {
  const own = !tab
  if (own) tab = await bx.open(url)
  try {
    await tab.waitFor({ selector: '#js-initialData', timeout: 15000 }).catch(() => {})
    const r = await tab.eval(
      (kind, id) => {
        const el = document.getElementById('js-initialData')
        if (!el) return { err: location.href.includes('signin') ? 'login' : 'nodata', url: location.href }
        const s = JSON.parse(el.textContent).initialState
        const all = s.entities?.[kind] || {}
        const x = all[id] || Object.values(all)[0]
        if (!x) return { err: 'nodata', url: location.href }
        const u = s.entities.users || {}
        const author = typeof x.author === 'string' ? u[x.author]?.name : x.author?.name
        return { ...x, authorName: author }
      },
      kind,
      id,
    )
    if (r.err === 'login') throw new BxError('NEED_LOGIN', '知乎跳到了登录页', '在浏览器里登录 zhihu.com 后重试')
    if (r.err) throw new BxError('CHANGED', `页面里没找到 ${kind} 数据：${r.url}`, '可能触发了验证码，或者页面结构变了')
    return r
  } finally {
    if (own) await tab.close().catch(() => {})
  }
}

const answerUrl = (qid, aid) => (qid ? `https://www.zhihu.com/question/${qid}/answer/${aid}` : `https://www.zhihu.com/answer/${aid}`)

/** 搜索。type：all 全部 / answer 回答 / article 文章 / question 问题
 *  @example search('SQLite 生产环境', { limit: 20 }) */
export async function search(q, { limit = 20, type = 'all' } = {}) {
  let url = `https://www.zhihu.com/api/v4/search_v3?q=${encodeURIComponent(q)}&t=general&offset=0&limit=20`
  const out = []
  const seen = new Set()
  for (let page = 0; url && out.length < limit && page < 20; page++) {
    const j = await api(url)
    for (const it of j.data || []) {
      const o = it.object
      if (it.type !== 'search_result' || !o || !['answer', 'article', 'question'].includes(o.type)) continue
      if (type !== 'all' && o.type !== type) continue
      const key = o.type + o.id
      if (seen.has(key)) continue
      seen.add(key)
      const qid = o.question?.id
      out.push({
        type: o.type,
        id: String(o.id),
        title: strip(o.title || o.question?.name),
        author: o.author?.name,
        votes: o.voteup_count,
        comments: o.comment_count,
        time: time(o.created_time || o.updated_time),
        snippet: strip(o.excerpt || o.content || '').slice(0, 200),
        url: o.type === 'answer' ? answerUrl(qid, o.id) : o.type === 'article' ? `https://zhuanlan.zhihu.com/p/${o.id}` : `https://www.zhihu.com/question/${o.id}`,
      })
      if (out.length >= limit) break
    }
    if (j.paging?.is_end || !j.paging?.next) break
    url = j.paging.next.replace(/^https?:\/\/api\.zhihu\.com\//, 'https://www.zhihu.com/api/v4/')
    await bx.sleep(300)
  }
  if (!out.length) throw new BxError('EMPTY', `没有搜到 ${q}`, '换个关键词')
  return out
}

/** 知乎热榜
 *  @example hot({ limit: 20 }) */
export async function hot({ limit = 50 } = {}) {
  const j = await api('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50')
  return (j.data || []).slice(0, limit).map((it, i) => ({
    rank: i + 1,
    title: it.target?.title,
    heat: it.detail_text,
    answers: it.target?.answer_count,
    followers: it.target?.follower_count,
    excerpt: it.target?.excerpt?.slice(0, 120) || undefined,
    url: `https://www.zhihu.com/question/${it.target?.id}`,
  }))
}

/** 问题详情 + 回答（sort：default 默认排序 / created 最新）。id 是数字或问题链接
 *  @example question('https://www.zhihu.com/question/19550225', { limit: 5 }) */
export async function question(id, { limit = 10, sort = 'default', budget = 3000 } = {}) {
  return questionOn(id, { limit, sort, budget })
}

async function questionOn(id, { limit = 10, sort = 'default', budget = 3000 } = {}, tab) {
  const qid = String(id).match(/question\/(\d+)/)?.[1] || String(id).match(/^\d+$/)?.[0]
  if (!qid) throw new BxError('BAD_ARGS', '要问题 id 或 /question/<id> 链接')
  const q = await pageEntity(`https://www.zhihu.com/question/${qid}`, 'questions', qid, tab)
  let url = `https://www.zhihu.com/api/v4/questions/${qid}/answers?limit=20&offset=0&sort_by=${sort}&include=data%5B*%5D.content,voteup_count,comment_count,author,created_time,updated_time`
  const answers = []
  while (url && answers.length < limit) {
    const j = await api(url)
    for (const a of j.data || []) {
      answers.push({ id: String(a.id), author: a.author?.name, votes: a.voteup_count, comments: a.comment_count, time: time(a.created_time), text: strip(a.content).slice(0, budget), url: answerUrl(qid, a.id) })
      if (answers.length >= limit) break
    }
    if (j.paging?.is_end) break
    url = j.paging?.next
    await bx.sleep(300)
  }
  return {
    id: qid,
    title: q.title,
    detail: strip(q.detail) || undefined,
    answerCount: q.answerCount,
    followers: q.followerCount,
    views: q.visitCount,
    time: time(q.created),
    url: `https://www.zhihu.com/question/${qid}`,
    answers,
  }
}

/** 单个回答全文。id 是回答 id 或回答链接
 *  @example answer('https://www.zhihu.com/question/19550225/answer/1991515134179426692') */
export async function answer(id) {
  const aid = String(id).match(/answer\/(\d+)/)?.[1] || String(id).match(/^\d+$/)?.[0]
  if (!aid) throw new BxError('BAD_ARGS', '要回答 id 或 /answer/<id> 链接')
  const a = await api(`https://www.zhihu.com/api/v4/answers/${aid}?include=content,voteup_count,comment_count,author,created_time,updated_time,question`)
  return { id: aid, question: a.question?.title, author: a.author?.name, votes: a.voteup_count, comments: a.comment_count, time: time(a.created_time), updated: time(a.updated_time), content: strip(a.content), url: answerUrl(a.question?.id, aid) }
}

/** 专栏文章全文。id 或 zhuanlan.zhihu.com/p/<id> 链接
 *  @example article('https://zhuanlan.zhihu.com/p/2071154082585354258') */
export async function article(id) {
  return articleOn(id)
}

async function articleOn(id, tab) {
  const pid = String(id).match(/\/p\/(\d+)/)?.[1] || String(id).match(/^\d+$/)?.[0]
  if (!pid) throw new BxError('BAD_ARGS', '要文章 id 或 zhuanlan.zhihu.com/p/<id> 链接')
  const a = await pageEntity(`https://zhuanlan.zhihu.com/p/${pid}`, 'articles', pid, tab)
  return { id: pid, title: a.title, author: a.authorName, votes: a.voteupCount, comments: a.commentCount, time: time(a.created), updated: time(a.updated), content: strip(a.content), url: `https://zhuanlan.zhihu.com/p/${pid}` }
}

/** 回答或文章的评论（只取一级评论，带前几条回复）。sort：score 热门 / ts 最新
 *  @example comments('https://www.zhihu.com/question/19550225/answer/1991515134179426692', { limit: 20 }) */
export async function comments(url, { limit = 20, sort = 'score' } = {}) {
  const s = String(url)
  const [kind, id] = s.match(/answer\/(\d+)/) ? ['answers', s.match(/answer\/(\d+)/)[1]] : s.match(/\/p\/(\d+)/) ? ['articles', s.match(/\/p\/(\d+)/)[1]] : [null, null]
  if (!kind) throw new BxError('BAD_ARGS', '要回答链接（/answer/<id>）或文章链接（/p/<id>）')
  let next = `https://www.zhihu.com/api/v4/comment_v5/${kind}/${id}/root_comment?order_by=${sort}&limit=20&offset=`
  const out = []
  while (next && out.length < limit) {
    const j = await api(next)
    for (const c of j.data || []) {
      out.push({ author: c.author?.name, likes: c.like_count, replies: c.child_comment_count, time: time(c.created_time), text: strip(c.content), sub: (c.child_comments || []).slice(0, 3).map(x => `${x.author?.name}：${strip(x.content)}`).join(' / ') || undefined })
      if (out.length >= limit) break
    }
    if (j.paging?.is_end) break
    next = j.paging?.next
    await bx.sleep(300)
  }
  return out
}

/** 当前登录的账号 */
export async function me() {
  const j = await api('https://www.zhihu.com/api/v4/me?include=url_token')
  if (!j.url_token) throw new BxError('NEED_LOGIN', '知乎没有登录', '在浏览器里登录 zhihu.com 后重试')
  return { name: j.name, urlToken: j.url_token, url: `https://www.zhihu.com/people/${j.url_token}` }
}

/** 问题页 / 回答页 / 专栏文章的读法 */
export async function read(tab, { limit = 5 } = {}) {
  const url = await tab.url()
  if (/zhuanlan\.zhihu\.com\/p\/\d+/.test(url)) {
    const a = await articleOn(url, tab)
    return { title: a.title, meta: { author: a.author, published: a.time, site: '知乎专栏', votes: a.votes }, content: a.content }
  }
  if (/\/answer\/\d+/.test(url)) {
    const a = await answer(url)
    return { title: a.question, meta: { author: a.author, published: a.time, site: '知乎', votes: a.votes }, content: a.content }
  }
  if (/\/question\/\d+/.test(url)) {
    const q = await questionOn(url, { limit }, tab)
    return {
      title: q.title,
      meta: { site: '知乎', answers: q.answerCount, followers: q.followers },
      content: [q.detail || '', ...q.answers.map(a => `\n## ${a.author}（${a.votes} 赞，${a.time}）\n\n${a.text}`)].join('\n'),
    }
  }
  return null
}
