/* 站点笔记（NVD，美国国家漏洞数据库，CVE 的官方详情）：
 * - 公开接口 services.nvd.nist.gov/rest/json/cves/2.0，不用登录。不带 key 限流 5 次 / 30 秒（这里自动排队）；
 *   有免费 key 的话设环境变量 NVD_API_KEY（请求头 apiKey，50 次 / 30 秒）
 *   单个 ?cveId=CVE-2021-44228
 *   搜索 ?keywordSearch=&keywordExactMatch&cvssV3Severity=CRITICAL|HIGH|MEDIUM|LOW&pubStartDate=&pubEndDate=
 *        &hasKev（只要已被实际利用的，CISA KEV 名单）&resultsPerPage=&startIndex=
 *     时间区间最长 120 天，格式 2024-01-01T00:00:00.000；结果默认按发布时间从旧到新，这里取最后一页再倒过来得到最新的
 * - 评分优先 CVSS v4.0 → v3.1 → v3.0 → v2；cisaExploitAdd 有值说明 CISA 确认被在野利用过
 * - 影响的产品在 configurations 里（CPE 格式 cpe:2.3:a:厂商:产品:版本），这里提取成“厂商 产品 版本范围”
 */

const API = 'https://services.nvd.nist.gov/rest/json/cves/2.0'

let chain = Promise.resolve()
const stamps = []
function get(params) {
  const run = async () => {
    const limit = process.env.NVD_API_KEY ? 50 : 5
    while (stamps.length >= limit && Date.now() - stamps[0] < 30500) await bx.sleep(30500 - (Date.now() - stamps[0]))
    while (stamps.length >= limit) stamps.shift()
    stamps.push(Date.now())
    const headers = { accept: 'application/json' }
    if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY
    const r = await fetch(`${API}?${params}`, { headers, signal: AbortSignal.timeout(60000) })
    if (r.status === 403 || r.status === 429) throw new BxError('BLOCKED', 'NVD 限流了（不带 key 每 30 秒 5 次）', '等半分钟再试，或者设置环境变量 NVD_API_KEY')
    if (r.status === 404) return { vulnerabilities: [], totalResults: 0 }
    if (!r.ok) throw new BxError('HTTP_ERROR', `NVD 返回 ${r.status}：${r.headers.get('message') || ''}`)
    return r.json()
  }
  const p = chain.then(run, run)
  chain = p.catch(() => {})
  return p
}

function score(m = {}) {
  const pick = m.cvssMetricV40?.[0] || m.cvssMetricV31?.[0] || m.cvssMetricV30?.[0] || m.cvssMetricV2?.[0]
  if (!pick) return {}
  const d = pick.cvssData || {}
  return { score: d.baseScore, severity: d.baseSeverity || pick.baseSeverity, cvss: `v${d.version}`, vector: d.vectorString, attackVector: d.attackVector || d.accessVector }
}
const en = arr => arr?.find(x => x.lang === 'en')?.value

function products(cfgs = []) {
  const out = new Set()
  for (const c of cfgs) for (const n of c.nodes || []) for (const m of n.cpeMatch || []) {
    if (!m.vulnerable) continue
    const [, , , vendor, product, ver] = m.criteria.split(':')
    let range = ver && ver !== '*' && ver !== '-' ? ver : ''
    if (m.versionStartIncluding) range += `>=${m.versionStartIncluding} `
    if (m.versionStartExcluding) range += `>${m.versionStartExcluding} `
    if (m.versionEndExcluding) range += `<${m.versionEndExcluding}`
    if (m.versionEndIncluding) range += `<=${m.versionEndIncluding}`
    out.add(`${vendor} ${product}${range ? ' ' + range.trim() : ''}`)
  }
  return [...out]
}

function row(v, { full = false } = {}) {
  const c = v.cve
  const desc = en(c.descriptions) || ''
  const o = {
    id: c.id,
    ...score(c.metrics),
    published: c.published?.slice(0, 10),
    modified: c.lastModified?.slice(0, 10),
    status: c.vulnStatus,
    exploited: c.cisaExploitAdd ? `CISA ${c.cisaExploitAdd} 确认被利用` : undefined,
    cwe: [...new Set((c.weaknesses || []).flatMap(w => w.description.map(d => d.value)).filter(x => x.startsWith('CWE')))].join(', ') || undefined,
    description: full || desc.length <= 300 ? desc : desc.slice(0, 300) + '…',
    url: `https://nvd.nist.gov/vuln/detail/${c.id}`,
  }
  if (full) {
    const ps = products(c.configurations)
    o.affected = ps.length > 40 ? [...ps.slice(0, 40), `… 共 ${ps.length} 项`] : ps
    o.cisaAction = c.cisaRequiredAction || undefined
    o.references = (c.references || []).slice(0, 20).map(r => ({ url: r.url, tags: r.tags?.join(', ') || undefined }))
  }
  return o
}

/** 单个 CVE 的详情：评分和严重程度、攻击途径、是否被在野利用（CISA KEV）、CWE 类型、完整描述、影响的产品和版本范围、参考链接（补丁、公告）
 *  @example cve('CVE-2021-44228')
 *  @example cve('CVE-2024-3094') */
export async function cve(id) {
  const cid = String(id).trim().toUpperCase().match(/CVE-\d{4}-\d{4,}/)?.[0]
  if (!cid) throw new BxError('BAD_ARGS', `不是 CVE 编号：${id}`, '格式是 CVE-2021-44228')
  const j = await get(`cveId=${cid}`)
  if (!j.vulnerabilities?.length) throw new BxError('NOT_FOUND', `NVD 没有 ${cid}`, '刚公开的 CVE 可能还没收录')
  return row(j.vulnerabilities[0], { full: true })
}

const iso = d => d.toISOString().slice(0, 23)

/** 按关键词搜漏洞，最新发布的在前。q 匹配描述（多个词都要出现；exact: true 当成整个短语）；
 *  severity：critical / high / medium / low（按 CVSS v3）；days 只看最近多少天发布的（最多 120）；exploited: true 只要已被在野利用的
 *  @example search('openssl', { days: 120, limit: 10 })
 *  @example search('remote code execution', { severity: 'critical', days: 30, limit: 20 })
 *  @example search('', { exploited: true, days: 60 }) */
export async function search(q = '', { severity = '', days = 0, exploited = false, exact = false, limit = 20 } = {}) {
  let p = ''
  if (q) p += `&keywordSearch=${encodeURIComponent(q)}${exact ? '&keywordExactMatch' : ''}`
  if (severity) p += `&cvssV3Severity=${severity.toUpperCase()}`
  if (exploited) p += '&hasKev'
  if (days || (!q && !severity)) {
    const end = new Date()
    const start = new Date(end - Math.min(days || 30, 120) * 86400000)
    p += `&pubStartDate=${iso(start)}&pubEndDate=${iso(end)}`
  }
  p = p.slice(1)
  // 先拿总数，再取最后一页（最新的）
  const head = await get(`${p}&resultsPerPage=1`)
  const total = head.totalResults || 0
  if (!total) throw new BxError('EMPTY', `NVD 没有匹配的漏洞`, days ? '放宽 days 或去掉 severity' : '换个关键词，或者加 days 只看最近的')
  const n = Math.min(limit, 2000)
  const j = await get(`${p}&resultsPerPage=${n}&startIndex=${Math.max(0, total - n)}`)
  return (j.vulnerabilities || []).reverse().map((v, i) => ({ rank: i + 1, ...row(v) }))
}
