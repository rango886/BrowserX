/* 站点笔记（GitHub）：
 * @login optional 用 GitHub REST API。令牌按顺序找：环境变量 GITHUB_TOKEN / GH_TOKEN → `gh auth token`（装了 gh 并 gh auth login 过）。没有令牌也能用，但每小时只有 60 次、不能搜代码
 * - API：api.github.com。搜索 /search/repositories|issues|code?q=（q 支持 GitHub 搜索语法：language:rust stars:>1000 repo:o/r is:issue is:open label:bug created:>2025-01-01）
 * - 搜索接口单独限流：有令牌每分钟 30 次（搜代码 10 次），没有 10 次
 * - README：/repos/o/r/readme，Accept: application/vnd.github.raw 直接拿 Markdown 原文
 * - Trending 没有 API，抓 github.com/trending 的 HTML（article.Box-row）
 * - Discussions 只有 GraphQL 能取，还没做；要看讨论区可以 bx read 讨论页
 */
import { execFileSync } from 'node:child_process'

let token
function getToken() {
  if (token !== undefined) return token
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (!token) {
    try {
      token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
    } catch {
      token = ''
    }
  }
  return token
}

async function gh(path, { raw = false } = {}) {
  const headers = { 'User-Agent': 'bx', Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (getToken()) headers.Authorization = `Bearer ${getToken()}`
  const r = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, { headers })
  if (r.status === 404) throw new BxError('NOT_FOUND', `GitHub 404：${path}`, '检查仓库名 / 编号')
  if (r.status === 401) throw new BxError('NEED_LOGIN', 'GitHub 令牌无效或过期', '重新 gh auth login，或者更新 GITHUB_TOKEN')
  if (r.status === 403 || r.status === 429) {
    const reset = r.headers.get('x-ratelimit-reset')
    const left = r.headers.get('x-ratelimit-remaining')
    if (left === '0' || r.status === 429)
      throw new BxError('BLOCKED', `GitHub API 限流${reset ? `，${new Date(reset * 1000).toLocaleTimeString()} 恢复` : ''}`, getToken() ? '等一会儿再试' : '没有令牌每小时只有 60 次：装 gh 并 gh auth login，或设置 GITHUB_TOKEN')
    if (path.startsWith('/search/code') && !getToken()) throw new BxError('NEED_LOGIN', '搜代码必须带令牌', '装 gh 并 gh auth login，或设置 GITHUB_TOKEN')
    throw new BxError('HTTP_ERROR', `GitHub 403：${(await r.text()).slice(0, 200)}`)
  }
  if (!r.ok) throw new BxError('HTTP_ERROR', `GitHub ${r.status}：${(await r.text()).slice(0, 200)}`)
  return raw ? r.text() : r.json()
}

