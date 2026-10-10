/* 站点笔记（DuckDuckGo 搜索）：
 * - html.duckduckgo.com 的纯 HTML 版会出“选鸭子”人机验证，用不了；走 JS 版 duckduckgo.com/?q=
 * - 结果块：article[data-testid=result]；标题 a[data-testid=result-title-a]（href 就是真实网址）；摘要 [data-result=snippet]
 * - 翻页：点 #more-results 按钮，结果追加在同一页
 * - 时间过滤 df=d/w/m/y；地区 kl=wt-wt（不限）/ cn-zh / us-en
 * - google.com.js 的第二个兜底引擎
 */

function extract() {
  const items = []
  for (const art of document.querySelectorAll('article[data-testid=result]')) {
    const a = art.querySelector('a[data-testid=result-title-a]')
    if (!a || !a.href.startsWith('http')) continue
    const snip = art.querySelector('[data-result=snippet]')
    const site = art.querySelector('[data-testid=result-extras-url-link], a[data-testid=result-extras-url-link] span')
    items.push({ title: a.innerText.trim(), url: a.href, site: site?.innerText.trim(), snippet: (snip?.innerText || '').replace(/\s+/g, ' ').trim() })
  }
  return { items, more: !!document.querySelector('#more-results'), captcha: /anomaly|challenge/i.test(document.body.innerText.slice(0, 500)) && !items.length }
}

/** DuckDuckGo 搜索，返回标题 / 链接 / 摘要。time：day week month year；region：wt-wt（默认，不限）/ cn-zh / us-en
 *  @example search('sqlite production', { limit: 20, time: 'year' }) */
export async function search(query, { limit = 10, time = '', region = 'wt-wt' } = {}) {
  const df = time ? `&df=${time[0] === 'h' ? 'd' : time[0]}` : ''
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&kl=${region}${df}&ia=web`
  const tab = await bx.open(url)
  try {
    await tab.waitFor({ fn: `document.querySelector('article[data-testid=result], [data-testid=no-results-message]')`, timeout: 12000 }).catch(() => {})
    let r = await tab.eval(extract)
    if (r.captcha) throw new BxError('BLOCKED', '被 DuckDuckGo 人机验证拦住了', '停一会儿再试')
    // 不够就点“更多结果”，最多点 5 次
    for (let i = 0; i < 5 && r.items.length < limit && r.more; i++) {
      const n = r.items.length
      await tab.eval(() => document.querySelector('#more-results')?.click())
      await tab.waitFor({ fn: `document.querySelectorAll('article[data-testid=result]').length > ${n}`, timeout: 8000 }).catch(() => {})
      r = await tab.eval(extract)
      if (r.items.length === n) break
    }
    const seen = new Set()
    const out = r.items.filter(it => !seen.has(it.url) && seen.add(it.url)).slice(0, limit).map((it, i) => ({ rank: i + 1, ...it, engine: 'duckduckgo' }))
    if (!out.length) throw new BxError('EMPTY', `DuckDuckGo 没有搜到“${query}”`, '换个关键词，或者去掉 time 限制')
    return out
  } finally {
    if (!process.env.BX_KEEP_TABS) await tab.close().catch(() => {})
  }
}
