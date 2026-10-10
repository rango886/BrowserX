/* 站点笔记（微信公众号文章）：
 * - 搜索走搜狗微信 weixin.sogou.com/weixin?type=2&query=&page=（每页 10 条，最多 10 页左右）；不用登录，登录搜狗后能翻更多页
 *   结果卡片 .news-list li：h3 a 标题（href 是 /link?url=… 跳转链接，要在浏览器里打开才会跳到 mp.weixin.qq.com）、
 *   p.txt-info 摘要、.s-p .all-time-y2 / .account 公众号名、.s-p .s2 里 timeConvert('秒级时间戳')
 * - 请求多了搜狗会出验证码（页面跳到 antispider），报 BLOCKED，请用户在浏览器里过一下
 * - 文章页 mp.weixin.qq.com/s/…：#activity-name 标题、#js_name 公众号、#publish_time 时间、#js_content 正文
 *   正文里的图片是懒加载的 data-src；代码块是 .code-snippet__fix
 * - 文章被删 / 违规时页面显示“该内容已被发布者删除”之类，报 NOT_FOUND
 */

/** 搜公众号文章（搜狗微信）。pages 翻几页（每页 10 条）
 *  @example search('双汇 处罚', { pages: 1 }) */
export async function search(q, { pages = 1, limit = 30 } = {}) {
  const tab = await bx.open('about:blank')
  const out = []
  try {
    for (let p = 1; p <= pages && out.length < limit; p++) {
      await tab.goto(`https://weixin.sogou.com/weixin?type=2&ie=utf8&query=${encodeURIComponent(q)}&page=${p}`)
      await tab.waitFor({ selector: '.news-list, .no-sosuo, #seccodeForm', timeout: 15000 }).catch(() => {})
      const r = await tab.eval(() => {
        if (/antispider/.test(location.href) || document.querySelector('#seccodeForm')) return { blocked: true }
        const clean = s => (s || '').replace(/\s+/g, ' ').trim()
        return {
          rows: [...document.querySelectorAll('.news-list li')].map(li => {
            const a = li.querySelector('h3 a[href]')
            const ts = li.querySelector('.s-p .s2')?.innerHTML.match(/timeConvert\('(\d+)'\)/)?.[1] || li.querySelector('.s-p')?.getAttribute('t')
            return {
              title: clean(a?.textContent),
              account: clean(li.querySelector('.s-p .all-time-y2, .s-p .account')?.textContent),
              time: ts ? new Date(ts * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined,
              summary: clean(li.querySelector('p.txt-info')?.textContent),
              url: a ? new URL(a.getAttribute('href'), location.origin).href : '',
            }
          }),
        }
      })
      if (r.blocked) throw new BxError('BLOCKED', '搜狗微信出了验证码', `bx tab activate ${tab.id} 在浏览器里输一下验证码再试`)
      const rows = r.rows.filter(x => x.title && x.url)
      out.push(...rows)
      if (rows.length < 10) break
      await bx.sleep(1000)
    }
  } finally {
    await tab.close().catch(() => {})
  }
  if (!out.length) throw new BxError('EMPTY', `没有搜到公众号文章：${q}`, '换个关键词')
  return out.slice(0, limit)
}

async function articleOn(tab) {
  await tab.waitFor({ selector: '#js_content, .weui-msg, #js_article', timeout: 20000 }).catch(() => {})
  const a = await tab.eval(() => {
    if (/antispider/.test(location.href)) return { blocked: true }
    const body = document.querySelector('#js_content')
    if (!body) return { gone: document.body.innerText.replace(/\s+/g, ' ').slice(0, 100) }
    const c = body.cloneNode(true)
    c.querySelectorAll('.code-snippet__line-index, script, style').forEach(x => x.remove())
    c.querySelectorAll('img').forEach(img => img.replaceWith(`[图](${img.getAttribute('data-src') || img.src})`))
    c.querySelectorAll('pre, .code-snippet__fix').forEach(pre => pre.replaceWith('\n```\n' + pre.innerText + '\n```\n'))
    const text = c.innerText.replace(/\n{3,}/g, '\n\n').trim()
    return {
      title: (document.querySelector('#activity-name')?.innerText || document.querySelector('meta[property="og:title"]')?.content || '').trim(),
      account: document.querySelector('#js_name')?.innerText.trim(),
      author: document.querySelector('#js_author_name, .rich_media_meta_text')?.innerText.trim() || undefined,
      time: document.querySelector('#publish_time')?.innerText.trim(),
      location: document.querySelector('#js_ip_wording')?.innerText.trim() || undefined,
      content: text,
      url: location.href.split('#')[0],
    }
  })
  if (a.blocked) throw new BxError('BLOCKED', '搜狗跳转出了验证码', `bx tab activate ${tab.id} 处理一下再试`)
  if (a.gone !== undefined) throw new BxError('NOT_FOUND', `文章打不开：${a.gone}`, '可能已被删除，或者链接过期（搜狗链接有时效，重新搜一次）')
  return a
}

/** 公众号文章全文。url 可以是 mp.weixin.qq.com 链接，也可以是搜索结果里的搜狗跳转链接
 *  @example article('https://mp.weixin.qq.com/s/xxxxxxxx') */
export async function article(url) {
  const tab = await bx.open(url)
  try {
    if (/sogou\.com\/link/.test(url)) await tab.waitFor({ url: 'mp.weixin.qq.com', timeout: 15000 }).catch(() => {})
    return await articleOn(tab)
  } finally {
    await tab.close().catch(() => {})
  }
}

/** 公众号文章页的读法 */
export async function read(tab) {
  const url = await tab.url()
  if (!/mp\.weixin\.qq\.com\/s/.test(url)) return null
  const a = await articleOn(tab)
  return { title: a.title, meta: { author: a.author || a.account, published: a.time, site: a.account ? `公众号 · ${a.account}` : '微信公众号' }, content: a.content }
}
