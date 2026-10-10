/* 站点笔记（PyPI，Python 的包仓库）：
 * - 包信息走公开 JSON 接口，不用浏览器：pypi.org/pypi/<包名>/json（最新版）、pypi.org/pypi/<包名>/<版本>/json
 *   info 里有简介、许可证、requires_python、requires_dist（依赖）、project_urls（仓库 / 文档）；
 *   releases 是全部版本和每个版本的文件（取上传时间）；vulnerabilities 是这个版本已知的漏洞（来自 OSV）
 * - 下载量走 pypistats.org/api/packages/<包名>/recent（昨天 / 上周 / 上月）和 /overall?mirrors=false（近 180 天按天）
 *   包名要小写，下划线换成横线（pypistats 按规范化后的名字存）
 * - 搜索：pypi.org/search/?q= 是网页，有 JS 人机验证，Node 直接请求拿到的是挑战页，所以在浏览器标签里打开再读 DOM（a.package-snippet）。
 *   PyPI 自己的搜索按文本相关度，热门包不一定排前面；找热门的可以配合 google.com search 或 github.com search
 */

const UA = 'BrowserX/1.0 (https://github.com/rango886/BrowserX)'

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(60000) })
  if (r.status === 404) throw new BxError('NOT_FOUND', `PyPI 上没有：${url.replace(/^https:\/\/[^/]+\//, '')}`, '检查包名（pip install 时用的名字）')
  if (r.status === 429) throw new BxError('BLOCKED', '请求太频繁了', '停一会儿再试')
  if (!r.ok) throw new BxError('HTTP_ERROR', `${new URL(url).host} 返回 ${r.status}`)
  return r.json()
}
const norm = n => String(n).trim().toLowerCase().replace(/[_.]+/g, '-')
const day = s => s?.slice(0, 10)
const relDate = files => files?.map(f => f.upload_time_iso_8601 || f.upload_time).filter(Boolean).sort()[0]

/** 搜包（在浏览器里打开 PyPI 搜索页读结果）。按文本相关度排，热门包不一定在前面
 *  @example search('http client', { limit: 10 }) */
export async function search(q, { limit = 20 } = {}) {
  const tab = await bx.open(`https://pypi.org/search/?q=${encodeURIComponent(q)}`)
  try {
    await tab.waitFor({ selector: 'a.package-snippet, .callout-block', timeout: 20000 }).catch(() => {})
    const list = await tab.eval(n => [...document.querySelectorAll('a.package-snippet')].slice(0, n).map(a => ({
      name: a.querySelector('.package-snippet__name')?.innerText?.trim(),
      version: a.querySelector('.package-snippet__version')?.innerText?.trim() || undefined,
      description: a.querySelector('.package-snippet__description')?.innerText?.trim() || undefined,
      released: a.querySelector('.package-snippet__created time')?.getAttribute('datetime')?.slice(0, 10),
      url: a.href,
    })), limit)
    if (!list.length) {
      const text = await tab.eval(() => document.body.innerText.slice(0, 300))
      if (/robot|challenge|verify|captcha/i.test(text)) throw new BxError('BLOCKED', 'PyPI 要人机验证', `bx tab activate ${tab.id} 处理一下`)
      throw new BxError('EMPTY', `PyPI 没搜到 ${q}`)
    }
    return list.map((x, i) => ({ rank: i + 1, ...x }))
  } finally {
    await tab.close().catch(() => {})
  }
}

/** 包详情：最新版本、发布时间、Python 版本要求、许可证、依赖、仓库和文档链接、版本数、最近几次发布、这个版本的已知漏洞、下载量。
 *  version 查某个具体版本
 *  @example info('httpx')
 *  @example info('requests', { version: '2.19.0' }) */
