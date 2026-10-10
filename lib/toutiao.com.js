/* 站点笔记（今日头条）：
 * @login optional 热榜、搜索、文章不登录也能看；登录后搜索结果更多、不容易出验证码
 * - 热榜：公开接口 https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc（Node 直接请求）
 * - 搜索没有 JSON 接口，抓 so.toutiao.com/search?keyword=&pd=information&page_num=（0 起）的 HTML：
 *   .result-content 里 [data-log-extra] 是 JSON（group_id、result_type），标题 .cs-header a，来源时间 .cs-source
 *   pd：information 资讯 / synthesis 综合 / weitoutiao 微头条 / video 视频
 * - 文章页 www.toutiao.com/article/<group_id>/：h1 标题、.article-meta 时间来源、.article-content 正文
 * - 评论：/article/v4/tab_comments/?aid=24&app_name=toutiao_web&group_id=&item_id=&offset=&count=20（在页面里请求，带 cookie）
 * - 偶尔会出滑块验证码（页面里有 #captcha_container），出现了就报 BLOCKED
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const gid = x => String(x).match(/(?:article|group|a|i)\/?(\d{15,})/)?.[1] || String(x).match(/^\d{15,}$/)?.[0]

/** 头条热榜
 *  @example hot({ limit: 20 }) */
export async function hot({ limit = 50 } = {}) {
  const r = await fetch('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', { headers: { 'User-Agent': UA, Referer: 'https://www.toutiao.com/' } })
  const j = await r.json()
  return (j.data || []).slice(0, limit).map((x, i) => ({
    rank: i + 1,
    title: x.Title,
    heat: Number(x.HotValue) || undefined,
    label: x.LabelDesc || x.Label || undefined,
    id: x.ClusterIdStr || String(x.ClusterId || ''),
    url: x.Url?.split('?')[0] || `https://www.toutiao.com/trending/${x.ClusterIdStr}/`,
  }))
}

/** 搜索资讯（抓头条搜索结果页）。type：information 资讯 / synthesis 综合 / weitoutiao 微头条；pages 翻几页（每页约 10 条）
 *  @example search('双汇 罚款', { pages: 2 }) */
export async function search(q, { type = 'information', pages = 1, limit = 50 } = {}) {
  const tab = await bx.open('about:blank')
  const out = []
  try {
    for (let p = 0; p < pages && out.length < limit; p++) {
      await tab.goto(`https://so.toutiao.com/search?dvpf=pc&source=input&keyword=${encodeURIComponent(q)}&pd=${type}&page_num=${p}`)
      await tab.waitFor({ selector: '.result-content, #captcha_container, .no-result', timeout: 15000 }).catch(() => {})
      const r = await tab.eval(() => {
        if (document.querySelector('#captcha_container, .captcha_verify_container')) return { captcha: true }
        return {
          rows: [...document.querySelectorAll('.result-content')].map(c => {
            let ex = {}
            try {
              ex = JSON.parse(c.querySelector('[data-log-extra]')?.getAttribute('data-log-extra') || '{}')
            } catch {}
            const a = c.querySelector('.cs-header a')
            const src = (c.querySelector('.cs-source')?.innerText || '').replace(/\s+/g, ' ').trim()
            const title = (a?.innerText || '').trim()
            const body = c.innerText.replace(/\s+/g, ' ').replace(title, '').replace(src, '').trim()
            let url = ''
            try {
              url = new URL(a?.href || '').searchParams.get('url') || a?.href || ''
            } catch {}
            return { type: ex.result_type, id: ex.group_id, title, source: src, snippet: body.slice(0, 200), url }
          }),
        }
      })
      if (r.captcha) throw new BxError('BLOCKED', '头条搜索出了验证码', `bx tab activate ${tab.id} 在浏览器里处理一下再试`)
      const rows = r.rows.filter(x => x.title)
      for (const x of rows) {
        if (/^\d{15,}$/.test(x.id || '') && /article|self_/.test(x.type || '')) x.url = `https://www.toutiao.com/article/${x.id}/`
        out.push(x)
      }
      if (!rows.length) break
      await bx.sleep(800)
    }
  } finally {
    await tab.close().catch(() => {})
  }
  if (!out.length) throw new BxError('EMPTY', `头条没有搜到 ${q}`, '换个关键词')
  return out.slice(0, limit)
}

/** 文章全文（+ 热门评论）。url 是文章链接或 group_id
 *  @example article('https://www.toutiao.com/article/7694641514911253042/', { comments: 10 }) */
export async function article(url, { comments = 20 } = {}) {
  const id = gid(url)
  if (!id) throw new BxError('BAD_ARGS', '要文章链接或 group_id')
  const tab = await bx.open(`https://www.toutiao.com/article/${id}/`)
  try {
    return await articleOn(tab, id, comments)
  } finally {
    await tab.close().catch(() => {})
  }
}

async function articleOn(tab, id, n) {
  await tab.waitFor({ selector: '.article-content, #captcha_container', timeout: 15000 }).catch(() => {})
  const a = await tab.eval(() => {
    if (document.querySelector('#captcha_container')) return { captcha: true }
    const body = document.querySelector('.article-content article, .article-content')
    if (!body) return null
    const meta = document.querySelector('.article-meta')?.innerText.replace(/\s+/g, ' ').trim() || ''
    return {
      title: document.querySelector('h1')?.innerText.trim(),
      meta,
      time: meta.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)?.[0],
      source: meta.split('·').pop()?.trim(),
      content: [...body.querySelectorAll('p, h1, h2, h3, li, blockquote')].map(p => p.innerText.trim()).filter(Boolean).join('\n\n') || body.innerText.trim(),
    }
  })
  if (a?.captcha) throw new BxError('BLOCKED', '头条文章页出了验证码', `bx tab activate ${tab.id} 处理一下再试`)
  if (!a) throw new BxError('CHANGED', '文章页没找到正文（可能是视频 / 微头条，或页面结构变了）', '用 bx read 看看')
  let list = []
  if (n > 0) {
    const r = await tab.c('page.fetch', { url: `https://www.toutiao.com/article/v4/tab_comments/?aid=24&app_name=toutiao_web&offset=0&count=${Math.min(n, 50)}&group_id=${id}&item_id=${id}`, init: {}, as: 'text' }).catch(() => null)
    try {
      list = (JSON.parse(r.text).data || []).map(x => x.comment).filter(Boolean).slice(0, n).map(c => ({ author: c.user_name, likes: c.digg_count, replies: c.reply_count, location: c.publish_loc_info || undefined, time: c.create_time ? new Date(c.create_time * 1000).toLocaleString('sv-SE').slice(0, 16) : undefined, text: c.text }))
    } catch {}
  }
  return { id, title: a.title, source: a.source, time: a.time, content: a.content, comments: list, url: `https://www.toutiao.com/article/${id}/` }
}

/** 文章页的读法：正文 + 热门评论 */
export async function read(tab, { limit = 20 } = {}) {
  const url = await tab.url()
  const id = /toutiao\.com\/(article|group)\//.test(url) && gid(url)
  if (!id) return null
  const a = await articleOn(tab, id, limit)
  return {
    title: a.title,
    meta: { published: a.time, site: '今日头条', source: a.source },
    content: [a.content, '', `## 评论`, ...a.comments.map(c => `- **${c.author}**（👍${c.likes}${c.location ? '，' + c.location : ''}）：${c.text}`)].join('\n'),
  }
}
