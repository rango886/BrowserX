/* 站点笔记（BBC 新闻）：
 * - 栏目头条用公开 RSS：feeds.bbci.co.uk/news/<栏目>/rss.xml（首页是 /news/rss.xml），不用浏览器
 *   栏目：world business politics health education science_and_environment technology entertainment_and_arts，
 *   地区：world/asia world/us_and_canada world/europe world/middle_east world/africa world/latin_america，中国 world/asia/china
 *   BBC 中文：feeds.bbci.co.uk/zhongwen/trad/rss.xml（simp 那个地址现在返回的也是繁体），标题是繁体；文章网址末尾 /trad 换成 /simp 就是简体页
 * - 搜索：www.bbc.co.uk/search?q=&d=NEWS_PS&page=，HTML 里 window.__INITIAL_DATA__ 是一个 JSON 字符串，
 *   data['search-results…'].data.initialResults.items 是结果（headline description url datePublished）。每页 10 条
 * - 文章页 bbc.com/news/articles/<id>：__NEXT_DATA__ → props.pageProps.page[<key>].contents 是正文块
 *   （headline / byline / timestamp / text → model.blocks[paragraph].model.text / subheadline / image …）
 * - 国内网络连 bbc.co.uk 偶尔超时，失败时重试一次
 */

const FEED = 'https://feeds.bbci.co.uk'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

async function text(url) {
  let err
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25000) })
      if (r.status === 404) throw new BxError('NOT_FOUND', `BBC 没有这个页面：${url}`)
      if (!r.ok) throw new BxError('HTTP_ERROR', `BBC 返回 ${r.status}`)
      return await r.text()
    } catch (e) {
      if (e instanceof BxError) throw e
      err = e
    }
  }
  throw new BxError('BLOCKED', `连不上 BBC（${err?.cause?.code || err?.message}）`, '检查网络或代理后再试')
}

const decode = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .trim()
const tag = (b, t) => decode(b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1])
const time = d => (d ? new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined)

const TOPICS = ['world', 'business', 'politics', 'health', 'education', 'science_and_environment', 'technology', 'entertainment_and_arts', 'uk', 'world/asia', 'world/asia/china', 'world/us_and_canada', 'world/europe', 'world/middle_east', 'world/africa', 'world/latin_america', 'business/your_money']

/** 栏目头条（RSS，最新的在前，时间是北京时间）。topic：不写是首页；world business politics technology science_and_environment health
 *  entertainment_and_arts，地区 world/asia world/asia/china world/us_and_canada world/europe world/middle_east；zh 是 BBC 中文（标题是繁体，链接是简体页）
 *  @example news({ limit: 20 })
 *  @example news({ topic: 'technology', limit: 20 })
 *  @example news({ topic: 'zh', limit: 20 }) */
export async function news({ topic = '', limit = 30 } = {}) {
  const t = String(topic).trim().toLowerCase().replace(/[\s-]+/g, '_')
  let path
  if (!t) path = '/news/rss.xml'
  else if (t === 'zh' || t === 'zhongwen' || t === '中文') path = '/zhongwen/trad/rss.xml'
  else if (TOPICS.includes(t)) path = `/news/${t}/rss.xml`
  else throw new BxError('BAD_ARGS', `没有栏目 ${topic}`, `可选：${TOPICS.join(' ')}，或 zh（BBC 中文）`)
  const xml = await text(FEED + path)
  const items = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)].map(([, b]) => ({
    title: tag(b, 'title'),
    description: tag(b, 'description'),
    time: time(tag(b, 'pubDate')),
    url: (tag(b, 'link') || tag(b, 'guid')).replace(/\?at_medium=RSS.*$/, '').replace(/\/zhongwen\/articles\/(\w+)\/trad$/, '/zhongwen/articles/$1/simp'),
  }))
  if (!items.length) throw new BxError('EMPTY', `BBC ${topic || '首页'} 的 RSS 是空的`)
  return items.sort((a, b) => (b.time || '').localeCompare(a.time || '')).slice(0, limit).map((x, i) => ({ rank: i + 1, ...x }))
}

