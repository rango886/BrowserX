// 在页面里执行的通用内容提取器。
// 由 daemon 注入：bxExtract(opts, { Readability, TurndownService })
// 提取链：结构化数据(meta / JSON-LD / SSR 数据提示) → 正文(Readability) → 列表识别 → 页面大纲
async function bxExtract(opts, L) {
  const budget = opts.budget || 6000
  const clip = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t)
  const squash = t => (t || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

  // ---------- 元信息 ----------
  const m = n => document.querySelector(`meta[name="${n}"],meta[property="${n}"]`)?.content?.trim()
  const meta = {
    description: m('description') || m('og:description'),
    site: m('og:site_name'),
    author: m('author') || m('article:author'),
    published: m('article:published_time') || document.querySelector('time[datetime]')?.getAttribute('datetime'),
    lang: document.documentElement.lang || undefined,
  }
  for (const k in meta) if (!meta[k]) delete meta[k]

  // JSON-LD
  const structured = []
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent)
      const arr = Array.isArray(j) ? j : j['@graph'] || [j]
      for (const x of arr) if (x && x['@type']) structured.push(x)
    } catch {}
  }

  // SSR 数据：只给提示，不直接倒出来（太大）
  const hints = []
  for (const k of ['__NEXT_DATA__', '__NUXT__', '__NUXT_DATA__', '__INITIAL_STATE__', '__APOLLO_STATE__', '__PRELOADED_STATE__', '__INITIAL_DATA__', '__remixContext', '__pinia']) {
    let v
    try { v = window[k] } catch {}
    if (v === undefined && k === '__NEXT_DATA__') {
      const el = document.getElementById('__NEXT_DATA__')
      if (el) v = el.textContent
    }
    if (v !== undefined) {
      let size = 0
      try { size = (typeof v === 'string' ? v : JSON.stringify(v)).length } catch {}
      hints.push(`页面自带数据 window.${k}（约 ${size < 1024 ? size + ' 字节' : Math.round(size / 1024) + 'KB'}），可用 bx eval "window.${k}" 读取结构化数据`)
    }
  }

  // ---------- 工具 ----------
  const visible = el => {
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
  }
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT'])
  // 只克隆看得见的部分（去掉隐藏菜单、弹层里的文字）
  const cloneVisible = (node, skipSel) => {
    if (node.nodeType === 3) return node.cloneNode()
    if (node.nodeType !== 1) return null
    if (SKIP.has(node.tagName.toUpperCase())) return null
    if (skipSel && node.matches(skipSel)) return null
    if (!visible(node)) return null
    const c = node.cloneNode(false)
    for (const ch of node.childNodes) {
      const x = cloneVisible(ch, skipSel)
      if (x) c.appendChild(x)
    }
    if (node.shadowRoot) for (const ch of node.shadowRoot.childNodes) {
      const x = cloneVisible(ch, skipSel)
      if (x) c.appendChild(x)
    }
    return c
  }
  const td = new L.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' })
  td.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'button', 'select', 'input', 'textarea'])
  td.addRule('img', {
    filter: 'img',
    replacement: (_, n) => {
      const alt = (n.getAttribute('alt') || '').trim()
      return alt ? `![${clip(alt, 60)}]` : ''
    },
  })
  if (!opts.links) {
    td.addRule('link', { filter: 'a', replacement: c => c })
  } else {
    td.addRule('link', {
      filter: n => n.nodeName === 'A' && n.getAttribute('href'),
      replacement: (c, n) => {
        const t = c.trim()
        if (!t) return ''
        let href = n.getAttribute('href')
        try { href = new URL(href, location.href).href } catch {}
        return href.startsWith('javascript:') ? t : `[${t}](${href})`
      },
    })
  }
  const toMd = el => squash(td.turndown(el))

  // ---------- 评论区 ----------
  const bodyLen = (document.body?.innerText || '').length || 1
  const findComments = () => {
    let best = null, bestLen = 0
    for (const el of document.querySelectorAll('[id*="comment" i],[class*="comment" i],[id*="reply" i],[class*="reply-list" i],#disqus_thread,bili-comments')) {
      if (!visible(el)) continue
      const len = (el.innerText || el.shadowRoot?.textContent || '').length
      if (len > bestLen && len < bodyLen * 0.8 && len > 40) { best = el; bestLen = len }
    }
    // 取最外层的那个（避免只拿到单条评论）
    while (best && best.parentElement && best.parentElement !== document.body) {
      const p = best.parentElement
      const pl = (p.innerText || '').length
      const sig = (p.id + ' ' + p.className).toLowerCase()
      if (/comment|reply/.test(sig) && pl < bodyLen * 0.8) best = p
      else break
    }
    return best
  }

  // ---------- 列表识别 ----------
  const detectList = root => {
    let best = null
    const bad = el => el.closest('nav,header,footer,[role=navigation],[role=banner],[role=contentinfo],aside')
    for (const el of root.querySelectorAll('*')) {
      if (el.children.length < 4) continue
      const groups = {}
      for (const ch of el.children) {
        const sig = ch.tagName + '.' + ([...ch.classList].filter(c => !/active|selected|first|last|odd|even|\d/.test(c)).sort()[0] || '')
        ;(groups[sig] = groups[sig] || []).push(ch)
      }
      for (const sig in groups) {
        const items = groups[sig].filter(visible)
        if (items.length < 4) continue
        const withLink = items.filter(i => i.querySelector('a[href]') || i.matches('a[href]'))
        if (withLink.length / items.length < 0.6) continue
        const lens = items.map(i => (i.innerText || '').trim().length)
        const avg = lens.reduce((a, b) => a + b, 0) / items.length
        if (avg < 8 || avg > 2000) continue
        let score = items.length * Math.log(avg + 1)
        if (bad(el)) score *= 0.1
        if (!best || score > best.score) best = { el, items, score, textLen: lens.reduce((a, b) => a + b, 0) }
      }
    }
    return best
  }
  const listItem = it => {
    const links = [...(it.matches('a[href]') ? [it] : []), ...it.querySelectorAll('a[href]')].filter(a => (a.innerText || '').trim())
    const h = it.querySelector('h1,h2,h3,h4,h5,h6,[class*="title" i]')
    let title = squash(h?.innerText || '')
    let link = links.find(a => h && (a.contains(h) || h.contains(a))) || links.sort((a, b) => b.innerText.length - a.innerText.length)[0]
    if (!title) title = squash(link?.innerText || (it.innerText || '').split('\n')[0])
    const all = squash((it.innerText || '').replace(/\n+/g, ' · '))
    let text = all.replace(title, '').replace(/^[\s·]+|[\s·]+$/g, '')
    const o = { title: clip(title, 120) }
    if (link) o.url = link.href
    if (text) o.text = clip(text, 160)
    return o
  }

  // ---------- 各种候选 ----------
  let article = null
  if (!opts.via || opts.via === 'readability') {
    try {
      const doc = document.cloneNode(true)
      const r = new L.Readability(doc, { charThreshold: 300, keepClasses: false }).parse()
      if (r && r.textContent) article = r
    } catch {}
  }
  const mainEl = document.querySelector('main,[role=main],article') || document.body
  const list = (!opts.via || opts.via === 'list') && document.body ? detectList(document.body) : null
  const comments = findComments()

  const artLen = article ? article.textContent.trim().length : 0
  let type = opts.via === 'readability' ? 'article' : opts.via === 'list' ? 'list' : opts.via === 'outline' ? 'page' : null
  if (!type) {
    const forms = document.querySelectorAll('input:not([type=hidden]),textarea,select').length
    if (artLen > 600 && (!list || artLen > list.textLen * 0.6)) type = 'article'
    else if (list && list.items.length >= 4) type = 'list'
    else if (forms >= 3 && bodyLen < 3000) type = 'form'
    else type = 'page'
  }

  const out = { url: location.href, title: document.title, type, via: '', meta }
  if (structured.length) out.structured = structured.map(x => ({ type: x['@type'], name: x.headline || x.name })).slice(0, 10)
  if (hints.length) out.hints = hints

  // ---------- 主内容 ----------
  let content = ''
  let items = null
  if (type === 'article' && article) {
    out.via = 'readability'
    if (article.byline && !meta.author) meta.author = squash(article.byline)
    if (article.publishedTime && !meta.published) meta.published = article.publishedTime
    const div = document.createElement('div')
    div.innerHTML = article.content
    content = toMd(div)
    if (article.title) out.title = article.title
  } else if (type === 'list' && list) {
    out.via = 'list'
    items = list.items.map(listItem)
  } else {
    out.via = 'outline'
    const skip = 'nav,header,footer,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],dialog:not([open])'
    const c = cloneVisible(mainEl, mainEl === document.body ? skip : null)
    content = c ? toMd(c) : ''
  }

  // ---------- 分段 ----------
  const sections = []
  if (comments) sections.push({ id: 'comments', title: '评论区', chars: (comments.innerText || '').length })
  const navEl = document.querySelector('nav,[role=navigation]')
  if (navEl && visible(navEl)) sections.push({ id: 'nav', title: '导航', chars: navEl.innerText.length })
  if (type !== 'page') sections.push({ id: 'page', title: '整页可见文字', chars: bodyLen })
  if (structured.length) sections.push({ id: 'structured', title: 'JSON-LD 结构化数据', chars: JSON.stringify(structured).length })

  // 取某一段
  if (opts.section) {
    let text = ''
    if (opts.section === 'comments') {
      if (!comments) return { error: '没找到评论区（可能需要先滚动加载，试试 bx read --scroll 3）' }
      const c = cloneVisible(comments)
      text = c ? toMd(c) : ''
      if (!text && comments.shadowRoot) text = squash(comments.shadowRoot.textContent)
    } else if (opts.section === 'nav') text = navEl ? toMd(cloneVisible(navEl) || navEl) : ''
    else if (opts.section === 'page') text = toMd(cloneVisible(document.body) || document.body)
    else if (opts.section === 'structured') text = JSON.stringify(structured, null, 1)
    else if (opts.section === 'content') text = content || (items ? items.map((x, i) => `${i + 1}. ${x.title}`).join('\n') : '')
    else return { error: `没有分段 ${opts.section}`, sections }
    const off = opts.offset || 0
    const part = text.slice(off, off + budget)
    return {
      url: location.href, title: out.title, section: opts.section, content: part,
      range: [off, off + part.length], total: text.length,
      more: off + part.length < text.length ? off + part.length : undefined,
    }
  }

  if (opts.mode === 'brief') {
    out.summary = clip(squash(content || (items || []).slice(0, 5).map(x => x.title).join(' / ')), 300)
    out.size = { chars: content.length, items: items ? items.length : undefined }
    out.sections = [{ id: 'content', title: '主内容', chars: content.length || (items ? items.length + ' 项' : 0) }, ...sections]
    return out
  }

  const off = opts.offset || 0
  if (items) {
    const lim = opts.limit || (opts.mode === 'full' ? items.length : 40)
    out.items = items.slice(off, off + lim)
    if (off + lim < items.length) out.more = { next: off + lim, total: items.length }
  } else {
    const lim = opts.mode === 'full' ? Infinity : budget
    out.content = content.slice(off, off + lim)
    if (off + lim < content.length) out.more = { next: off + lim, total: content.length }
  }
  out.sections = sections
  return out
}
