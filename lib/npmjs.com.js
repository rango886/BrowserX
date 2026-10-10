/* 站点笔记（npm，JavaScript / Node.js 的包仓库）：
 * - 公开接口，不用登录、不用浏览器
 *   搜索 registry.npmjs.org/-/v1/search?text=&size=（结果带周 / 月下载量、依赖它的包数、综合得分）
 *     text 里可以写 keywords:react author:sindresorhus maintainer: scope: not:deprecated 这类限定
 *   包信息 registry.npmjs.org/<包名>（完整文档，time 里有每个版本的发布时间；大包有几 MB）
 *   下载量 api.npmjs.org/downloads/point/<区间>/<包1,包2>（总数，可以一次比多个，scoped 包 @x/y 不能批量）
 *          api.npmjs.org/downloads/range/<区间>/<包>（按天）；区间：last-day last-week last-month last-year 或 2024-01-01:2024-06-30
 */

const REG = 'https://registry.npmjs.org'
const API = 'https://api.npmjs.org'

async function get(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60000) })
  if (r.status === 404) throw new BxError('NOT_FOUND', `npm 上没有：${decodeURIComponent(url.split('/').pop())}`, '检查包名（区分 @scope/name）')
  if (r.status === 429) throw new BxError('BLOCKED', 'npm 接口限流了', '停一会儿再试')
  if (!r.ok) throw new BxError('HTTP_ERROR', `npm 返回 ${r.status}`)
  return r.json()
}
const enc = name => String(name).trim().replace('/', '%2F')
const day = s => s?.slice(0, 10)
const repoUrl = r => {
  const u = typeof r === 'string' ? r : r?.url
  return u ? u.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/') : undefined
}

/** 搜包，按综合得分（质量、热度、维护情况）。q 里可以加 keywords:xxx、author:xxx、not:deprecated 这类限定
 *  @example search('http client', { limit: 10 })
 *  @example search('keywords:markdown parser', { limit: 10 }) */
export async function search(q, { limit = 20 } = {}) {
  const j = await get(`${REG}/-/v1/search?text=${encodeURIComponent(q)}&size=${Math.min(limit, 250)}`)
  if (!j.objects?.length) throw new BxError('EMPTY', `npm 没搜到 ${q}`)
  return j.objects.map((o, i) => ({
    rank: i + 1,
    name: o.package.name,
    version: o.package.version,
    description: o.package.description,
    weekly: o.downloads?.weekly,
    monthly: o.downloads?.monthly,
    dependents: Number(o.dependents) || undefined,
    updated: day(o.package.date || o.updated),
    license: o.package.license,
    repo: repoUrl(o.package.links?.repository),
    url: `https://www.npmjs.com/package/${o.package.name}`,
  }))
}

/** 包详情：最新版本、发布时间、许可证、仓库、依赖数、维护者、版本数量、最近几次发布、周下载量、是否已废弃
 *  @example info('axios')
 *  @example info('@modelcontextprotocol/sdk', { releases: 10 }) */
export async function info(name, { releases = 5 } = {}) {
  const [d, dl] = await Promise.all([get(`${REG}/${enc(name)}`), get(`${API}/downloads/point/last-week/${name}`).catch(() => null)])
  const latest = d['dist-tags']?.latest
  const v = d.versions?.[latest] || {}
  const times = Object.entries(d.time || {}).filter(([k]) => k !== 'created' && k !== 'modified' && d.versions?.[k])
  const recent = times.sort((a, b) => b[1].localeCompare(a[1])).slice(0, releases).map(([ver, t]) => ({ version: ver, date: day(t) }))
  return {
    name: d.name,
    version: latest,
    description: d.description,
    license: v.license || d.license,
    deprecated: v.deprecated || undefined,
    published: day(d.time?.[latest]),
    created: day(d.time?.created),
    versions: Object.keys(d.versions || {}).length,
    weekly: dl?.downloads,
    dependencies: Object.keys(v.dependencies || {}).length,
    peerDependencies: Object.keys(v.peerDependencies || {}).join(', ') || undefined,
    engines: v.engines?.node ? `node ${v.engines.node}` : undefined,
    types: v.types || v.typings ? '自带' : undefined,
    module: v.type === 'module' ? 'ESM' : v.exports ? 'exports' : undefined,
    maintainers: d.maintainers?.map(m => m.name).join(', '),
    keywords: d.keywords?.join(', ') || undefined,
    homepage: d.homepage,
    repo: repoUrl(d.repository),
    distTags: Object.keys(d['dist-tags'] || {}).length > 1 ? d['dist-tags'] : undefined,
    recentReleases: recent,
    url: `https://www.npmjs.com/package/${d.name}`,
  }
}

/** 下载量。names 用逗号分开可以一次比多个包（各自的总数）；只有一个包时按天给出明细（every: week / month 按周、按月汇总）。
 *  period：last-day last-week last-month last-year，或者 2024-01-01:2024-06-30
 *  @example downloads('axios,got,ky,node-fetch', { period: 'last-month' })
 *  @example downloads('react', { period: 'last-year', every: 'month' }) */
export async function downloads(names, { period = 'last-month', every = 'day' } = {}) {
  const list = String(names).split(/[,\s]+/).filter(Boolean)
  if (list.length > 1) {
    const scoped = list.filter(n => n.startsWith('@'))
    const plain = list.filter(n => !n.startsWith('@'))
    const res = {}
    if (plain.length) Object.assign(res, plain.length === 1 ? { [plain[0]]: await get(`${API}/downloads/point/${period}/${plain[0]}`) } : await get(`${API}/downloads/point/${period}/${plain.join(',')}`))
    for (const s of scoped) res[s] = await get(`${API}/downloads/point/${period}/${s}`)
    return list.map(n => ({ name: n, downloads: res[n]?.downloads ?? 0, start: res[n]?.start, end: res[n]?.end })).sort((a, b) => b.downloads - a.downloads)
  }
  const j = await get(`${API}/downloads/range/${period}/${list[0]}`)
  const days = j.downloads || []
  if (!days.length) throw new BxError('EMPTY', `${list[0]} 在 ${period} 没有下载数据`)
  if (every === 'day') return days.map(d => ({ date: d.day, downloads: d.downloads }))
  const key = every === 'month' ? d => d.day.slice(0, 7) : d => {
    const t = new Date(d.day + 'T00:00:00Z')
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7))
    return t.toISOString().slice(0, 10)
  }
  const m = new Map()
  for (const d of days) m.set(key(d), (m.get(key(d)) || 0) + d.downloads)
  return [...m].map(([date, downloads]) => ({ [every]: date, downloads }))
}
