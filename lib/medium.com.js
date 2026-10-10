/* 站点笔记（Medium）：
 * @login optional 不登录能搜、能看免费文章；会员文章（isLocked）不登录 / 不是会员只能看开头一段
 * - 搜索：打开 medium.com/search?q= 后，页面会 POST /_/graphql，返回里 data.search.posts.items 就是文章（用 collect 接住）；
 *   滚动加载下一页
 * - 标签 / 作者 / 专栏有 RSS：medium.com/feed/tag/<tag>、medium.com/feed/@<user>、medium.com/feed/<publication>（Node 直接请求，带全文 HTML）
 * - 文章页正文在 <article> 里；isLocked 的文章不是会员时会截断，返回里 locked: true 提示
 * - firstPublishedAt 是毫秒时间戳；readingTime 是分钟
 */

const day = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : undefined)
const strip = h => String(h || '').replace(/<(br|\/p|\/h\d|\/li|\/pre|\/blockquote)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()

const postOf = p => ({
  title: p.title,
  author: p.creator?.name,
  publication: p.collection?.name || undefined,
  subtitle: p.extendedPreviewContent?.subtitle || undefined,
  claps: p.clapCount,
  responses: p.postResponses?.count,
  minutes: p.readingTime ? Math.round(p.readingTime) : undefined,
  locked: p.isLocked || undefined,
  time: day(p.firstPublishedAt),
  url: p.mediumUrl?.split('?')[0],
})

/** 搜文章
 *  @example search('sqlite production', { limit: 20 }) */
export async function search(q, { limit = 20 } = {}) {
  const tab = await bx.open('about:blank')
  await tab.c('net.mark')
  await tab.goto(`https://medium.com/search?q=${encodeURIComponent(q)}`)
  const out = new Map()
  try {
    for await (const res of tab.collect('/_/graphql', { past: true, timeout: 8000, more: () => tab.scroll('bottom') })) {
      for (const x of Array.isArray(res) ? res : [res]) for (const p of x?.data?.search?.posts?.items || []) if (p.mediumUrl && !out.has(p.id)) out.set(p.id, postOf(p))
      if (out.size >= limit) break
    }
  } finally {
    await tab.close().catch(() => {})
  }
  if (!out.size) throw new BxError('EMPTY', `Medium 没有搜到 ${q}`, '换个关键词')
  return [...out.values()].slice(0, limit)
}

async function rss(path, limit) {
  const r = await fetch(`https://medium.com/feed/${path}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (r.status === 404) throw new BxError('NOT_FOUND', `没有这个 Medium 订阅源：${path}`)
  const xml = await r.text()
  const tag = (s, n) => (s.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`))?.[1] || '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map(([, it]) => ({
    title: tag(it, 'title'),
    author: tag(it, 'dc:creator'),
    time: tag(it, 'pubDate') ? new Date(tag(it, 'pubDate')).toISOString().slice(0, 10) : undefined,
    tags: [...it.matchAll(/<category><!\[CDATA\[(.*?)\]\]><\/category>/g)].map(m => m[1]).join(',') || undefined,
    snippet: strip(tag(it, 'content:encoded')).slice(0, 200),
    url: tag(it, 'link').split('?')[0],
  }))
}

/** 某个标签下的最新文章（RSS）
 *  @example tag('sqlite', { limit: 10 }) */
export async function tag(name, { limit = 20 } = {}) {
  return rss(`tag/${encodeURIComponent(String(name).toLowerCase().replace(/\s+/g, '-'))}`, limit)
}

/** 某个作者（@用户名）或专栏的最新文章（RSS）
 *  @example user('@karpathy', { limit: 10 }) */
export async function user(name, { limit = 20 } = {}) {
  const n = String(name).replace(/^https?:\/\/medium\.com\//, '')
  return rss(n.startsWith('@') || n.includes('/') ? n : '@' + n, limit)
}

async function articleOn(tab) {
  await tab.waitFor({ selector: 'article', timeout: 15000 }).catch(() => {})
  const a = await tab.eval(() => {
    const art = document.querySelector('article')
    if (!art) return null
    const c = art.cloneNode(true)
    c.querySelectorAll('button, [data-testid="headerSocialShareButton"], [aria-label="responses"], svg').forEach(x => x.remove())
    c.querySelectorAll('pre').forEach(p => p.replaceWith('\n```\n' + p.innerText + '\n```\n'))
    const text = [...c.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre')].map(e => (/^H\d/.test(e.tagName) ? '#'.repeat(+e.tagName[1]) + ' ' : e.tagName === 'LI' ? '- ' : '') + e.innerText.trim()).filter(s => s.replace(/[#\-\s]/g, '')).join('\n\n')
    return {
      title: document.querySelector('h1')?.innerText.trim(),
      author: document.querySelector('[data-testid="authorName"]')?.innerText.trim(),
      time: document.querySelector('[data-testid="storyPublishDate"]')?.innerText.trim(),
      locked: !!document.querySelector('[data-testid="paywall"], .meteredContent ~ div [aria-label*="member"]') || /Member-only story/.test(document.body.innerText.slice(0, 3000)),
      content: text || art.innerText,
    }
  })
  if (!a) throw new BxError('CHANGED', 'Medium 文章页没找到 <article>', '用 bx read 看看')
  return { ...a, url: (await tab.url()).split('?')[0] }
}

/** 文章全文（会员文章不登录只有开头一段，locked 会标出来）
 *  @example article('https://medium.com/@thekevinscott/use-your-filesystem-as-your-database-db5b63374d53') */
export async function article(url) {
  const tab = await bx.open(url)
  try {
    return await articleOn(tab)
  } finally {
    await tab.close().catch(() => {})
  }
}

/** 文章页的读法（只处理文章页：链接最后一段带 12 位左右的 id） */
export async function read(tab) {
  const url = await tab.url()
  if (!/-[0-9a-f]{8,12}(?:[?#]|$)/.test(url)) return null
  const a = await articleOn(tab)
  return { title: a.title, meta: { author: a.author, published: a.time, site: 'Medium', locked: a.locked || undefined }, content: a.content + (a.locked ? '\n\n（会员文章，未登录 / 非会员只显示了开头）' : '') }
}
