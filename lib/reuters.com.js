/* 站点笔记（Reuters 路透社）：
 * @login optional 不登录能搜、能看大部分文章；有每月免费篇数，超过或部分专题要登录
 * - 有 DataDome 反爬：Node 直连会被拦，统一在 www.reuters.com 标签里请求（标签里先打开过首页才有 datadome cookie）
 * - 搜索：/pf/api/v3/content/fetch/articles-by-search-v2?query={"keyword":…,"offset":0,"orderby":"display_date:desc","size":20,"website":"reuters"}
 *   返回 result.articles[]：title、description、canonical_url、published_time、authors[].name、kicker.name
 * - 栏目：/pf/api/v3/content/fetch/articles-by-section-alias-or-id-v1?query={"section_id":"/world/","size":20,"website":"reuters"}
 * - 文章页：<script id="fusion-metadata"> 里 globalContent 是文章数据；正文段落 [data-testid^="paragraph-"]
 * - 标签刚打开就请求会被 DataDome 拦（403），等几秒 cookie 写好再请求就行，api() 里会自动重试一次
 * - 被拦时页面标题是 “reuters.com” 并出现验证码（captcha-delivery），报 BLOCKED
 */

const tabOf = () => bx.tab('www.reuters.com', { open: 'https://www.reuters.com/' })
const time = s => (s ? new Date(s).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : undefined)

async function api(name, q) {
  const tab = await tabOf()
  const url = `https://www.reuters.com/pf/api/v3/content/fetch/${name}?query=${encodeURIComponent(JSON.stringify(q))}`
  let r = await tab.c('page.fetch', { url, init: {}, as: 'text' })
  // 标签刚打开时 DataDome 的 cookie 还没写好，等一下再试一次
  if (r.status === 401 || r.status === 403) {
    await bx.sleep(3000)
    r = await tab.c('page.fetch', { url, init: {}, as: 'text' })
  }
  if (r.status === 401 || r.status === 403) {
    if (/captcha|datadome/i.test(r.text)) throw new BxError('BLOCKED', 'Reuters 反爬验证（DataDome）', `bx tab activate ${tab.id} 在浏览器里过一下验证再试`)
    throw new BxError('NEED_LOGIN', `Reuters ${r.status}`, '在浏览器里登录 reuters.com 后重试')
  }
  if (r.status >= 400) throw new BxError('HTTP_ERROR', `Reuters ${r.status}`, String(r.text).slice(0, 200))
  try {
    return JSON.parse(r.text)
  } catch {
    throw new BxError('NOT_JSON', 'Reuters 返回的不是 JSON', String(r.text).slice(0, 200))
  }
}

const artOf = a => ({
  title: a.title || a.basic_headline,
  description: a.description || undefined,
  section: a.kicker?.name || a.primary_section?.name || undefined,
  authors: (a.authors || []).map(x => x.name).join(', ') || undefined,
  time: time(a.published_time || a.display_time),
  url: a.canonical_url ? 'https://www.reuters.com' + a.canonical_url : undefined,
})

/** 搜新闻（按时间倒序）。sort：display_date:desc 最新 / relevance
 *  @example search('Shuanghui', { limit: 10 }) */
export async function search(q, { limit = 20, offset = 0, sort = 'display_date:desc' } = {}) {
  const j = await api('articles-by-search-v2', { keyword: q, offset, orderby: sort, size: Math.min(limit, 100), website: 'reuters' })
  const list = j.result?.articles || []
  if (!list.length) throw new BxError('EMPTY', `Reuters 没有搜到 ${q}`, '换个英文关键词')
  return list.slice(0, limit).map(artOf)
}

/** 栏目最新新闻。section：world business markets technology sustainability legal 或 /world/china/ 这种路径
 *  @example section('world/china', { limit: 10 }) */
export async function section(name = 'world', { limit = 20 } = {}) {
  const id = '/' + String(name).replace(/^\/|\/$/g, '') + '/'
  const j = await api('articles-by-section-alias-or-id-v1', { section_id: id, offset: 0, size: Math.min(limit, 100), website: 'reuters' })
  const list = j.result?.articles || []
  if (!list.length) throw new BxError('NOT_FOUND', `没有栏目 ${id}`, '换成 world / business / markets / technology 等')
  return list.slice(0, limit).map(artOf)
}

async function articleOn(tab) {
  await tab.waitFor({ selector: '[data-testid^="paragraph-"], article, #fusion-metadata', timeout: 20000 }).catch(() => {})
  const a = await tab.eval(() => {
    if (/captcha-delivery|geo\.captcha/.test(document.documentElement.innerHTML.slice(0, 20000)) && !document.querySelector('article')) return { blocked: true }
    let g = null
    try {
      g = JSON.parse(document.getElementById('fusion-metadata')?.textContent || 'null')?.globalContent
    } catch {}
    const paras = [...document.querySelectorAll('[data-testid^="paragraph-"]')].map(p => p.innerText.trim()).filter(Boolean)
    return {
      title: g?.title || document.querySelector('h1')?.innerText.trim(),
      description: g?.description,
      authors: (g?.authors || []).map(x => x.name).join(', ') || undefined,
      time: g?.published_time || document.querySelector('time')?.getAttribute('datetime'),
      content: paras.join('\n\n') || document.querySelector('article')?.innerText.trim() || '',
      gated: /sign in to continue|register to read|subscribe to continue/i.test(document.body.innerText.slice(0, 20000)),
    }
  })
  if (a.blocked) throw new BxError('BLOCKED', 'Reuters 反爬验证（DataDome）', `bx tab activate ${tab.id} 在浏览器里过一下验证再试`)
  if (!a.content && a.gated) throw new BxError('NEED_LOGIN', 'Reuters 这篇要登录才能看', '在浏览器里登录 reuters.com 后重试')
  return { ...a, time: a.time ? time(a.time) : undefined, url: (await tab.url()).split('?')[0] }
}

/** 文章全文
 *  @example article('https://www.reuters.com/world/china/taiwan-cherishes-peace-will-not-give-up-its-freedom-president-says-2026-10-10/') */
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
  if (!/reuters\.com\/.+-\d{4}-\d{2}-\d{2}\/?/.test(url)) return null
  const a = await articleOn(tab)
  return { title: a.title, meta: { author: a.authors, published: a.time, site: 'Reuters' }, content: [a.description ? `> ${a.description}\n` : '', a.content].join('\n') }
}
