/* 站点笔记（crates.io，Rust 的包仓库）：
 * - 公开接口 crates.io/api/v1，不用登录。官方要求带能联系到人的 User-Agent，否则 403；限流大约每秒 1 次
 *   搜索 /crates?q=&per_page=&sort=relevance|downloads|recent-downloads|recent-updates|new
 *   详情 /crates/<名字>（crate 是汇总信息，versions 是全部版本，含许可证、rust_version、发布人、features）
 *   下载量 /crates/<名字>/downloads（近 90 天按天；version_downloads 按版本拆开，extra_downloads 是其余老版本）
 *   被多少包依赖 /crates/<名字>/reverse_dependencies?per_page=1（看 meta.total）
 * - recent_downloads 是最近 90 天的下载量
 */

const API = 'https://crates.io/api/v1'
const UA = 'BrowserX/1.0 (https://github.com/rango886/BrowserX)'

let last = 0
async function get(path) {
  const wait = last + 1000 - Date.now()
  if (wait > 0) await bx.sleep(wait)
  last = Date.now()
  const r = await fetch(API + path, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(60000) })
  if (r.status === 404) throw new BxError('NOT_FOUND', `crates.io 上没有：${path.split('/')[2]}`, '检查名字（Cargo.toml 里写的那个）')
  if (r.status === 429) throw new BxError('BLOCKED', 'crates.io 限流了', '停一会儿再试')
  if (!r.ok) throw new BxError('HTTP_ERROR', `crates.io 返回 ${r.status}`)
  return r.json()
}
const day = s => s?.slice(0, 10)
const SORTS = { relevance: 'relevance', downloads: 'downloads', recent: 'recent-downloads', updated: 'recent-updates', new: 'new' }

/** 搜 crate。sort：relevance 相关度 / downloads 总下载 / recent 近 90 天下载 / updated 最近更新 / new 最新发布
 *  @example search('http client', { limit: 10 })
 *  @example search('async runtime', { sort: 'recent', limit: 10 }) */
export async function search(q, { sort = 'relevance', limit = 20 } = {}) {
  if (!SORTS[sort]) throw new BxError('BAD_ARGS', `sort 只能是 ${Object.keys(SORTS).join(' / ')}`)
  const j = await get(`/crates?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 100)}&sort=${SORTS[sort]}`)
  if (!j.crates?.length) throw new BxError('EMPTY', `crates.io 没搜到 ${q}`)
  return j.crates.map((c, i) => ({
    rank: i + 1,
    name: c.name,
    version: c.default_version || c.max_stable_version || c.max_version,
    description: c.description?.replace(/\s+/g, ' ').trim(),
    downloads: c.downloads,
    recent: c.recent_downloads,
    updated: day(c.updated_at),
    repo: c.repository || undefined,
    url: `https://crates.io/crates/${c.name}`,
  }))
}

/** crate 详情：最新版本、许可证、最低 Rust 版本、版本数、总下载 / 近 90 天下载、被多少 crate 依赖、features、最近几次发布、仓库和文档
 *  @example info('tokio')
 *  @example info('serde', { releases: 10 }) */
export async function info(name, { releases = 5 } = {}) {
  const j = await get(`/crates/${encodeURIComponent(name)}`)
  const rev = await get(`/crates/${encodeURIComponent(name)}/reverse_dependencies?per_page=1`).catch(() => null)
  const c = j.crate
  const vs = j.versions || []
  const cur = vs.find(v => v.num === (c.default_version || c.max_stable_version)) || vs[0] || {}
  return {
    name: c.name,
    version: cur.num,
    description: c.description?.replace(/\s+/g, ' ').trim(),
    license: cur.license,
    rustVersion: cur.rust_version || undefined,
    edition: cur.edition || undefined,
    published: day(cur.created_at),
    publishedBy: cur.published_by?.login,
    created: day(c.created_at),
    versions: c.num_versions ?? vs.length,
    downloads: c.downloads,
    recent: c.recent_downloads,
    dependents: rev?.meta?.total,
    features: Object.keys(cur.features || {}).join(', ') || undefined,
    keywords: c.keywords?.join(', ') || j.keywords?.map(k => k.keyword || k.id).join(', ') || undefined,
    categories: c.categories?.join(', ') || j.categories?.map(k => k.category || k.id).join(', ') || undefined,
    recentReleases: vs.slice(0, releases).map(v => ({ version: v.num, date: day(v.created_at), downloads: v.downloads, yanked: v.yanked || undefined })),
    repo: c.repository || undefined,
    docs: c.documentation || `https://docs.rs/${c.name}`,
    homepage: c.homepage || undefined,
    url: `https://crates.io/crates/${c.name}`,
  }
}

/** 近 90 天的下载量（所有版本加起来）。every：day / week
 *  @example downloads('tokio', { every: 'week' }) */
export async function downloads(name, { every = 'week' } = {}) {
  const j = await get(`/crates/${encodeURIComponent(name)}/downloads`)
  const m = new Map()
  for (const d of [...(j.version_downloads || []), ...(j.meta?.extra_downloads || [])]) m.set(d.date, (m.get(d.date) || 0) + d.downloads)
  const days = [...m].sort((a, b) => a[0].localeCompare(b[0]))
  if (!days.length) throw new BxError('EMPTY', `${name} 没有下载数据`)
  if (every === 'day') return days.map(([date, downloads]) => ({ date, downloads }))
  const w = new Map()
  for (const [date, n] of days) {
    const t = new Date(date + 'T00:00:00Z')
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7))
    const k = t.toISOString().slice(0, 10)
    w.set(k, (w.get(k) || 0) + n)
  }
  return [...w].map(([week, downloads]) => ({ week, downloads }))
}