export async function info(name, { version = '', releases = 5 } = {}) {
  const [j, dl] = await Promise.all([
    get(`https://pypi.org/pypi/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ''}/json`),
    get(`https://pypistats.org/api/packages/${norm(name)}/recent`).catch(() => null),
  ])
  const i = j.info
  const all = Object.entries(j.releases || {}).map(([v, files]) => ({ version: v, date: day(relDate(files)), yanked: files.length && files.every(f => f.yanked) }))
  const deps = (i.requires_dist || []).filter(d => !/extra\s*==/.test(d))
  const extras = [...new Set((i.requires_dist || []).map(d => d.match(/extra\s*==\s*['"]([^'"]+)/)?.[1]).filter(Boolean))]
  const urls = i.project_urls || {}
  const find = re => Object.entries(urls).find(([k, v]) => re.test(k) || re.test(v))?.[1]
  return {
    name: i.name,
    version: i.version,
    summary: i.summary,
    released: day(relDate(j.urls)),
    requiresPython: i.requires_python || undefined,
    license: i.license_expression || (i.license && i.license.length < 80 ? i.license : undefined) || i.classifiers?.find(c => c.startsWith('License ::'))?.split('::').pop().trim(),
    status: i.classifiers?.find(c => c.startsWith('Development Status'))?.split('::').pop().trim(),
    author: i.author || i.author_email?.replace(/\s*<.*?>/g, '') || undefined,
    dependencies: deps.map(d => d.split(/[\s;(<>=!~]/)[0]).join(', ') || undefined,
    extras: extras.join(', ') || undefined,
    versions: version ? undefined : all.length,
    recentReleases: version ? undefined : all.filter(r => r.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, releases).map(r => ({ version: r.version, date: r.date, yanked: r.yanked || undefined })),
    yanked: i.yanked ? i.yanked_reason || true : undefined,
    vulnerabilities: (j.vulnerabilities || []).map(v => ({ id: v.id, aliases: v.aliases?.join(', '), fixedIn: v.fixed_in?.join(', '), summary: (v.summary || v.details || '').slice(0, 200) })),
    lastDay: dl?.data?.last_day,
    lastWeek: dl?.data?.last_week,
    lastMonth: dl?.data?.last_month,
    repo: find(/github\.com|gitlab\.com|source|repository|code/i),
    docs: find(/doc/i),
    homepage: i.home_page || find(/home/i),
    url: `https://pypi.org/project/${i.name}/`,
  }
}

/** 下载量（来自 pypistats，不含镜像）。names 用逗号分开可以比较多个包（昨天 / 上周 / 上月）；
 *  只有一个包时给出近 180 天的明细，every：day / week / month
 *  @example downloads('requests,httpx,aiohttp,urllib3')
 *  @example downloads('httpx', { every: 'month' }) */
export async function downloads(names, { every = 'week' } = {}) {
  const list = String(names).split(/[,\s]+/).filter(Boolean)
  if (list.length > 1) {
    const rows = []
    for (const n of list) {
      const j = await get(`https://pypistats.org/api/packages/${norm(n)}/recent`).catch(e => ({ error: e.message }))
      rows.push({ name: n, lastDay: j.data?.last_day, lastWeek: j.data?.last_week, lastMonth: j.data?.last_month, error: j.error })
    }
    return rows.sort((a, b) => (b.lastMonth || 0) - (a.lastMonth || 0))
  }
  const j = await get(`https://pypistats.org/api/packages/${norm(list[0])}/overall?mirrors=false`)
  const days = (j.data || []).filter(d => d.category === 'without_mirrors').sort((a, b) => a.date.localeCompare(b.date))
  if (!days.length) throw new BxError('EMPTY', `${list[0]} 没有下载数据`)
  if (every === 'day') return days.map(d => ({ date: d.date, downloads: d.downloads }))
  const key = every === 'month' ? d => d.date.slice(0, 7) : d => {
    const t = new Date(d.date + 'T00:00:00Z')
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7))
    return t.toISOString().slice(0, 10)
  }
  const m = new Map()
  for (const d of days) m.set(key(d), (m.get(key(d)) || 0) + d.downloads)
  return [...m].map(([date, downloads]) => ({ [every]: date, downloads }))
}
