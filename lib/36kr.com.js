/* 站点笔记（36氪）：
 * - 不用登录
 * - 页面里有 window.initialState：
 *     热榜 /hot-list/catalog → hotListData.topList / hotList / ...（每项 itemId、widgetTitle、authorName、publishTime 毫秒、statHot）
 *     文章 /p/<itemId> → articleDetail.articleDetailData.data（widgetTitle、widgetContent 是 HTML、author、publishTime、summary）
 *     快讯 /newsflashes → newsflashList.newsflashList.data.itemList（templateMaterial.widgetTitle / widgetContent / publishTime）
 * - 搜索页 /search/articles/<词> 的 initialState 是加密的，翻页接口要 sign，所以直接读 DOM（.kr-flow-article-item），滚动加载更多
 */

const time = ms => (ms ? new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined)
const strip = h => String(h || '').replace(/<(br|\/p|\/h\d|\/li|\/blockquote)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()

async function pageState(url, pick) {
  const tab = await bx.open(url)
  try {
    await tab.waitFor({ fn: 'window.initialState', timeout: 15000 }).catch(() => {})
    return await tab.eval(pick)
  } finally {
    await tab.close().catch(() => {})
  }
}

/** 36氪热榜（综合热榜，另有人气 / 收藏 / 评论榜）
 *  @example hot({ limit: 20 }) */
export async function hot({ limit = 30 } = {}) {
  const s = await pageState('https://www.36kr.com/hot-list/catalog', () => JSON.parse(JSON.stringify(window.initialState?.hotListData || null)))
  if (!s) throw new BxError('CHANGED', '36氪热榜页没有 hotListData', '去修 hot')
  const list = s.topList || s.hotList || Object.values(s).find(Array.isArray) || []
  return list.slice(0, limit).map((x, i) => ({ rank: x.rank || i + 1, title: x.widgetTitle, author: x.authorName, heat: x.statHot, time: time(x.publishTime), summary: x.summary || undefined, url: `https://36kr.com/p/${x.itemId}` }))
}

/** 搜文章（读搜索结果页）
 *  @example search('双汇', { limit: 20 }) */
export async function search(q, { limit = 20 } = {}) {
  const tab = await bx.open(`https://www.36kr.com/search/articles/${encodeURIComponent(q)}`)
  try {
    await tab.waitFor({ selector: '.kr-flow-article-item, .kr-search-result-empty', timeout: 15000 }).catch(() => {})
    let rows = []
    for (let i = 0; i < 6; i++) {
      const got = await tab.eval(() =>
        [...document.querySelectorAll('.kr-flow-article-item')].map(li => {
          const a = li.querySelector('a.article-item-title') || li.querySelector('a[href*="/p/"]')
          return {
            title: a?.innerText.trim(),
            summary: li.querySelector('.article-item-description')?.innerText.trim() || undefined,
            author: li.querySelector('.kr-flow-bar-author')?.innerText.trim() || undefined,
            time: li.querySelector('.kr-flow-bar-time')?.innerText.trim() || li.innerText.match(/\d{4}-\d{2}-\d{2}/)?.[0],
            url: a ? new URL(a.getAttribute('href'), 'https://36kr.com').href.split('?')[0] : '',
          }
        }),
      )
      if (got.length <= rows.length) break
      rows = got
      if (rows.length >= limit) break
      const more = await tab.eval(() => {
        const b = document.querySelector('.kr-search-result-more, .kr-loading-more-button')
        if (b) b.click()
        else window.scrollTo(0, document.body.scrollHeight)
        return true
      })
      if (!more) break
      await bx.sleep(1200)
    }
    rows = rows.filter(r => r.title && r.url)
    if (!rows.length) throw new BxError('EMPTY', `36氪没有搜到 ${q}`, '换个关键词')
    return rows.slice(0, limit)
  } finally {
    await tab.close().catch(() => {})
  }
}

/** 文章全文。url 是 36kr.com/p/<id> 链接或 id
 *  @example article('https://36kr.com/p/4018115010809730') */
export async function article(url) {
  const id = String(url).match(/\/p\/(\d+)/)?.[1] || String(url).match(/^\d+$/)?.[0]
  if (!id) throw new BxError('BAD_ARGS', '要 36kr.com/p/<id> 链接或 id')
  const d = await pageState(`https://www.36kr.com/p/${id}`, () => JSON.parse(JSON.stringify(window.initialState?.articleDetail?.articleDetailData || null)))
  if (!d || d.code !== 0 || !d.data) throw new BxError('NOT_FOUND', `36氪文章 ${id} 不存在：${d?.msg || ''}`)
  const a = d.data
  return { id, title: a.widgetTitle, author: a.author || a.authorName, time: time(a.publishTime), summary: a.summary || undefined, content: strip(a.widgetContent), url: `https://36kr.com/p/${id}` }
}

/** 最新快讯
 *  @example newsflash({ limit: 20 }) */
export async function newsflash({ limit = 30 } = {}) {
  const list = await pageState('https://www.36kr.com/newsflashes', () => JSON.parse(JSON.stringify(window.initialState?.newsflashList?.newsflashList?.data?.itemList || window.initialState?.newsflashCatalogData?.data?.newsflashList?.data?.itemList || [])))
  if (!list.length) throw new BxError('CHANGED', '36氪快讯页没解析出数据', '去修 newsflash')
  return list.slice(0, limit).map(x => {
    const m = x.templateMaterial || x
    return { title: m.widgetTitle, content: strip(m.widgetContent), time: time(m.publishTime), url: `https://36kr.com/newsflashes/${x.itemId || m.itemId}` }
  })
}

/** 文章页的读法 */
export async function read(tab) {
  const url = await tab.url()
  if (!/36kr\.com\/p\/\d+/.test(url)) return null
  const a = await article(url)
  return { title: a.title, meta: { author: a.author, published: a.time, site: '36氪' }, content: [a.summary ? `> ${a.summary}\n` : '', a.content].join('\n') }
}
