/* 站点笔记（Google 搜索）：
 * - 没有公开接口，走“后台开标签 → 等结果出来 → 在页面里提取”
 * - 结果块的 class 经常变：标题用 `a h3` 找最稳，摘要的选择器有好几个备选
 * - 请求太频繁会被重定向到 /sorry（人机验证）。所以 search 做了三层保护：
 *   1. 排队：同一个进程里的 search 一个接一个发，间隔 1.5~3 秒。调用方照样可以 Promise.all 并行写
 *   2. 退避：碰到验证先等 10~15 秒重试一次；还不行就记下“10 分钟内别再碰 Google”，后面排队的直接走兜底
 *   3. 兜底（默认开）：依次试 bing.com、duckduckgo.com，结果里 engine 字段标明来源。
 *      fallback: false 关掉兜底，这时被拦就保留标签抛 BLOCKED，让用户切过去手动验证一次
 * - 翻页用 start=10/20/…，页间停 800ms 左右；翻到一半被拦，就返回已经拿到的部分
 * - 下面这几个是公开接口，Node 直接 fetch，不开标签、也不会触发人机验证：
 *     联想词 suggestqueries.google.com/complete/search?client=firefox&q=&hl=
 *     新闻 news.google.com/rss/search?q=&hl=en-US&gl=US&ceid=US:en（RSS；中文 hl=zh-CN&gl=CN&ceid=CN:zh-Hans；q 里可以写 when:7d 限定时间）
 *       链接是 news.google.com/rss/articles/… 的跳转地址，浏览器打开会跳到原文
 *     热搜 trends.google.com/trending/rss?geo=US（RSS，ht:approx_traffic 搜索量，ht:news_item 相关新闻）
 */

/** 在页面里执行：提取当前结果页 */
function extract() {
  if (location.pathname.startsWith('/sorry')) return { captcha: true }
  const seen = new Set()
  const items = []
  for (const h of document.querySelectorAll('#search a h3, #rso a h3')) {
    const a = h.closest('a')
    if (!a || seen.has(a.href) || !a.href.startsWith('http')) continue
    seen.add(a.href)
    const box = a.closest('.MjjYud, .g, [data-hveid]') || a.parentElement
    const snip = box?.querySelector('.VwiC3b, [data-sncf], .IsZvec, [style*="-webkit-line-clamp"]')
    const site = box?.querySelector('cite')
    items.push({ title: h.innerText.trim(), url: a.href, site: site?.innerText.split('›')[0].trim(), snippet: (snip?.innerText || '').replace(/\s+/g, ' ').trim() })
  }
  const next = !!document.querySelector('#pnnext, a[aria-label="下一页"], a[aria-label="Next page"]')
  return { items, next }
}

// 进程内共享的排队状态（挂在 globalThis 上：函数库文件被重新加载也不会丢）
const Q = (globalThis.__bxGoogle ||= { chain: Promise.resolve(), last: 0, blockedUntil: 0 })
const COOLDOWN = 10 * 60 * 1000

/** 排队拿一个“发请求”的名额；返回释放函数 */
async function slot() {
  const prev = Q.chain
  let release
  Q.chain = new Promise(r => (release = r))
  await prev.catch(() => {})
  const wait = 1500 + Math.random() * 1500 - (Date.now() - Q.last)
  if (wait > 0) await bx.sleep(wait)
  return () => {
    Q.last = Date.now()
    release()
  }
}

/** fallback 参数规整成域名列表：默认 bing + duckduckgo；false / 'false' / 'none' 关掉 */
function engines(fallback) {
  if (fallback === false || fallback == null || /^(false|none|off|0)$/i.test(String(fallback))) return []
  const list = fallback === true ? ['bing', 'duckduckgo'] : Array.isArray(fallback) ? fallback : String(fallback).split(/[,\s]+/)
  return list.filter(Boolean).map(e => (e.includes('.') ? e : { bing: 'bing.com', duckduckgo: 'duckduckgo.com', ddg: 'duckduckgo.com', baidu: 'baidu.com' }[e] || e + '.com'))
}

