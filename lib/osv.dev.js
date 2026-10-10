/* 站点笔记（OSV.dev，Google 维护的开源漏洞库，汇总 GitHub Advisory、PyPA、RustSec、Go 等来源）：
 * - 公开接口 api.osv.dev，不用登录、不用浏览器
 *   查一个包（可带版本）POST /v1/query {package:{name, ecosystem}, version}，不带版本就是这个包历史上所有漏洞
 *   单个漏洞 GET /v1/vulns/<id>（GHSA-… / PYSEC-… / RUSTSEC-… / GO-… / CVE-…）
 *   结果多时返回 next_page_token，要带上 page_token 再请求
 * - ecosystem 区分大小写：npm PyPI Go Maven NuGet RubyGems crates.io Packagist Pub Hex SwiftURL Debian Ubuntu Alpine …
 *   这里接受小写写法（pypi、cargo、rust、golang、java 等会自动转换）
 * - 严重程度：优先 database_specific.severity（GitHub 的 LOW/MODERATE/HIGH/CRITICAL），没有就给 CVSS 向量
 * - 同一个漏洞常在几个来源里各有一条（GHSA-… 和 PYSEC-…），query 按 CVE 合并，其余编号放在 sameAs
 * - 修复版本在 affected[].ranges[].events 里的 fixed
 */

const API = 'https://api.osv.dev/v1'
const ECO = { npm: 'npm', node: 'npm', js: 'npm', pypi: 'PyPI', python: 'PyPI', pip: 'PyPI', go: 'Go', golang: 'Go', maven: 'Maven', java: 'Maven', nuget: 'NuGet', '.net': 'NuGet', rubygems: 'RubyGems', ruby: 'RubyGems', gem: 'RubyGems', 'crates.io': 'crates.io', cargo: 'crates.io', rust: 'crates.io', crates: 'crates.io', packagist: 'Packagist', php: 'Packagist', composer: 'Packagist', pub: 'Pub', dart: 'Pub', hex: 'Hex', elixir: 'Hex', swifturl: 'SwiftURL', debian: 'Debian', ubuntu: 'Ubuntu', alpine: 'Alpine', github: 'GitHub Actions' }

async function call(path, body) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  if (r.status === 404) throw new BxError('NOT_FOUND', `OSV 没有 ${path.split('/').pop()}`, '漏洞编号形如 GHSA-xxxx-xxxx-xxxx、PYSEC-2023-74、CVE-2021-44228')
  if (r.status === 429) throw new BxError('BLOCKED', 'OSV 限流了', '停一会儿再试')
  if (!r.ok) throw new BxError('HTTP_ERROR', `OSV 返回 ${r.status}：${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const sev = v => v.database_specific?.severity || v.severity?.map(s => s.score).find(Boolean)
function fixed(v, name) {
  const out = new Set()
  for (const a of v.affected || []) {
    if (name && a.package?.name?.toLowerCase() !== name.toLowerCase()) continue
    for (const r of a.ranges || []) for (const e of r.events || []) if (e.fixed) out.add(e.fixed)
  }
  return [...out].join(', ') || undefined
}
const cves = v => (v.aliases || []).filter(a => a.startsWith('CVE-')).join(', ') || undefined

/** 查一个包有哪些已知漏洞。ecosystem：npm / pypi / go / maven / nuget / rubygems / cargo / packagist …；
 *  version 写了就只返回影响这个版本的漏洞（"我用的版本安全吗"），不写就是历史上全部
 *  @example query('requests', { ecosystem: 'pypi', version: '2.19.0' })
 *  @example query('lodash', { ecosystem: 'npm' })
 *  @example query('github.com/gin-gonic/gin', { ecosystem: 'go' }) */
export async function query(name, { ecosystem, version = '', limit = 100 } = {}) {
  if (!ecosystem) throw new BxError('BAD_ARGS', '要指定 ecosystem', `可选：${[...new Set(Object.values(ECO))].join(' / ')}`)
  const eco = ECO[ecosystem.toLowerCase()] || ecosystem
  const vulns = []
  let token
  do {
    const body = { package: { name, ecosystem: eco }, ...(version ? { version } : {}), ...(token ? { page_token: token } : {}) }
    const j = await call('/query', body)
    vulns.push(...(j.vulns || []))
    token = j.next_page_token
  } while (token && vulns.length < limit)
  if (!vulns.length) throw new BxError('EMPTY', `OSV 没有 ${eco}:${name}${version ? '@' + version : ''} 的已知漏洞`, version ? '这个版本目前没有已知漏洞' : '检查包名和 ecosystem')
  // 同一个 CVE 在不同来源里各有一条（GHSA / PYSEC …），合并成一条，优先留带严重等级的 GHSA
  const seen = new Map()
  for (const v of vulns) {
    const key = cves(v) || v.id
    const old = seen.get(key)
    if (!old) seen.set(key, { ...v, also: [] })
    else if (!old.database_specific?.severity && v.database_specific?.severity) seen.set(key, { ...v, also: [...old.also, old.id] })
    else old.also.push(v.id)
  }
  return [...seen.values()]
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''))
    .slice(0, limit)
    .map((v, i) => ({ rank: i + 1, id: v.id, cve: cves(v), severity: sev(v), summary: v.summary || (v.details || '').split('\n')[0].slice(0, 200), fixedIn: fixed(v, name), published: v.published?.slice(0, 10), withdrawn: v.withdrawn ? v.withdrawn.slice(0, 10) : undefined, sameAs: v.also.join(', ') || undefined, url: `https://osv.dev/vulnerability/${v.id}` }))
}

/** 单个漏洞详情：别名（CVE / GHSA）、严重程度、影响的包和版本范围、修复版本、完整说明、参考链接
 *  @example vulnerability('GHSA-jfh8-c2jp-5v3q')
 *  @example vulnerability('CVE-2024-3094') */
export async function vulnerability(id, { maxLength = 6000 } = {}) {
  const v = await call(`/vulns/${encodeURIComponent(String(id).trim())}`)
  const details = v.details || ''
  return {
    id: v.id,
    aliases: v.aliases?.join(', ') || undefined,
    severity: sev(v),
    cvss: v.severity?.map(s => `${s.type} ${s.score}`).join('；') || undefined,
    summary: v.summary,
    published: v.published?.slice(0, 10),
    modified: v.modified?.slice(0, 10),
    withdrawn: v.withdrawn?.slice(0, 10),
    cwe: v.database_specific?.cwe_ids?.join(', ') || undefined,
    affected: (v.affected || []).map(a => ({
      package: `${a.package?.ecosystem}:${a.package?.name}`,
      ranges: (a.ranges || []).map(r => r.events.map(e => Object.entries(e).map(([k, x]) => `${k} ${x}`).join('')).join(' → ')).join('；') || undefined,
      versions: a.versions?.length ? (a.versions.length > 10 ? `${a.versions.slice(0, 10).join(', ')} … 共 ${a.versions.length} 个` : a.versions.join(', ')) : undefined,
    })),
    details: details.length > maxLength ? details.slice(0, maxLength) + '…' : details,
    references: (v.references || []).slice(0, 20).map(r => `${r.type}: ${r.url}`),
    url: `https://osv.dev/vulnerability/${v.id}`,
  }
}
