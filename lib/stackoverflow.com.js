/* 站点笔记（Stack Overflow）：
 * - 用 Stack Exchange 公开 API（api.stackexchange.com/2.3），Node 直接请求，不用开标签
 * - 不带 key 每个 IP 每天 300 次；返回里 quota_remaining 是剩余次数，backoff 字段出现时要等那么多秒
 * - filter=withbody 才带正文（HTML）；site 参数换成 superuser / serverfault / askubuntu / unix 等就能查别的站
 * - 搜索：/search/advanced?q=&accepted=True&sort=relevance|votes|creation|activity
 * - 时间是秒级时间戳
 */

const API = 'https://api.stackexchange.com/2.3'
const time = s => (s ? new Date(s * 1000).toISOString().slice(0, 10) : undefined)
const strip = h => String(h || '')
  .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, c) => '\n```\n' + c + '\n```\n')
  .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<li>/gi, '- ')
  .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim()
const unesc = s => strip(s).replace(/\n/g, ' ')

async function api(path, site) {
  const r = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}site=${site}`)
  const j = await r.json().catch(() => null)
  if (!j) throw new BxError('HTTP_ERROR', `Stack Exchange API ${r.status}`)
  if (j.error_id === 502 || r.status === 429) throw new BxError('BLOCKED', `Stack Exchange API 限流：${j.error_message}`, '今天的匿名额度用完了，明天再试或换 google.com search "site:stackoverflow.com …"')
  if (j.error_id) throw new BxError('HTTP_ERROR', `${j.error_name}: ${j.error_message}`)
  return j
}

const qOf = q => ({
  id: q.question_id,
  title: unesc(q.title),
  score: q.score,
  answers: q.answer_count,
  accepted: q.is_answered && !!q.accepted_answer_id,
  views: q.view_count,
  tags: (q.tags || []).join(','),
  time: time(q.creation_date),
  url: q.link,
})

/** 搜问题。sort：relevance 相关 / votes 票数 / creation 最新 / activity 最近活跃；accepted 只要有采纳答案的
 *  @example search('sqlite wal mode concurrency', { limit: 10, sort: 'votes' }) */
export async function search(q, { limit = 20, sort = 'relevance', tagged = '', accepted = false, site = 'stackoverflow' } = {}) {
  const p = new URLSearchParams({ q, sort, order: 'desc', pagesize: String(Math.min(limit, 100)) })
  if (tagged) p.set('tagged', tagged)
  if (accepted) p.set('accepted', 'True')
  const j = await api(`/search/advanced?${p}`, site)
  if (!j.items.length) throw new BxError('EMPTY', `没有搜到 ${q}`, '换个关键词，或者去掉 tagged')
  return j.items.slice(0, limit).map(qOf)
}

/** 热门 / 某个标签下的问题。sort：hot week month votes creation activity
 *  @example questions({ tagged: 'rust', sort: 'week', limit: 10 }) */
export async function questions({ tagged = '', sort = 'hot', limit = 20, site = 'stackoverflow' } = {}) {
  const p = new URLSearchParams({ sort, order: 'desc', pagesize: String(Math.min(limit, 100)) })
  if (tagged) p.set('tagged', tagged)
  return (await api(`/questions?${p}`, site)).items.slice(0, limit).map(qOf)
}

/** 问题正文 + 答案（按票数，采纳的排最前）+ 评论。id 是数字或问题链接
 *  @example question('https://stackoverflow.com/questions/1711631', { answers: 3 }) */
export async function question(id, { answers = 5, comments = true, site = 'stackoverflow' } = {}) {
  id = String(id).match(/questions\/(\d+)/)?.[1] || String(id).match(/^\d+$/)?.[0]
  if (!id) throw new BxError('BAD_ARGS', '要问题 id 或 /questions/<id> 链接')
  const [qj, aj, cj] = await Promise.all([
    api(`/questions/${id}?filter=withbody`, site),
    api(`/questions/${id}/answers?filter=withbody&sort=votes&order=desc&pagesize=${Math.min(answers + 1, 100)}`, site),
    comments ? api(`/questions/${id}/comments?filter=withbody&sort=votes&order=desc&pagesize=10`, site) : { items: [] },
  ])
  const q = qj.items[0]
  if (!q) throw new BxError('NOT_FOUND', `问题 ${id} 不存在`)
  const list = aj.items.sort((a, b) => (b.is_accepted ? 1 : 0) - (a.is_accepted ? 1 : 0)).slice(0, answers)
  return {
    ...qOf(q),
    author: q.owner?.display_name,
    content: strip(q.body),
    comments: cj.items.map(c => ({ author: c.owner?.display_name, score: c.score, text: unesc(c.body) })),
    answerList: list.map(a => ({ id: a.answer_id, author: a.owner?.display_name, score: a.score, accepted: a.is_accepted, time: time(a.creation_date), text: strip(a.body), url: `https://stackoverflow.com/a/${a.answer_id}` })),
  }
}

/** 问题页的读法：问题 + 答案 */
export async function read(tab, { limit = 5 } = {}) {
  const url = await tab.url()
  const m = url.match(/^https:\/\/(?:www\.)?stackoverflow\.com\/questions\/(\d+)/)
  if (!m) return null
  const q = await question(m[1], { answers: limit })
  return {
    title: q.title,
    meta: { author: q.author, published: q.time, site: 'Stack Overflow', tags: q.tags, score: q.score },
    content: [q.content, ...q.answerList.map(a => `\n## 答案 ${a.accepted ? '✅ 已采纳 ' : ''}（${a.score} 票，${a.author}，${a.time}）\n\n${a.text}`)].join('\n'),
  }
}