async function viaFallback(query, opts, list, why) {
  const errors = [why]
  for (const domain of list) {
    try {
      const r = await bx.lib(domain).search(query, { limit: opts.limit, lang: opts.lang, time: opts.time })
      bx.log(`⚠ Google 不可用（${why}），“${query}”改用 ${domain} 搜索`)
      return r
    } catch (e) {
      if (e.code === 'EMPTY') throw e
      errors.push(`${domain}: [${e.code || 'ERROR'}] ${e.message}`)
    }
  }
  throw new BxError('BLOCKED', `Google 和兜底引擎都没搜成：${errors.join('；')}`, '停几分钟再试；或者请用户在浏览器里打开 google.com 做一次人机验证')
}

/** 搜索，返回标题 / 链接 / 摘要（engine 字段标明实际用的哪个引擎）。time：hour day week month year。
 *  被人机验证拦住时自动改用 fallback 里的引擎（默认 'bing,duckduckgo'；传 false 关掉）
 *  @example search('sqlite production', { limit: 20, time: 'year' })
 *  @example search('sqlite production', { fallback: false })   // 只要 Google 的结果 */
export async function search(query, { limit = 10, lang = 'zh-CN', time = '', fallback = 'bing,duckduckgo', retry = 1 } = {}) {
  const list = engines(fallback)
  const opts = { limit, lang, time }
  // 刚被拦过：别再去碰 Google，直接兜底
  if (Date.now() < Q.blockedUntil && list.length) return viaFallback(query, opts, list, `${Math.ceil((Q.blockedUntil - Date.now()) / 60000)} 分钟前刚被人机验证拦过`)

  const tbs = time ? `&tbs=qdr:${time[0]}` : ''
  const out = []
  let tab
  let keep = false
  let blocked = false
  const release = await slot()
  try {
    for (let start = 0; out.length < limit && start < 100; start += 10) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=${lang}&start=${start}${tbs}`
      let r
      for (let attempt = 0; ; attempt++) {
        if (!tab) tab = await bx.open(url)
        else await tab.goto(url)
        await tab.waitFor({ fn: `document.querySelector('#search h3, #rso h3, #botstuff') || location.pathname.startsWith('/sorry')`, timeout: 10000 }).catch(() => {})
        r = await tab.eval(extract)
        if (!r.captcha || attempt >= retry || out.length) break
        await bx.sleep(10000 + Math.random() * 5000)
      }
      if (r.captcha) {
        Q.blockedUntil = Date.now() + COOLDOWN
        if (out.length) {
          bx.log(`⚠ Google 翻到第 ${start / 10 + 1} 页时被人机验证拦住，只返回前 ${out.length} 条`)
          break
        }
        if (list.length) {
          blocked = true
          break
        }
        keep = true
        throw new BxError('BLOCKED', '被 Google 人机验证拦住了', `请用户在浏览器里处理：bx tab activate ${tab.id}，验证完再重试（或者去掉 fallback: false，让它自动改用必应）`)
      }
      for (const it of r.items) {
        out.push({ rank: out.length + 1, ...it, engine: 'google' })
        if (out.length >= limit) break
      }
      if (!r.next || !r.items.length) break
      await bx.sleep(800 + Math.random() * 600)
    }
  } finally {
    release()
    if (tab && !keep && !process.env.BX_KEEP_TABS) await tab.close().catch(() => {})
  }
  if (blocked) return viaFallback(query, opts, list, '被人机验证拦住')
  if (!out.length) throw new BxError('EMPTY', `没有搜到“${query}”`, '换个关键词，或者去掉 time 限制')
  return out
}


const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' }
const xmlText = s => (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&(#39|apos);/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).trim()
const tag = (x, name) => x.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1]
async function getText(url) {
  let r
  try {
    r = await fetch(url, { headers: UA })
  } catch (e) {
    throw new BxError('HTTP_ERROR', `连不上 ${new URL(url).host}：${e.cause?.code || e.message}`, '检查网络（可能要代理）')
  }
  if (r.status === 429) throw new BxError('BLOCKED', 'Google 限流了', '停一会儿再试')
  if (!r.ok) throw new BxError('HTTP_ERROR', `HTTP ${r.status} ${url}`)
  return r.text()
}
const isCJK = s => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(s)

/** 搜索联想词（大家常搜的说法，用来扩展关键词）
 *  @example suggest('sqlite vs')
 *  @example suggest('大模型 推理', { lang: 'zh-CN' }) */
export async function suggest(q, { lang = '' } = {}) {
  const hl = lang || (isCJK(q) ? 'zh-CN' : 'en')
  const t = await getText(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}&hl=${hl}`)
  let j
  try {
    j = JSON.parse(t)
  } catch {
    throw new BxError('CHANGED', '联想词接口返回的不是 JSON')
  }
  const list = (j[1] || []).filter(s => s !== q)
  if (!list.length) throw new BxError('EMPTY', `“${q}”没有联想词`)
  return list.map((s, i) => ({ rank: i + 1, query: s }))
}

