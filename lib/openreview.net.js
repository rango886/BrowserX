/* 站点笔记（OpenReview，ICLR / NeurIPS / ICML 等会议的投稿和公开审稿）：
 * - 公开接口 api2.openreview.net（v2），字段都包在 { value } 里
 *   搜索 /notes/search?term=&type=terms   单篇 /notes?id=   整个讨论串 /notes?forum=<id>&limit=1000
 *   作者 /notes?content.authorids=~Name1   会议 /notes?content.venue=ICLR 2024 oral 或 /notes?invitation=ICLR.cc/2025/Conference/-/Submission
 * - 坑：除了搜索，其它接口从 Node 直接请求会返回 403 ChallengeRequiredError（人机验证）。
 *   这时改在 openreview.net 的标签里 fetch（credentials: 'include'，带上验证通过后的 cookie）。
 *   标签里也过不了时，把标签切到前台请用户点一下验证
 * - 讨论串里每条 note 的类型看 invitations 结尾：Official_Review 审稿、Meta_Review、Decision、Official_Comment、Rebuttal、Withdrawal
 * - 打分字段各会议不一样：rating / recommendation / soundness / presentation / contribution / confidence，值多为 "6: marginally above…" 这种
 */

const API = 'https://api2.openreview.net'
const SITE = 'https://openreview.net'

async function viaTab(url) {
  const tab = await bx.tab('openreview.net')
  if (!/openreview\.net/.test(await tab.url())) await tab.goto(SITE)
  const run = () => tab.eval(async u => {
    const r = await fetch(u, { credentials: 'include' })
    return { status: r.status, text: await r.text() }
  }, url)
  let r = await run()
  if (r.status === 403 && /Challenge/.test(r.text)) {
    // 先打开一个正常页面让它完成验证，再试一次
    await tab.goto(`${SITE}/group?id=ICLR.cc`)
    await bx.sleep(4000)
    r = await run()
  }
  if (r.status === 403 && /Challenge/.test(r.text)) {
    throw new BxError('BLOCKED', 'OpenReview 要求人机验证', `在浏览器里打开 ${SITE} 完成验证后再试（bx tab activate 把标签切到前台）`)
  }
  return r
}

async function api(path) {
  const url = `${API}${path}`
  let r = await fetch(url).then(async x => ({ status: x.status, text: await x.text() })).catch(() => null)
  if (!r || (r.status === 403 && /Challenge/.test(r.text))) r = await viaTab(url)
  if (r.status === 404) return { notes: [] }
  if (r.status === 429) throw new BxError('BLOCKED', 'OpenReview 限流了', '停一会儿再试')
  if (r.status >= 400) throw new BxError('HTTP_ERROR', `OpenReview 返回 ${r.status}：${r.text.slice(0, 200)}`)
  return JSON.parse(r.text)
}

const val = (c, k) => c?.[k]?.value
const nameOf = id => String(id || '').replace(/^~/, '').replace(/\d+$/, '').replace(/_/g, ' ').trim()
const day = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : undefined)

function row(n, { full = false } = {}) {
  const c = n.content || {}
  const authors = val(c, 'authors') || (val(c, 'authorids') || []).map(nameOf)
  const abs = String(val(c, 'abstract') || '').replace(/\s+/g, ' ').trim()
  const pdf = val(c, 'pdf')
  return {
    id: n.id,
    title: String(val(c, 'title') || '').replace(/\s+/g, ' ').trim(),
    authors: !full && authors.length > 5 ? authors.slice(0, 5).join(', ') + ` 等 ${authors.length} 人` : authors.join(', '),
    venue: val(c, 'venue') || undefined,
    keywords: (val(c, 'keywords') || []).join?.(', ') || undefined,
    area: val(c, 'primary_area') || undefined,
    date: day(n.pdate || n.cdate),
    abstract: full ? abs : abs.length > 300 ? abs.slice(0, 300) + '…' : abs || undefined,
    pdf: pdf ? (/^https?:/.test(pdf) ? pdf : SITE + pdf) : undefined,
    url: `${SITE}/forum?id=${n.forum || n.id}`,
  }
}

const idOf = s => String(s).match(/[?&]id=([\w-]+)/)?.[1] || String(s).trim()
const isPaper = n => n.id === n.forum && val(n.content, 'title')

/** 搜论文（全文检索标题、摘要、关键词）
 *  @example search('diffusion language model', { limit: 10 }) */
export async function search(q, { limit = 25 } = {}) {
  const j = await api(`/notes/search?term=${encodeURIComponent(q)}&type=terms&limit=${Math.min(limit * 6, 200)}`)
  const list = (j.notes || []).filter(isPaper).slice(0, limit)
  if (!list.length) throw new BxError('EMPTY', `OpenReview 没搜到 ${q}`, '换个关键词')
  return list.map((n, i) => ({ rank: i + 1, ...row(n) }))
}

/** 论文详情：完整摘要、作者、关键词、会议、PDF
 *  @example paper('5sRnsubyAK') */
export async function paper(id) {
  const j = await api(`/notes?id=${encodeURIComponent(idOf(id))}`)
  if (!j.notes?.length) throw new BxError('NOT_FOUND', `OpenReview 上没有 ${id}`, '用 openreview.net/forum?id= 后面那串')
  return row(j.notes[0], { full: true })
}

