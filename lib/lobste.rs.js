/* 站点笔记（Lobsters，邀请制的硬核技术社区，形式和 HN 一样：提交链接、投票、讨论）：
 * - 公开 JSON 接口，不用登录、不用浏览器：在网址后面加 .json
 *   榜单 /hottest.json /newest.json /active.json，翻页 /page/2.json（newest 是 /newest/page/2.json）
 *   标签 /t/<标签>.json（多个标签用逗号：/t/rust,go.json）；域名 /domains/<域名>.json
 *   帖子和全部评论 /s/<short_id>.json（comments 是按楼层顺序拍平的，depth 是缩进层级）
 * - 搜索没有 JSON：/search?q=&what=stories&order=relevance|newest|score&page=，解析 HTML 里的 li.story
 * - 帖子页 lobste.rs/s/<short_id>/<slug>
 */

const BASE = 'https://lobste.rs'

async function get(path, { json = true } = {}) {
  const r = await fetch(BASE + path, { headers: { 'user-agent': 'BrowserX/1.0 (https://github.com/rango886/BrowserX)', accept: json ? 'application/json' : 'text/html' }, signal: AbortSignal.timeout(30000) })
  if (r.status === 404) throw new BxError('NOT_FOUND', `Lobsters 上没有：${path}`)
  if (r.status === 429) throw new BxError('BLOCKED', 'Lobsters 限流了', '停一会儿再试')
  if (!r.ok) throw new BxError('HTTP_ERROR', `Lobsters 返回 ${r.status}`)
  return json ? r.json() : r.text()
}
const time = s => (s ? new Date(s).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined)
const story = (s, i) => ({
  rank: i + 1,
  id: s.short_id,
  title: s.title,
  link: s.url || undefined,
  points: s.score,
  comments: s.comment_count,
  tags: s.tags?.join(', '),
  author: s.submitter_user?.username || s.submitter_user,
  time: time(s.created_at),
  url: s.comments_url || s.short_id_url,
})

async function pages(first, more, limit) {
  const out = []
  for (let p = 1; out.length < limit && p <= 10; p++) {
    const j = await get(p === 1 ? first : more(p))
    if (!j.length) break
    out.push(...j)
  }
  return out.slice(0, limit)
}

const LISTS = { hot: ['/hottest.json', p => `/page/${p}.json`], newest: ['/newest.json', p => `/newest/page/${p}.json`], active: ['/active.json', p => `/active/page/${p}.json`] }

/** 首页榜单。list：hot 热门（默认）/ newest 最新 / active 最近有讨论的
 *  @example stories({ limit: 25 })
 *  @example stories({ list: 'newest', limit: 30 }) */
export async function stories({ list = 'hot', limit = 25 } = {}) {
  const l = LISTS[list]
  if (!l) throw new BxError('BAD_ARGS', 'list 只能是 hot / newest / active')
  return (await pages(l[0], l[1], limit)).map(story)
}

/** 某个标签下的帖子（最新的在前）。多个标签用逗号：'rust,go'。常用标签：rust go python programming security linux databases ai performance plt distributed
 *  @example tag('rust', { limit: 20 })
 *  @example tag('databases,distributed', { limit: 20 }) */
export async function tag(name, { limit = 25 } = {}) {
  const t = String(name).replace(/\s+/g, '')
  const list = await pages(`/t/${t}.json`, p => `/t/${t}/page/${p}.json`, limit)
  if (!list.length) throw new BxError('EMPTY', `标签 ${name} 下没有帖子`, '标签列表见 https://lobste.rs/tags')
  return list.map(story)
}

/** 某个网站被分享到 Lobsters 的帖子（看大家怎么讨论某个博客 / 项目的文章）
 *  @example domain('simonwillison.net', { limit: 20 }) */
export async function domain(host, { limit = 25 } = {}) {
  const d = String(host).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const list = await pages(`/domains/${encodeURIComponent(d)}.json`, p => `/domains/${encodeURIComponent(d)}/page/${p}.json`, limit)
  if (!list.length) throw new BxError('EMPTY', `没有 ${d} 的帖子`)
  return list.map(story)
}

const dec = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, ' ').trim()

/** 搜帖子。order：relevance 相关度 / newest 最新 / score 得分
 *  @example search('sqlite', { limit: 20 })
 *  @example search('zig compiler', { order: 'newest', limit: 10 }) */
export async function search(q, { order = 'relevance', limit = 25 } = {}) {
  const out = []
  for (let page = 1; out.length < limit && page <= 5; page++) {
    const html = await get(`/search?q=${encodeURIComponent(q)}&what=stories&order=${order}&page=${page}`, { json: false })
    const items = [...html.matchAll(/<li id="story_(\w+)"[\s\S]*?<\/li>\s*(?=<li id="story_|<\/ol>)/g)]
    if (!items.length) break
    for (const [b, id] of items) {
      const a = b.match(/<a class="u-url" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      out.push({
        id,
        title: dec(a?.[2]),
        link: a?.[1]?.startsWith('/') ? BASE + a[1] : a?.[1],
        points: Number(b.match(/class="upvoter"[^>]*>(\d+)/)?.[1]) || 0,
        comments: Number(b.match(/(\d+)\s+comments?/)?.[1]) || 0,
        tags: [...b.matchAll(/class="tag tag_[^"]*"[^>]*>([^<]+)</g)].map(m => m[1]).join(', '),
        author: b.match(/class="u-author[^"]*" href="\/~([^"]+)"/)?.[1],
        time: time(Number(b.match(/data-at-unix="(\d+)"/)?.[1]) * 1000 || undefined),
        url: BASE + (b.match(/href="(\/s\/\w+\/[^"]*)"/)?.[1] || `/s/${id}`),
      })
    }
  }
  if (!out.length) throw new BxError('EMPTY', `Lobsters 没搜到 ${q}`)
  return out.slice(0, limit).map((x, i) => ({ rank: i + 1, ...x }))
}

const idOf = s => String(s).match(/lobste\.rs\/s\/(\w+)/)?.[1] || String(s).trim()

/** 帖子的全部评论，按页面上的楼层顺序（depth 是缩进层级）
 *  @example comments('https://lobste.rs/s/ily7as', { limit: 50 }) */
export async function comments(url, { limit = 200 } = {}) {
  const j = await get(`/s/${idOf(url)}.json`)
  return (j.comments || []).filter(c => !c.is_deleted).slice(0, limit).map(c => ({
    author: c.commenting_user?.username || c.commenting_user,
    text: (c.comment_plain || dec(c.comment)).replace(/\r\n/g, '\n').trim(),
    points: c.score,
    depth: c.depth,
    time: time(c.created_at),
    id: c.short_id,
  }))
}

/** 帖子页的读法：标题、链接、正文和评论（按楼层缩进） */
export async function read(tab, { limit = 100 } = {}) {
  const id = (await tab.url()).match(/lobste\.rs\/s\/(\w+)/)?.[1]
  if (!id) return null
  const j = await get(`/s/${id}.json`)
  const list = await comments(id, { limit })
  return {
    title: j.title,
    type: 'discussion',
    meta: { author: j.submitter_user?.username || j.submitter_user, published: time(j.created_at), site: `Lobsters · ${j.tags?.join(', ')}` },
    link: j.url || undefined,
    content: [j.description_plain ? j.description_plain + '\n' : '', ...list.map(c => `${'  '.repeat(c.depth)}- **${c.author}**（${c.points}）：${c.text.replace(/\n+/g, ' ')}`)].join('\n'),
  }
}