/** 搜 BBC 新闻（按相关度，每页 10 条，自动翻页凑够 limit）
 *  @example search('nvidia', { limit: 10 })
 *  @example search('china economy', { limit: 30 }) */
export async function search(q, { limit = 20 } = {}) {
  const out = []
  for (let page = 1; out.length < limit && page <= 10; page++) {
    const html = await text(`https://www.bbc.co.uk/search?q=${encodeURIComponent(q)}&d=NEWS_PS&page=${page}`)
    const raw = html.match(/window\.__INITIAL_DATA__\s*=\s*("(?:[^"\\]|\\.)*")/)?.[1]
    if (!raw) throw new BxError('CHANGED', 'BBC 搜索页里找不到 __INITIAL_DATA__', '页面结构可能变了，去修 search')
    const data = JSON.parse(JSON.parse(raw)).data || {}
    const key = Object.keys(data).find(k => k.startsWith('search-results'))
    const items = data[key]?.data?.initialResults?.items || []
    if (!items.length) break
    for (const x of items)
      out.push({
        title: x.headline,
        description: x.description,
        section: x.metadataStripItems?.find(m => m.label === 'Section')?.text,
        time: time(x.datePublished),
        url: x.url?.replace('www.bbc.co.uk', 'www.bbc.com'),
      })
  }
  if (!out.length) throw new BxError('EMPTY', `BBC 没搜到 ${q}`, '换个英文关键词')
  return out.slice(0, limit).map((x, i) => ({ rank: i + 1, ...x }))
}

function plainBlocks(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => plainBlocks(n, out))
  else if (node && typeof node === 'object') {
    if (node.type === 'paragraph' && node.model?.text) out.push(node.model.text)
    else if (node.type === 'listItem' && node.model?.blocks) {
      const t = []
      plainBlocks(node.model.blocks, t)
      out.push('- ' + t.join(' '))
    } else if (node.model?.blocks) plainBlocks(node.model.blocks, out)
  }
  return out
}

/** 文章正文（不开浏览器，直接解析页面数据）：标题、作者、发布时间、正文（小标题转成 ##）
 *  @example article('https://www.bbc.com/news/articles/ck9dzpw4ll8po') */
export async function article(url) {
  const u = String(url).replace('www.bbc.co.uk', 'www.bbc.com')
  const html = await text(u)
  const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1]
  if (!raw) throw new BxError('CHANGED', '这个 BBC 页面没有 __NEXT_DATA__', '不是普通文章页（直播、视频页）就用 bx read')
  const pp = JSON.parse(raw).props?.pageProps || {}
  const page = pp.page?.[Object.keys(pp.page || {})[0]]
  const blocks = page?.contents || []
  if (!blocks.length) throw new BxError('CHANGED', '解析不出正文', '用 bx read 读')
  const body = []
  let title = '', author = '', ts
  for (const b of blocks) {
    if (b.type === 'headline') title = plainBlocks(b.model).join(' ')
    else if (b.type === 'timestamp') ts = b.model?.timestamp
    else if (b.type === 'byline') author = plainBlocks(b.model).join('，')
    else if (b.type === 'subheadline') body.push('## ' + plainBlocks(b.model).join(' '))
    else if (b.type === 'text') body.push(...plainBlocks(b.model))
  }
  return { title, author: author || pp.metadata?.contributor, time: time(ts || pp.metadata?.lastPublished), section: page.section?.name || undefined, url: u, content: body.join('\n\n') }
}

/** 文章页的读法 */
export async function read(tab) {
  const u = await tab.url()
  if (!/bbc\.(com|co\.uk)\/news\/articles\//.test(u)) return null
  const a = await article(u).catch(() => null)
  if (!a?.content) return null
  return { title: a.title, type: 'article', meta: { author: a.author, published: a.time, site: 'BBC' }, content: a.content }
}
