/* 站点笔记（Google 搜索）：
 * - 没有公开接口，走“后台开标签 → 等结果出来 → 在页面里提取”
 * - 结果块的 class 经常变：标题用 `a h3` 找最稳，摘要的选择器有好几个备选
 * - 请求太频繁会被重定向到 /sorry（人机验证）。所以 search 做了三层保护：
 *   1. 排队：同一个进程里的 search 一个接一个发，间隔 1.5~3 秒。调用方照样可以 Promise.all 并行写
 *   2. 退避：碰到验证先等 10~15 秒重试一次；还不行就记下“10 分钟内别再碰 Google”，后面排队的直接走兜底
 *   3. 兜底（默认开）：依次试 bing.com、duckduckgo.com，结果里 engine 字段标明来源。
 *      fallback: false 关掉兜底，这时被拦就保留标签抛 BLOCKED，让用户切过去手动验证一次
 * - 翻页用 start=10/20/…，页间停 800ms 左右；翻到一半被拦，就返回已经拿到的部分
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
