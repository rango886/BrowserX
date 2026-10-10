/* 站点笔记（百度搜索）：
 * - 中文内容（CSDN、知乎、贴吧、小红书转载、地方新闻）覆盖比 Google 好，英文内容差；不作为 Google 的默认兜底
 * - 结果块：#content_left > div[mu]，mu 属性就是真实网址（标题链接是 baidu.com/link?url= 跳转，不用解）
 * - 标题 h3 a；摘要的 class 带随机后缀（content-gap_xxx），用 [class*=content-right] / [class*=summary] / .c-abstract 兜底
 * - 时间过滤：gpc=stf=起始秒,结束秒|stftype=1
 * - 翻页 pn=10/20/…；请求太快会跳到 wappass.baidu.com 安全验证
 * - 热搜榜 top.baidu.com/api/board?platform=pc&tab=realtime|finance|livelihood|novel|movie|teleplay|car|game（公开接口，Node 直接 fetch）
 *     data.cards[0].content[]：word/query 词、hotScore 热度、desc 摘要、hotTag（1 新 3 热 …）、show 附加信息（影视 / 小说 / 汽车）
 */

function extract() {
  if (/wappass|captcha|verify/.test(location.href)) return { captcha: true, items: [] }
  const items = []
  for (const div of document.querySelectorAll('#content_left > div[mu]')) {
    const url = div.getAttribute('mu')
    const h3 = div.querySelector('h3')
    if (!url || !url.startsWith('http') || !h3 || /baidu\.com\/(sf|s\?)/.test(url)) continue
    const snip = div.querySelector('[class*="content-right"], [class*="summary-text"], [class*="summary"], .c-abstract, [data-module="abstract"], [class*="content-gap"]')
    const site = div.querySelector('[class*="site-name"], .c-showurl, [class*="source-text"]')
    items.push({ title: h3.innerText.trim(), url, site: site?.innerText.trim(), snippet: (snip?.innerText || '').replace(/\s+/g, ' ').trim() })
  }
  return { items, next: !!document.querySelector('#page a.n:last-child, #page-controller a.n') }
}

const SPAN = { h: 3600, d: 86400, w: 7 * 86400, m: 31 * 86400, y: 366 * 86400 }

/** 百度搜索（中文内容更全）。time：hour day week month year
 *  @example search('SQLite 生产环境', { limit: 20, time: 'year' }) */
export async function search(query, { limit = 10, time = '' } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const gpc = time && SPAN[time[0]] ? `&gpc=${encodeURIComponent(`stf=${now - SPAN[time[0]]},${now}|stftype=1`)}` : ''
  const out = []
  let tab
  try {
    for (let pn = 0; out.length < limit && pn < 100; pn += 10) {
      const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&pn=${pn}${gpc}`
      if (!tab) tab = await bx.open(url)
      else await tab.goto(url)
      await tab.waitFor({ fn: `document.querySelector('#content_left > div[mu], #content_left .nors, .content_none') || /wappass|captcha/.test(location.href)`, timeout: 10000 }).catch(() => {})
      const r = await tab.eval(extract)
      if (r.captcha) throw new BxError('BLOCKED', '被百度安全验证拦住了', '停一会儿再试，或者请用户在浏览器里打开 baidu.com 验证一次')
      const before = out.length
      for (const it of r.items) {
        if (out.some(o => o.url === it.url)) continue
        out.push({ rank: out.length + 1, ...it, engine: 'baidu' })
        if (out.length >= limit) break
      }
      if (!r.next || out.length === before) break
      await bx.sleep(1000 + Math.random() * 1000)
    }
  } finally {
    if (tab && !process.env.BX_KEEP_TABS) await tab.close().catch(() => {})
  }
  if (!out.length) throw new BxError('EMPTY', `百度没有搜到“${query}”`, '换个关键词，或者去掉 time 限制')
  return out
}


const HOT_TAG = { 1: '新', 2: '商', 3: '热', 4: '沸', 5: '爆' }

/** 百度热搜榜（不用开浏览器）。board：realtime 热搜 finance 财经 livelihood 民生 novel 小说 movie 电影 teleplay 电视剧 car 汽车 game 游戏
 *  @example hot({ limit: 20 })
 *  @example hot({ board: 'finance' }) */
export async function hot({ board = 'realtime', limit = 50 } = {}) {
  let j
  try {
    j = await fetch(`https://top.baidu.com/api/board?platform=pc&tab=${encodeURIComponent(board)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36' } }).then(r => r.json())
  } catch (e) {
    throw new BxError('HTTP_ERROR', `百度热搜接口出错：${e.message}`)
  }
  if (!j.success) throw new BxError('BAD_ARGS', `没有这个榜单：${board}（${j.error?.message || ''}）`, 'board 只能是 realtime finance livelihood novel movie teleplay car game')
  const list = j.data?.cards?.[0]?.content
  if (!Array.isArray(list)) throw new BxError('CHANGED', '百度热搜接口的返回结构变了', '去修 baidu.com hot')
  return list.slice(0, limit).map((x, i) => ({
    rank: i + 1,
    title: x.word || x.query,
    heat: x.hotScore ? +x.hotScore : undefined,
    tag: HOT_TAG[x.hotTag] || undefined,
    pinned: x.isTop || undefined,
    desc: x.desc ? String(x.desc).slice(0, 200) : undefined,
    info: x.show?.length ? x.show.join('；') : undefined,
    url: x.rawUrl || x.url || x.appUrl,
  }))
}