/* 站点笔记（arXiv）：
 * - 官方公开接口 export.arxiv.org/api/query，返回 Atom XML，不用登录、不用浏览器，直接 Node fetch
 *   search_query 语法：all:关键词 / ti:标题 / abs:摘要 / au:"作者" / cat:分类，可以用 AND / OR / ANDNOT 组合
 *   排序 sortBy=relevance|submittedDate|lastUpdatedDate，sortOrder=descending
 *   单篇：id_list=1706.03762（多个用逗号）
 * - 官方要求请求间隔 3 秒左右，太快会返回 503 / 空结果；这里串行请求，出错时等 3 秒重试一次
 * - 作者名不是稳定 id，同一个人可能有 "Y. Bengio" / "Yoshua Bengio" 几种写法
 * - 分类表：https://arxiv.org/category_taxonomy（cs.CL 计算语言学、cs.LG 机器学习、cs.AI、cs.CV、stat.ML …）
 */

const API = 'https://export.arxiv.org/api/query'

let last = 0
async function query(params) {
  for (let i = 0; i < 2; i++) {
    const wait = last + 3000 - Date.now()
    if (wait > 0) await bx.sleep(wait)
    last = Date.now()
    const r = await fetch(`${API}?${params}`).catch(() => null)
    if (r?.ok) return r.text()
    if (r && r.status !== 503 && r.status !== 429) throw new BxError('HTTP_ERROR', `arXiv 接口返回 ${r.status}`)
  }
  throw new BxError('BLOCKED', 'arXiv 接口暂时不可用（请求太快或服务繁忙）', '等几秒再试')
}

const decode = s =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&')
const tag = (x, t) => decode((x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] || '').replace(/\s+/g, ' ').trim())
const tags = (x, t) => [...x.matchAll(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'g'))].map(m => decode(m[1].trim()))

function parse(xml, { full = false } = {}) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const id = tag(e, 'id').replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '')
    const authors = tags(e, 'name')
    const abs = tag(e, 'summary')
    const o = {
      id,
      title: tag(e, 'title'),
      authors: authors.length > 6 && !full ? authors.slice(0, 6).join(', ') + ` 等 ${authors.length} 人` : authors.join(', '),
      published: tag(e, 'published').slice(0, 10),
      updated: tag(e, 'updated').slice(0, 10),
      category: e.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1],
      abstract: full ? abs : abs.length > 300 ? abs.slice(0, 300) + '…' : abs,
      url: `https://arxiv.org/abs/${id}`,
      pdf: `https://arxiv.org/pdf/${id}`,
    }
    if (full) {
      o.categories = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map(m => m[1]).join(', ')
      o.comment = tag(e, 'arxiv:comment') || undefined
      o.journal = tag(e, 'arxiv:journal_ref') || undefined
      o.doi = tag(e, 'arxiv:doi') || undefined
    }
    return o
  })
}

const SORT = { relevance: 'relevance', date: 'submittedDate', updated: 'lastUpdatedDate' }

/** 搜论文。q 默认在全部字段里搜，也可以直接写 arXiv 语法（ti:、abs:、au:、cat:、AND/OR）。
 *  sort：relevance 相关度 / date 最新提交 / updated 最近更新；category 限定分类（如 cs.CL）
 *  @example search('retrieval augmented generation', { limit: 10 })
 *  @example search('mixture of experts', { category: 'cs.LG', sort: 'date', limit: 10 }) */
export async function search(q, { limit = 20, sort = 'relevance', category = '', offset = 0 } = {}) {
  if (!SORT[sort]) throw new BxError('BAD_ARGS', `sort 只能是 ${Object.keys(SORT).join(' / ')}`)
  let sq = /\b(all|ti|abs|au|cat|co|jr|id):/.test(q) ? q : `all:${q.includes(' ') ? `"${q}"` : q}`
  if (category) sq = `(${sq}) AND cat:${category}`
  const xml = await query(`search_query=${encodeURIComponent(sq)}&start=${offset}&max_results=${Math.min(limit, 200)}&sortBy=${SORT[sort]}&sortOrder=descending`)
  const list = parse(xml)
  if (!list.length) throw new BxError('EMPTY', `arXiv 没搜到 ${q}`, '换个关键词，或去掉引号 / 分类限制')
  return list
}

/** 论文详情（完整摘要、全部作者、分类、备注、期刊、DOI）。id 可以是 1706.03762、带版本号或 abs/pdf 链接
 *  @example paper('1706.03762') */
export async function paper(id) {
  const ids = String(id).split(',').map(x => x.trim().replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//, '').replace(/\.pdf$/, ''))
  const list = parse(await query(`id_list=${ids.join(',')}`), { full: true }).filter(x => x.title && x.title !== 'Error')
  if (!list.length) throw new BxError('NOT_FOUND', `arXiv 上没有 ${id}`, '检查编号，例如 1706.03762')
  return ids.length === 1 ? list[0] : list
}

/** 某个作者的论文，最新的在前（按名字模糊匹配）
 *  @example author('Yoshua Bengio', { limit: 10 }) */
export async function author(name, { limit = 20 } = {}) {
  const xml = await query(`search_query=${encodeURIComponent(`au:"${name}"`)}&max_results=${Math.min(limit, 200)}&sortBy=submittedDate&sortOrder=descending`)
  const list = parse(xml)
  if (!list.length) throw new BxError('EMPTY', `没找到作者 ${name} 的论文`, '换种写法试试，比如名字缩写 "Y Bengio"')
  return list
}

/** 某个分类最新提交的论文。category 如 cs.CL cs.LG cs.AI cs.CV stat.ML
 *  @example recent('cs.CL', { limit: 20 }) */
export async function recent(category, { limit = 20 } = {}) {
  const list = parse(await query(`search_query=cat:${encodeURIComponent(category)}&max_results=${Math.min(limit, 200)}&sortBy=submittedDate&sortOrder=descending`))
  if (!list.length) throw new BxError('EMPTY', `${category} 下没有论文`, '检查分类名，见 https://arxiv.org/category_taxonomy')
  return list
}

/** 摘要页 /abs/<id> 的读法：标题、作者、完整摘要 */
export async function read(tab) {
  const id = (await tab.url()).match(/arxiv\.org\/abs\/([^?#]+)/)?.[1]
  if (!id) return null
  const p = await paper(id.replace(/v\d+$/, ''))
  return {
    title: p.title,
    type: 'article',
    meta: { author: p.authors, published: p.published, site: 'arXiv' },
    content: [`分类：${p.categories}`, p.comment && `备注：${p.comment}`, p.journal && `期刊：${p.journal}`, `PDF：${p.pdf}`, '', p.abstract].filter(x => x !== undefined && x !== null && x !== false).join('\n'),
  }
}
