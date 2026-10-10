/* 站点笔记（必应搜索）：
 * - 没有公开接口，走“后台开标签 → 等结果出来 → 在页面里提取”，和 google.com.js 一个套路
 * - 结果块：#b_results > li.b_algo；标题 h2 a；摘要 .b_lineclamp2 / .b_caption p；来源 cite
 * - 标题链接有时是 bing.com/ck/a?…&u=a1<base64> 的跳转链接，u 参数去掉 a1 再 base64 解码就是真实网址
 * - 时间过滤：filters=ex1:"ez1"(天) ez2(周) ez3(月)；一年用 ex1:"ez5_起始日_结束日"（从 1970 起的天数）
 * - 翻页用 first=11/21/…；国内可能被重定向到 cn.bing.com，结构一样
 * - 也是 google.com.js 的兜底引擎（Google 被人机验证拦住时自动改用）
 */

/** 在页面里执行：提取当前结果页 */
function extract() {
  const real = href => {
    try {
      const u = new URL(href)
      if (/bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/')) {
        const p = u.searchParams.get('u')
        if (p && p.startsWith('a1')) return atob(p.slice(2).replace(/-/g, '+').replace(/_/g, '/'))
      }
    } catch {}
    return href
  }
  const items = []
  const seen = new Set()
  for (const li of document.querySelectorAll('#b_results > li.b_algo')) {
    const a = li.querySelector('h2 a')
    if (!a) continue
    const url = real(a.href)
    if (!url.startsWith('http') || seen.has(url)) continue
    seen.add(url)
    const text = el => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
    const snip = li.querySelector('.b_lineclamp2, .b_lineclamp3, .b_lineclamp4, .b_caption p, .b_algoSlug, p')
    const cite = li.querySelector('cite')
    const title = text(a) || a.getAttribute('aria-label') || text(li.querySelector('h2'))
    if (!title) continue
    items.push({ title, url, site: text(cite).split('›')[0].trim() || undefined, snippet: text(snip) })
  }
  const next = !!document.querySelector('a.sb_pagN, a[title="下一页"], a[title="Next page"]')
  const captcha = !!document.querySelector('#b_captcha, .captcha') || /\/challenge|captcha/i.test(location.href)
  return { items, next, captcha }
}

function timeFilter(time) {
  if (!time) return ''
  const k = time[0]
  if (k === 'h' || k === 'd') return 'ex1:"ez1"'
  if (k === 'w') return 'ex1:"ez2"'
  if (k === 'm') return 'ex1:"ez3"'
  if (k === 'y') {
    const today = Math.floor(Date.now() / 86400000)
    return `ex1:"ez5_${today - 365}_${today}"`
  }
  return ''
}

/** 必应搜索，返回标题 / 链接 / 摘要。time：hour day week month year（hour 按 day 算）
 *  @example search('sqlite production', { limit: 20, time: 'year' }) */
export async function search(query, { limit = 10, lang = 'zh-CN', time = '' } = {}) {
  const setlang = /^zh/i.test(lang) ? 'zh-Hans' : lang
  // 不带 mkt 时偶尔会把中文关键词当成日文汉字来搜
  const mkt = /^zh/i.test(lang) ? '&mkt=zh-CN' : /^en/i.test(lang) ? '&mkt=en-US' : ''
  const filters = timeFilter(time)
  const out = []
  let tab
  try {
    for (let first = 1; out.length < limit && first < 100; first += 10) {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=${setlang}${mkt}&first=${first}${filters ? '&filters=' + encodeURIComponent(filters) : ''}`
      if (!tab) tab = await bx.open(url)
      else await tab.goto(url)
      await tab.waitFor({ fn: `document.querySelector('#b_results > li.b_algo, #b_results .b_no, #b_captcha')`, timeout: 10000 }).catch(() => {})
      const r = await tab.eval(extract)
      if (r.captcha) throw new BxError('BLOCKED', '被必应人机验证拦住了', '停一会儿再试，或者请用户在浏览器里打开 bing.com 验证一次')
      const before = out.length
      for (const it of r.items) {
        if (out.some(o => o.url === it.url)) continue
        out.push({ rank: out.length + 1, ...it, engine: 'bing' })
        if (out.length >= limit) break
      }
      if (!r.next || out.length === before) break
      await bx.sleep(800 + Math.random() * 700)
    }
  } finally {
    if (tab && !process.env.BX_KEEP_TABS) await tab.close().catch(() => {})
  }
  if (!out.length) throw new BxError('EMPTY', `必应没有搜到“${query}”`, '换个关键词，或者去掉 time 限制')
  return out
}
