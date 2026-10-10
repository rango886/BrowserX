/* 站点笔记（Semantic Scholar，学术搜索 + 引用图谱）：
 * - 官方公开接口 api.semanticscholar.org，不用登录、不用浏览器
 *   图谱：/graph/v1/paper/search?query=&fields=&year=2023-&limit=   /graph/v1/paper/<ref>?fields=
 *         /graph/v1/paper/<ref>/citations（谁引用了它）  /graph/v1/paper/<ref>/references（它引用了谁）
 *   推荐：/recommendations/v1/papers/forpaper/<ref>?from=all-cs|recent（相似论文；默认池是 recent，老论文在里面找不到，要用 all-cs）
 * - <ref> 可以是 40 位 paperId、DOI:10.xxx、ARXIV:1706.03762、PMID:、CorpusId: 或 semanticscholar.org/paper/… 链接
 * - 匿名限流大约 100 次 / 5 分钟，经常 429：这里串行 + 遇到 429 等 4/8/12 秒重试三次。
 *   有免费 key 的话设环境变量 SEMANTIC_SCHOLAR_API_KEY，限额高很多
 * - 独有字段：influentialCitationCount（"有影响力"的引用数）、tldr（AI 生成的一句话总结，不是每篇都有）
 */

const GRAPH = 'https://api.semanticscholar.org/graph/v1'
const REC = 'https://api.semanticscholar.org/recommendations/v1'
const LIST_FIELDS = 'paperId,title,year,authors,citationCount,influentialCitationCount,venue,externalIds,publicationDate'

let chain = Promise.resolve()
async function api(url) {
  const run = async () => {
    const headers = { accept: 'application/json' }
    if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY
    for (let i = 0; ; i++) {
      const r = await fetch(url, { headers })
      if (r.status === 429 && i < 3) {
        await bx.sleep(4000 * (i + 1))
        continue
      }
      if (r.status === 429) throw new BxError('BLOCKED', 'Semantic Scholar 限流了（匿名大约 100 次 / 5 分钟）', '等一两分钟再试，或者设置环境变量 SEMANTIC_SCHOLAR_API_KEY')
      if (r.status === 404) throw new BxError('NOT_FOUND', 'Semantic Scholar 没有这篇论文', '检查 id；arXiv 写成 ARXIV:1706.03762，DOI 写成 DOI:10.xxx')
      if (!r.ok) throw new BxError('HTTP_ERROR', `Semantic Scholar 返回 ${r.status}：${(await r.text()).slice(0, 200)}`)
      return r.json()
    }
  }
  const p = chain.then(run, run)
  chain = p.catch(() => {})
  return p
}

/** 把各种写法的论文编号转成接口认的格式 */
function ref(id) {
  const s = String(id).trim()
  const m = s.match(/semanticscholar\.org\/paper\/(?:[^/]+\/)?([0-9a-f]{40})/i)
  if (m) return m[1]
  if (/^[0-9a-f]{40}$/i.test(s)) return s
  if (/^(ARXIV|MAG|ACL|PMID|PMCID|URL|CorpusId|DBLP|DOI):/i.test(s)) return s
  const arx = s.match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:v\d+)?(?:\.pdf)?$/)
  if (arx) return `ARXIV:${arx[1]}`
  const doi = s.replace(/^doi:|^https?:\/\/(dx\.)?doi\.org\//i, '')
  if (/^10\.\S+$/.test(doi)) return `DOI:${doi}`
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s) || /^[a-z-]+\/\d{7}$/i.test(s)) return `ARXIV:${s.replace(/v\d+$/, '')}`
  throw new BxError('BAD_ARGS', `认不出论文编号：${id}`, '可以是 paperId、DOI、arXiv 编号（1706.03762）或 semanticscholar.org 链接')
}

function row(p, extra = {}) {
  const authors = (p.authors || []).map(a => a.name)
  return {
    ...extra,
    paperId: p.paperId,
    title: p.title,
    year: p.year,
    authors: authors.length > 4 ? authors.slice(0, 4).join(', ') + ` 等 ${authors.length} 人` : authors.join(', '),
    venue: p.venue || undefined,
    citations: p.citationCount,
    influential: p.influentialCitationCount,
    arxiv: p.externalIds?.ArXiv,
    doi: p.externalIds?.DOI,
    url: `https://www.semanticscholar.org/paper/${p.paperId}`,
  }
}