const SECTIONS = [
  ['summary', '总结'], ['strengths', '优点'], ['weaknesses', '缺点'], ['questions', '问题'], ['limitations', '局限'],
  ['metareview', 'Meta review'], ['justification_for_why_not_higher_score', '为什么不更高'], ['justification_for_why_not_lower_score', '为什么不更低'],
  ['comment', '评论'], ['rebuttal', 'Rebuttal'], ['decision', '决定'], ['recommendation', '建议'], ['title', '标题'],
]
const SCORES = ['rating', 'recommendation', 'soundness', 'presentation', 'contribution', 'confidence']

function kindOf(n) {
  const t = (n.invitations || []).map(x => x.split('/-/')[1] || '').find(Boolean)?.toLowerCase() || ''
  if (t.includes('decision')) return 'decision'
  if (t.includes('meta')) return 'meta_review'
  if (t.includes('withdraw')) return 'withdrawal'
  if (t.includes('rebuttal')) return 'rebuttal'
  if (t.includes('review')) return 'review'
  if (t.includes('comment')) return 'comment'
  return t || 'note'
}
const signer = n => {
  const s = String(n.signatures?.[0] || '')
  return s.startsWith('~') ? nameOf(s) : s.split('/').pop()
}
const short = v => (typeof v === 'string' ? v.split(':')[0].trim() : v)

/** 审稿讨论串：每个审稿人的打分和意见、作者回复、Meta review、最终决定，按时间排。
 *  kind 只看某一类：review / meta_review / decision / comment / rebuttal；maxLength 每条正文最多多少字
 *  @example reviews('5sRnsubyAK')
 *  @example reviews('https://openreview.net/forum?id=5sRnsubyAK', { kind: 'review', maxLength: 1500 }) */
export async function reviews(forum, { kind = '', maxLength = 4000 } = {}) {
  const id = idOf(forum)
  const j = await api(`/notes?forum=${encodeURIComponent(id)}&limit=1000`)
  const notes = j.notes || []
  if (!notes.length) throw new BxError('NOT_FOUND', `OpenReview 上没有讨论串 ${forum}`)
  let list = notes.filter(n => n.id !== id).sort((a, b) => (a.cdate || 0) - (b.cdate || 0)).map(n => {
    const c = n.content || {}
    const scores = Object.fromEntries(SCORES.filter(k => val(c, k) !== undefined).map(k => [k, short(val(c, k))]))
    let text = SECTIONS.map(([k, label]) => (val(c, k) ? `【${label}】${String(val(c, k)).trim()}` : '')).filter(Boolean).join('\n\n')
    if (text.length > maxLength) text = text.slice(0, maxLength) + '…'
    return { kind: kindOf(n), by: signer(n), date: day(n.cdate), ...scores, text, id: n.id, replyTo: n.replyto !== id ? n.replyto : undefined }
  })
  if (kind) list = list.filter(x => x.kind === kind)
  if (!list.length) throw new BxError('EMPTY', kind ? `没有 ${kind} 类型的内容` : '这篇还没有公开的审稿意见')
  return list
}

/** 某个作者在 OpenReview 上的投稿，最新的在前。profile 是作者主页网址里的 ~名字数字
 *  @example author('~Yoshua_Bengio1', { limit: 10 }) */
export async function author(profile, { limit = 50 } = {}) {
  const p = String(profile).match(/id=(~[^&]+)/)?.[1] || profile
  const j = await api(`/notes?content.authorids=${encodeURIComponent(p)}&limit=${Math.min(limit, 1000)}&sort=cdate:desc`)
  if (!j.notes?.length) throw new BxError('EMPTY', `${p} 没有公开的投稿`, '确认 id 格式是 ~First_Last1（看作者主页网址）')
  return j.notes.map((n, i) => ({ rank: i + 1, ...row(n) }))
}

/** 某个会议的论文。venue 写会议标签（如 'ICLR 2024 oral'、'ICLR 2024 poster'、'NeurIPS 2024 spotlight'），
 *  或者完整的 invitation（'ICLR.cc/2025/Conference/-/Submission'，包括被拒的投稿）
 *  @example venue('ICLR 2024 oral', { limit: 20 }) */
export async function venue(name, { limit = 50, offset = 0 } = {}) {
  const filter = name.includes('/-/') ? `invitation=${encodeURIComponent(name)}` : `content.venue=${encodeURIComponent(name)}`
  const j = await api(`/notes?${filter}&limit=${Math.min(limit, 1000)}&offset=${offset}`)
  if (!j.notes?.length) throw new BxError('EMPTY', `${name} 下没有论文`, "会议标签要和网页上一字不差，比如 'ICLR 2024 oral'；或者写 invitation")
  return j.notes.map((n, i) => ({ rank: offset + i + 1, ...row(n) }))
}

/** 论文页 /forum?id= 的读法：摘要 + 审稿意见 */
export async function read(t, { limit = 50 } = {}) {
  const id = (await t.url()).match(/openreview\.net\/forum\?id=([\w-]+)/)?.[1]
  if (!id) return null
  const p = await paper(id)
  const rs = await reviews(id).catch(() => [])
  const score = r => SCORES.filter(k => r[k] !== undefined).map(k => `${k} ${r[k]}`).join('，')
  return {
    title: p.title,
    type: 'discussion',
    meta: { author: p.authors, published: p.date, site: `OpenReview · ${p.venue || ''}` },
    content: [p.abstract, '', ...rs.slice(0, limit).map(r => `### ${r.kind} · ${r.by}${score(r) ? `（${score(r)}）` : ''}\n${r.text}`)].join('\n'),
  }
}