/** Google 新闻（按关键词；不写关键词 = 头条）。region：US / CN / HK / TW / JP / GB…（默认按关键词语言选）；days：只要最近几天
 *  @example news('deno cloudflare', { limit: 20 })
 *  @example news('英伟达 财报', { days: 7 }) */
export async function news(q = '', { region = '', days = 0, limit = 30 } = {}) {
  const R = { US: ['en-US', 'US:en'], GB: ['en-GB', 'GB:en'], CN: ['zh-CN', 'CN:zh-Hans'], HK: ['zh-HK', 'HK:zh-Hant'], TW: ['zh-TW', 'TW:zh-Hant'], JP: ['ja', 'JP:ja'], KR: ['ko', 'KR:ko'], DE: ['de', 'DE:de'], FR: ['fr', 'FR:fr'], SG: ['en-SG', 'SG:en'], IN: ['en-IN', 'IN:en'] }
  const gl = (region || (isCJK(q) ? 'CN' : 'US')).toUpperCase()
  const [hl, ceid] = R[gl] || [`en-${gl}`, `${gl}:en`]
  const query = [q, days ? `when:${days}d` : ''].filter(Boolean).join(' ')
  const url = query ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}` : `https://news.google.com/rss?hl=${hl}&gl=${gl}&ceid=${ceid}`
  const xml = await getText(url)
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1])
  if (!items.length) throw new BxError('EMPTY', `Google 新闻没有“${q}”的结果`, '换个关键词或去掉 days')
  return items.slice(0, limit).map((x, i) => {
    const source = xmlText(tag(x, 'source'))
    let title = xmlText(tag(x, 'title'))
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3))
    const d = tag(x, 'pubDate')
    return { rank: i + 1, title, source: source || undefined, time: d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : undefined, url: xmlText(tag(x, 'link')) }
  })
}

/** Google 热搜（每天的搜索趋势）：词、大致搜索量、相关新闻。region：US / JP / GB / HK / TW / SG…（Google Trends 不支持 CN）
 *  @example trends({ region: 'US', limit: 20 }) */
export async function trends({ region = 'US', limit = 20 } = {}) {
  const xml = await getText(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(region.toUpperCase())}`)
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1])
  if (!items.length) throw new BxError('EMPTY', `${region} 没有热搜数据`, 'region 写两位国家代码，比如 US、JP；不支持 CN')
  return items.slice(0, limit).map((x, i) => {
    const n = [...x.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)].map(m => m[1])
    const d = tag(x, 'pubDate')
    return {
      rank: i + 1,
      query: xmlText(tag(x, 'title')),
      traffic: xmlText(tag(x, 'ht:approx_traffic')) || undefined,
      time: d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : undefined,
      news: n.slice(0, 3).map(y => `${xmlText(tag(y, 'ht:news_item_title'))}（${xmlText(tag(y, 'ht:news_item_source'))}）`).join('；') || undefined,
      newsUrl: n[0] ? xmlText(tag(n[0], 'ht:news_item_url')) : undefined,
      url: `https://www.google.com/search?q=${encodeURIComponent(xmlText(tag(x, 'title')))}`,
    }
  })
}