/** 搜论文，按相关度。year 限定年份：'2023' / '2020-2023' / '2022-'（之后）；minCitations 最少引用数
 *  @example search('retrieval augmented generation', { limit: 10 })
 *  @example search('speculative decoding', { year: '2023-', minCitations: 50 }) */
export async function search(q, { limit = 20, year = '', minCitations = 0, offset = 0 } = {}) {
  let url = `${GRAPH}/paper/search?query=${encodeURIComponent(q)}&fields=${LIST_FIELDS}&limit=${Math.min(limit, 100)}&offset=${offset}`
  if (year) url += `&year=${encodeURIComponent(year)}`
  if (minCitations) url += `&minCitationCount=${minCitations}`
  const j = await api(url)
  if (!j.data?.length) throw new BxError('EMPTY', `没搜到 ${q}`, '换个关键词，或放宽年份 / 引用数')
  return j.data.map((p, i) => row(p, { rank: offset + i + 1 }))
}

/** 论文详情：摘要、AI 一句话总结（tldr）、引用数 / 有影响力的引用数 / 参考文献数、发表信息
 *  @example paper('1706.03762')
 *  @example paper('DOI:10.18653/v1/N19-1423') */
export async function paper(id) {
  const p = await api(`${GRAPH}/paper/${encodeURIComponent(ref(id))}?fields=${LIST_FIELDS},abstract,tldr,referenceCount,fieldsOfStudy,openAccessPdf,journal`)
  return {
    ...row(p),
    authors: (p.authors || []).map(a => a.name).join(', '),
    date: p.publicationDate || undefined,
    references: p.referenceCount,
    fields: p.fieldsOfStudy?.join(', ') || undefined,
    tldr: p.tldr?.text,
    abstract: p.abstract || undefined,
    pdf: p.openAccessPdf?.url || undefined,
  }
}

async function edges(id, kind, key, { limit, offset }) {
  const j = await api(`${GRAPH}/paper/${encodeURIComponent(ref(id))}/${kind}?fields=${LIST_FIELDS},contexts,isInfluential&limit=${Math.min(limit, 1000)}&offset=${offset}`)
  const list = (j.data || []).filter(x => x[key]?.paperId)
  if (!list.length) throw new BxError('EMPTY', `没有${kind === 'citations' ? '引用它的论文' : '参考文献数据'}`, offset ? '减小 offset' : '这篇论文的引用数据可能还没收录')
  return list.map((x, i) => row(x[key], { rank: offset + i + 1, influentialEdge: x.isInfluential || undefined }))
}

/** 谁引用了这篇论文（按收录顺序，不是按引用数）。influentialEdge 表示这是一次"有影响力"的引用
 *  @example citations('1706.03762', { limit: 20 }) */
export async function citations(id, { limit = 50, offset = 0 } = {}) {
  return edges(id, 'citations', 'citingPaper', { limit, offset })
}

/** 这篇论文引用了哪些论文（参考文献）
 *  @example references('2005.11401', { limit: 30 }) */
export async function references(id, { limit = 100, offset = 0 } = {}) {
  return edges(id, 'references', 'citedPaper', { limit, offset })
}

/** 相似论文推荐（Semantic Scholar 根据语义算出来的，适合顺着一篇论文找同方向的工作）。
 *  from：all-cs 在全部计算机论文里找（默认）/ recent 只在最近的论文里找；all-cs 没结果时自动改用 recent
 *  @example recommendations('1706.03762', { limit: 10 })
 *  @example recommendations('2005.11401', { from: 'recent', limit: 10 }) */
export async function recommendations(id, { limit = 20, from = 'all-cs' } = {}) {
  const get = pool => api(`${REC}/papers/forpaper/${encodeURIComponent(ref(id))}?fields=${LIST_FIELDS}&limit=${Math.min(limit, 500)}&from=${pool}`)
  let j = await get(from)
  if (!j.recommendedPapers?.length && from !== 'recent') j = await get('recent')
  if (!j.recommendedPapers?.length) throw new BxError('EMPTY', `没有 ${id} 的推荐结果`)
  return j.recommendedPapers.map((p, i) => row(p, { rank: i + 1 }))
}
