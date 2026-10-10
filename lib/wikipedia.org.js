/* 站点笔记（维基百科）：
 * - 官方公开接口，不用登录、不用浏览器。语言用 lang 参数切换子站（en / zh / ja / de …）；
 *   不写 lang 时，关键词里有中文就用 zh，否则 en
 *   Action API  https://<lang>.wikipedia.org/w/api.php：搜索 list=search；正文 prop=extracts&explaintext=1&exsectionformat=wiki
 *   REST API    /api/rest_v1/page/summary/<标题>（摘要）、/page/random/summary、/feed/featured/YYYY/MM/DD（mostread 是前一天的阅读量榜）
 *   阅读量榜兜底：wikimedia.org/api/rest_v1/metrics/pageviews/top/<lang>.wikipedia/all-access/YYYY/MM/DD
 * - 中文站默认繁简混排：Action API 加 variant=zh-cn、REST 加请求头 Accept-Language: zh-cn 就转成简体（搜索结果的 snippet 不转）
 * - 要带 User-Agent，否则偶尔 403
 */

const UA = 'BrowserX/1.0 (https://github.com/rango886/BrowserX)'
const pickLang = (lang, text = '') => lang || (/[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en')

async function get(url, lang) {
  const headers = { 'user-agent': UA, accept: 'application/json' }
  if (lang === 'zh') headers['accept-language'] = 'zh-cn'
  const r = await fetch(url, { headers })
  if (r.status === 404) return null
  if (r.status === 429) throw new BxError('BLOCKED', '维基百科限流了', '停一会儿再试')
  if (!r.ok) throw new BxError('HTTP_ERROR', `维基百科返回 ${r.status}：${url}`)
  return r.json()
}
const action = (lang, params) => get(`https://${lang}.wikipedia.org/w/api.php?format=json&formatversion=2&utf8=1${lang === 'zh' ? '&variant=zh-cn' : ''}&${params}`, lang)
const wikiUrl = (lang, title) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
const plain = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'")

/** 搜词条（全文搜索，按相关度）
 *  @example search('retrieval augmented generation', { limit: 5 })
 *  @example search('大语言模型', { limit: 5 }) */
export async function search(q, { lang = '', limit = 10 } = {}) {
  lang = pickLang(lang, q)
  const j = await action(lang, `action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${Math.min(limit, 50)}`)
  const list = j?.query?.search || []
  if (!list.length) throw new BxError('EMPTY', `${lang}.wikipedia 没搜到 ${q}`, '换个关键词，或换语言 lang: en / zh')
  return list.map((r, i) => ({ rank: i + 1, title: r.title, snippet: plain(r.snippet), words: r.wordcount, updated: r.timestamp?.slice(0, 10), url: wikiUrl(lang, r.title) }))
}

/** 词条摘要（导语部分 + 一句话描述），适合快速确认一个概念
 *  @example summary('Transformer (deep learning architecture)')
 *  @example summary('量子计算', { lang: 'zh' }) */
export async function summary(title, { lang = '' } = {}) {
  lang = pickLang(lang, title)
  const d = await get(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, lang)
  if (!d?.title) throw new BxError('NOT_FOUND', `${lang}.wikipedia 没有词条 ${title}`, '先用 search 找准确的标题')
  return { title: d.title, description: d.description, extract: d.extract, type: d.type === 'disambiguation' ? '消歧义页' : undefined, updated: d.timestamp?.slice(0, 10), url: d.content_urls?.desktop?.page || wikiUrl(lang, d.title) }
}

/** 词条全文（纯文本，小标题转成 Markdown 的 ##）。sections 只要前几节（0 = 全部）；maxLength 最多多少字
 *  @example page('Retrieval-augmented generation', { maxLength: 6000 })
 *  @example page('大型语言模型', { sections: 3 }) */
export async function page(title, { lang = '', sections = 0, maxLength = 30000 } = {}) {
  lang = pickLang(lang, title)
  const j = await action(lang, `action=query&prop=extracts|info|description&inprop=url&explaintext=1&exsectionformat=wiki&redirects=1&titles=${encodeURIComponent(title)}`)
  const p = j?.query?.pages?.[0]
  if (!p || p.missing) throw new BxError('NOT_FOUND', `${lang}.wikipedia 没有词条 ${title}`, '先用 search 找准确的标题')
  let text = String(p.extract || '').replace(/^(=+)\s*(.+?)\s*\1$/gm, (_, eq, h) => `${'#'.repeat(Math.min(eq.length, 6))} ${h}`)
  if (!text.trim()) throw new BxError('EMPTY', `${p.title} 没有正文（可能是消歧义页）`)
  const heads = [...text.matchAll(/^## .+$/gm)]
  if (sections > 0 && heads.length >= sections) text = text.slice(0, heads[sections - 1].index)
  // 去掉"参考文献 / 外部链接"这类尾巴
  text = text.replace(/\n## (参考文献|参考资料|外部链接|注释|延伸阅读|参见|References|External links|See also|Further reading|Notes)\n[\s\S]*$/, '').replace(/\n{3,}/g, '\n\n').trim()
  const total = text.length
  if (total > maxLength) text = text.slice(0, maxLength) + `\n…（共 ${total} 字，调大 maxLength 看全部）`
  return { title: p.title, description: p.description, length: total, url: p.fullurl || wikiUrl(lang, p.title), content: text }
}

/** 昨天阅读量最高的词条（看大家在关注什么）。lang 默认 en
 *  @example trending({ limit: 20 })
 *  @example trending({ lang: 'zh', limit: 20 }) */
export async function trending({ lang = 'en', limit = 25 } = {}) {
  const d = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '/')
  const f = await get(`https://${lang}.wikipedia.org/api/rest_v1/feed/featured/${d}`, lang).catch(() => null)
  let list = (f?.mostread?.articles || []).map(a => ({ title: a.titles?.normalized || a.title, description: a.description, views: a.views }))
  if (!list.length) {
    const t = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${lang}.wikipedia/all-access/${d}`, lang)
    list = (t?.items?.[0]?.articles || []).filter(a => !/[:：]/.test(a.article) && a.article !== 'Main_Page').map(a => ({ title: a.article.replace(/_/g, ' '), views: a.views }))
  }
  if (!list.length) throw new BxError('EMPTY', `${lang}.wikipedia 没有阅读量数据`, '换个语言试试')
  return list.slice(0, limit).map((a, i) => ({ rank: i + 1, ...a, url: wikiUrl(lang, a.title) }))
}

/** 随机一个词条
 *  @example random() */
export async function random({ lang = 'en' } = {}) {
  const d = await get(`https://${lang}.wikipedia.org/api/rest_v1/page/random/summary`, lang)
  if (!d?.title) throw new BxError('EMPTY', '没取到随机词条', '再试一次')
  return { title: d.title, description: d.description, extract: d.extract, url: d.content_urls?.desktop?.page || wikiUrl(lang, d.title) }
}

/** 词条页 /wiki/<标题> 的读法：全文纯文本 */
export async function read(tab) {
  const m = (await tab.url()).match(/^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/(?:wiki|zh-\w+)\/([^?#]+)/)
  if (!m || /^(Special|Wikipedia|File|Category|Help|Talk|Template)[:：]/i.test(decodeURIComponent(m[2]))) return null
  const p = await page(decodeURIComponent(m[2]).replace(/_/g, ' '), { lang: m[1] })
  return { title: p.title, type: 'article', meta: { site: `${m[1]}.wikipedia`, description: p.description }, content: p.content }
}
