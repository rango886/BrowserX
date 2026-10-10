/* 站点笔记（Bloomberg 彭博）：
 * @login optional 搜索、RSS 不用登录；文章正文大多要订阅，没订阅只有标题、摘要和开头几段
 * - 栏目最新：RSS feeds.bloomberg.com/<栏目>/news.rss（Node 直接请求）
 * - 搜索：打开 /search?query=&page=，页面 #__NEXT_DATA__ 里 props.pageProps.ssrSearchQueryResults.results（headline、summary、byline、publishedAt、url、eyebrow）
 * - 文章：/news/articles/… 页面 #__NEXT_DATA__ 里 props.pageProps.story（headline、summary、byline、publishedAt、body 是结构化文档树：
 *   { type: 'paragraph' | 'heading' | 'list' …, content: [{ type: 'text', value }] }），没订阅时 body 只有前几段
 * - 搜索第一页不要带 &page=1（会跳到 nemo-production.cm.bloomberg.com 返回 Forbidden）；短时间请求太多也会这样，等几秒重试
 * - 有 PerimeterX 反爬（_pxhd cookie）；被拦时页面是 “Are you a robot?”，报 BLOCKED
 */

const FEEDS = { main: 'news', markets: 'markets/news', economics: 'economics/news', industries: 'industries/news', technology: 'technology/news', politics: 'politics/news', opinion: 'bview/news', green: 'green/news', crypto: 'crypto/news', wealth: 'wealth/news', pursuits: 'pursuits/news' }
const time = s => (s ? new Date(s).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : undefined)

/** 栏目最新新闻（RSS）。section：main markets economics industries technology politics opinion green crypto wealth pursuits
 *  @example news('markets', { limit: 10 }) */