const day = s => s?.slice(0, 10)
const repoName = x => {
  const m = String(x).match(/(?:github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#?].*)?$/)
  if (!m) throw new BxError('BAD_ARGS', `要 owner/repo 或仓库链接：${x}`)
  return m[1]
}
const repoOf = r => ({
  repo: r.full_name,
  description: r.description,
  stars: r.stargazers_count,
  forks: r.forks_count,
  language: r.language,
  topics: (r.topics || []).join(',') || undefined,
  updated: day(r.pushed_at),
  created: day(r.created_at),
  archived: r.archived || undefined,
  url: r.html_url,
})
const issueOf = i => ({
  repo: i.repository_url?.replace('https://api.github.com/repos/', ''),
  number: i.number,
  title: i.title,
  kind: i.pull_request ? 'pr' : 'issue',
  state: i.state,
  author: i.user?.login,
  comments: i.comments,
  reactions: i.reactions?.total_count,
  labels: (i.labels || []).map(l => l.name).join(',') || undefined,
  created: day(i.created_at),
  updated: day(i.updated_at),
  url: i.html_url,
})

/** 搜仓库。q 支持 GitHub 语法（language:rust stars:>1000 topic:llm pushed:>2025-01-01）；sort：best-match stars forks updated
 *  @example search('sqlite language:rust', { limit: 10, sort: 'stars' }) */
export async function search(q, { limit = 20, sort = 'best-match' } = {}) {
  const p = new URLSearchParams({ q, per_page: String(Math.min(limit, 100)) })
  if (sort !== 'best-match') p.set('sort', sort)
  const j = await gh(`/search/repositories?${p}`)
  if (!j.items.length) throw new BxError('EMPTY', `没有搜到仓库 ${q}`, '换个关键词，或者放宽条件')
  return j.items.slice(0, limit).map(repoOf)
}

/** 搜 issue / PR（跨仓库）。q 例：'repo:oven-sh/bun is:issue memory leak'、'sqlite busy is:pr is:merged'；sort：best-match comments reactions created updated
 *  @example issues('repo:oven-sh/bun is:issue is:open segfault', { limit: 10 }) */
export async function issues(q, { limit = 20, sort = 'best-match' } = {}) {
  const p = new URLSearchParams({ q: /\bis:(issue|pr)\b|\btype:/.test(q) ? q : q + ' is:issue', per_page: String(Math.min(limit, 100)) })
  if (sort !== 'best-match') p.set('sort', sort)
  const j = await gh(`/search/issues?${p}`)
  if (!j.items.length) throw new BxError('EMPTY', `没有搜到 ${q}`, '换个关键词')
  return j.items.slice(0, limit).map(issueOf)
}

/** 搜代码（必须有令牌）。q 例：'WAL journal_mode language:go'、'repo:o/r useEffect'
 *  @login required 要 gh auth login 或 GITHUB_TOKEN
 *  @example code('PRAGMA journal_mode=WAL language:go', { limit: 10 }) */
export async function code(q, { limit = 20 } = {}) {
  const j = await gh(`/search/code?${new URLSearchParams({ q, per_page: String(Math.min(limit, 100)) })}`)
  return j.items.slice(0, limit).map(c => ({ repo: c.repository.full_name, path: c.path, url: c.html_url }))
}

/** 仓库信息 + README（readme: false 不要 README）
 *  @example repo('oven-sh/bun') */
export async function repo(name, { readme = true, budget = 8000 } = {}) {
  name = repoName(name)
  const [r, md, rel] = await Promise.all([
    gh(`/repos/${name}`),
    readme ? gh(`/repos/${name}/readme`, { raw: true }).catch(() => '') : '',
    gh(`/repos/${name}/releases/latest`).catch(() => null),
  ])
  return {
    ...repoOf(r),
    homepage: r.homepage || undefined,
    license: r.license?.spdx_id,
    openIssues: r.open_issues_count,
    watchers: r.subscribers_count,
    defaultBranch: r.default_branch,
    latestRelease: rel ? `${rel.tag_name} (${day(rel.published_at)})` : undefined,
    readme: md ? (md.length > budget ? md.slice(0, budget) + `\n…（README 共 ${md.length} 字，截断了）` : md) : undefined,
  }
}

/** 一个 issue / PR 的正文和评论。可以传链接，或 ('o/r', 123)
 *  @example issue('https://github.com/oven-sh/bun/issues/1', { limit: 20 }) */
export async function issue(urlOrRepo, number = '', { limit = 50 } = {}) {
  let name, num
  const m = String(urlOrRepo).match(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull|discussions)\/(\d+)/)
  if (m) [name, num] = [m[1], m[2]]
  else [name, num] = [repoName(urlOrRepo), number]
  if (typeof number === 'object' && number) limit = number.limit ?? limit
  if (!num || typeof num === 'object') throw new BxError('BAD_ARGS', '要 issue 链接，或者 (owner/repo, 编号)')
  const i = await gh(`/repos/${name}/issues/${num}`)
  const comments = []
  for (let page = 1; comments.length < limit && page <= 10; page++) {
    const c = await gh(`/repos/${name}/issues/${num}/comments?per_page=100&page=${page}`)
    comments.push(...c)
    if (c.length < 100) break
  }
  return {
    ...issueOf(i),
    repo: name,
    body: i.body || '',
    commentList: comments.slice(0, limit).map(c => ({ author: c.user?.login, time: day(c.created_at), reactions: c.reactions?.total_count || undefined, text: c.body })),
  }
}

/** 仓库的 issue / PR 列表。state：open closed all；sort：created updated comments
 *  /issues 接口会把 PR 也混进来（按评论数排时前几页可能全是 PR），过滤掉 PR 后不够数就接着翻页，最多翻 5 页
 *  @example repoIssues('oven-sh/bun', { state: 'open', sort: 'comments', limit: 10 }) */
export async function repoIssues(name, { state = 'open', sort = 'created', pulls = false, limit = 30 } = {}) {
  name = repoName(name)
  const perPage = pulls ? Math.min(limit, 100) : 100
  const out = []
  for (let page = 1; page <= 5 && out.length < limit; page++) {
    const j = await gh(`/repos/${name}/${pulls ? 'pulls' : 'issues'}?state=${state}&sort=${sort}&direction=desc&per_page=${perPage}&page=${page}`)
    if (!Array.isArray(j)) throw new BxError('CHANGED', 'GitHub issue 列表返回的不是数组', '去修 repoIssues')
    out.push(...j.filter(i => pulls || !i.pull_request))
    if (j.length < perPage) break
  }
  return out.slice(0, limit).map(i => ({ ...issueOf(i), repo: name }))
}

/** 版本发布记录
 *  @example releases('oven-sh/bun', { limit: 5 }) */
export async function releases(name, { limit = 10, budget = 2000 } = {}) {
  name = repoName(name)
  const j = await gh(`/repos/${name}/releases?per_page=${Math.min(limit, 100)}`)
  return j.slice(0, limit).map(r => ({ tag: r.tag_name, name: r.name, time: day(r.published_at), prerelease: r.prerelease || undefined, notes: (r.body || '').slice(0, budget), url: r.html_url }))
}

/** GitHub Trending。since：daily weekly monthly；language 如 python、rust、"c++"
 *  @login none
 *  @example trending({ since: 'weekly', language: 'rust', limit: 10 }) */
export async function trending({ since = 'daily', language = '', limit = 25 } = {}) {
  const r = await fetch(`https://github.com/trending${language ? '/' + encodeURIComponent(language) : ''}?since=${since}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const html = await r.text()
  const dec = s => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/\s+/g, ' ').trim()
  const num = s => Number(String(s || '').replace(/[^\d]/g, '')) || 0
  const out = []
  for (const [, b] of html.matchAll(/<article\b[^>]*Box-row[^>]*>([\s\S]*?)<\/article>/g)) {
    const repo = b.match(/<h2\b[\s\S]*?href="\/([^"/?#]+\/[^"/?#]+)"/)?.[1]
    if (!repo) continue
    const esc = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out.push({
      repo,
      description: dec(b.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/)?.[1] || ''),
      language: dec(b.match(/itemprop="programmingLanguage">([\s\S]*?)<\/span>/)?.[1] || '') || undefined,
      stars: num(b.match(new RegExp(`href="/${esc}/stargazers"[^>]*>([\\s\\S]*?)</a>`))?.[1].replace(/<[^>]*>/g, '')),
      forks: num(b.match(new RegExp(`href="/${esc}/forks"[^>]*>([\\s\\S]*?)</a>`))?.[1].replace(/<[^>]*>/g, '')),
      starsSince: num(b.match(/([\d,]+)\s+stars\s+(?:today|this week|this month)/i)?.[1]),
      url: `https://github.com/${repo}`,
    })
    if (out.length >= limit) break
  }
  if (!out.length) throw new BxError(/<article/.test(html) ? 'CHANGED' : 'EMPTY', 'Trending 页面没有解析出仓库', '页面结构可能变了，去修 trending')
  return out
}