export async function news(section = 'main', { limit = 30 } = {}) {
  const path = FEEDS[section]
  if (!path) throw new BxError('BAD_ARGS', `没有栏目 ${section}`, `可选：${Object.keys(FEEDS).join(' ')}`)
  const r = await fetch(`https://feeds.bloomberg.com/${path}.rss`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const xml = await r.text()
  const tag = (s, n) => (s.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`))?.[1] || '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    title: tag(it, 'title'),
    summary: tag(it, 'description').replace(/<[^>]+>/g, '').slice(0, 300) || undefined,
    author: tag(it, 'dc:creator') || undefined,
    time: tag(it, 'pubDate') ? time(tag(it, 'pubDate')) : undefined,
    url: tag(it, 'link').split('?')[0],
  }))
  if (!items.length) throw new BxError('CHANGED', 'Bloomberg RSS 没解析出内容', '去修 news')
  return items.slice(0, limit)
}

async function nextData(tab, retry = true) {
  await tab.waitFor({ selector: '#__NEXT_DATA__, #px-captcha', timeout: 20000 }).catch(() => {})
  const r = await tab.eval(() => {
    if (/Are you a robot/i.test(document.title) || document.querySelector('#px-captcha')) return { blocked: true }
    const el = document.getElementById('__NEXT_DATA__')
    if (el) return { data: JSON.parse(el.textContent).props?.pageProps }
    return { none: true, forbidden: /bloomberg\.com$/.test(location.hostname) && location.hostname !== 'www.bloomberg.com' || /^\s*Forbidden/.test(document.body.innerText) }
  })
  // 短时间请求多了会被临时拦（跳到别的域名、页面只有 Forbidden），等一下重新加载一次
  if (r.forbidden && retry) {
    await bx.sleep(4000)
    await tab.reload()
    return nextData(tab, false)
  }
  if (r.forbidden) throw new BxError('BLOCKED', 'Bloomberg 暂时拦截了（Forbidden）', '停几分钟再试')
  if (r.blocked) throw new BxError('BLOCKED', 'Bloomberg 反爬验证（Are you a robot?）', `bx tab activate ${tab.id} 在浏览器里过一下验证再试`)
  if (r.none) throw new BxError('CHANGED', 'Bloomberg 页面没有 __NEXT_DATA__', '页面结构可能变了')
  return r.data
}

/** 搜新闻。sort：relevance 相关 / time:desc 最新；page 第几页（每页 10 条）
 *  @example search('WH Group pork', { pages: 2 }) */
export async function search(q, { pages = 1, sort = 'relevance', limit = 50 } = {}) {
  const out = []
  for (let p = 1; p <= pages && out.length < limit; p++) {
    const tab = await bx.open(`https://www.bloomberg.com/search?query=${encodeURIComponent(q)}${sort !== 'relevance' ? `&sort=${encodeURIComponent(sort)}` : ''}${p > 1 ? '&page=' + p : ''}`)
    try {
      const d = await nextData(tab).catch(e => {
        if (p > 1 && out.length) return null // 翻页常被拦（page=2 会跳到 Forbidden），保留前面的结果
        throw e
      })
      if (!d) break
      const rs = d.ssrSearchQueryResults?.results || []
      out.push(...rs.map(x => ({ title: x.headline, summary: x.summary || undefined, author: x.byline || undefined, section: x.eyebrow || undefined, type: x.subtype || x.type, time: time(x.publishedAt), url: x.url?.split('?')[0] })))
      if (rs.length < 10) break
    } finally {
      await tab.close().catch(() => {})
    }
  }
  if (!out.length) throw new BxError('EMPTY', `Bloomberg 没有搜到 ${q}`, '换个英文关键词')
  return out.slice(0, limit)
}

/** 把 story.body 的文档树转成文字 */
function bodyText(node) {
  if (!node) return ''
  if (Array.isArray(node)) return node.map(bodyText).join('')
  if (node.type === 'text') return node.value || ''
  const inner = bodyText(node.content)
  switch (node.type) {
    case 'paragraph':
      return inner.trim() ? inner.trim() + '\n\n' : ''
    case 'heading':
      return `## ${inner.trim()}\n\n`
    case 'listItem':
    case 'list-item':
      return `- ${inner.trim()}\n`
    case 'list':
      return inner + '\n'
    case 'quote':
    case 'blockquote':
      return `> ${inner.trim()}\n\n`
    case 'br':
      return '\n'
    case 'media':
    case 'ad':
    case 'inline-newsletter':
    case 'inline-recirc':
      return ''
    default:
      return inner
  }
}

async function articleOn(tab) {
  const d = await nextData(tab)
  const s = d.story
  if (!s) throw new BxError('CHANGED', '这个页面不是标准文章页（没有 story）', '用 bx read 看看')
  const content = bodyText(s.body).replace(/\n{3,}/g, '\n\n').trim()
  return {
    title: s.headline || s.seoHeadline,
    summary: Array.isArray(s.summary) ? s.summary.join(' ') : s.summary || s.abstract?.join?.(' ') || undefined,
    author: s.byline || (s.authors || []).map(a => a.name).join(', ') || undefined,
    time: time(s.publishedAt),
    content,
    paywalled: d.userAccess?.hasAccess === false || s.premium || undefined,
    url: (s.url || (await tab.url())).split('?')[0],
  }
}

/** 文章（没订阅时正文只有开头几段）
 *  @example article('https://www.bloomberg.com/news/articles/2026-09-16/wh-smith-sees-profit-at-bottom-of-range-on-weaker-margins') */
export async function article(url) {
  const tab = await bx.open(url)
  try {
    return await articleOn(tab)
  } finally {
    await tab.close().catch(() => {})
  }
}

/** 文章页的读法 */
export async function read(tab) {
  const url = await tab.url()
  if (!/bloomberg\.com\/(news|opinion)\/(articles|features)\//.test(url)) return null
  const a = await articleOn(tab)
  return { title: a.title, meta: { author: a.author, published: a.time, site: 'Bloomberg' }, content: [a.summary ? `> ${a.summary}\n` : '', a.content].join('\n') }
}
