/* 站点笔记（Hugging Face）：
 * - 官方公开接口，不用登录、不用浏览器；环境变量 HF_TOKEN 有值时带上（能看 gated / 私有模型的信息）
 *   列表 /api/models | /api/datasets | /api/spaces ?search=&sort=&direction=-1&limit=&full=true（模型还能 pipeline_tag=、author=）
 *   sort 可选 downloads / likes / trendingScore / createdAt / lastModified（注意是 trendingScore，写 trending 会 400）
 *   模型详情 /api/models/<id>?expand[]=safetensors&expand[]=cardData…（参数量在 safetensors.total）；模型卡 /<id>/raw/main/README.md
 *   论文：/api/daily_papers?date=YYYY-MM-DD（每日热门，社区投票）、/api/papers?period=weekly|monthly、
 *         /api/papers/search?q=、/api/papers/<arxiv id>（带 ai_summary、关联的模型 / 数据集 / Space 数量）
 * - 论文 id 就是 arXiv 编号，可以接着用 arxiv.org 的 paper() 看详情
 */

const HF = 'https://huggingface.co'

async function get(path, { text = false } = {}) {
  const headers = { accept: text ? 'text/plain' : 'application/json' }
  if (process.env.HF_TOKEN) headers.authorization = `Bearer ${process.env.HF_TOKEN}`
  const r = await fetch(HF + path, { headers })
  if (r.status === 404) throw new BxError('NOT_FOUND', `Hugging Face 上没有：${path}`, '检查 id，格式是 组织/名字，例如 Qwen/Qwen3-8B')
  if (r.status === 401 || r.status === 403) throw new BxError('NEED_LOGIN', `没有权限访问 ${path}（gated 或私有）`, '设置环境变量 HF_TOKEN')
  if (r.status === 429) throw new BxError('BLOCKED', 'Hugging Face 限流了', '停一会儿再试')
  if (!r.ok) throw new BxError('HTTP_ERROR', `Hugging Face 返回 ${r.status}：${(await r.text()).slice(0, 200)}`)
  return text ? r.text() : r.json()
}

const SORT = { downloads: 'downloads', likes: 'likes', trending: 'trendingScore', created: 'createdAt', updated: 'lastModified' }
const day = s => s?.slice(0, 10)
const num = n => (n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(0) + 'M' : n ? String(n) : undefined)
const license = tags => tags?.find(t => t.startsWith('license:'))?.slice(8)

function query({ q, sort, limit, author, extra = '' }) {
  if (!SORT[sort]) throw new BxError('BAD_ARGS', `sort 只能是 ${Object.keys(SORT).join(' / ')}`)
  let s = `?sort=${SORT[sort]}&direction=-1&limit=${Math.min(limit, 1000)}&full=true`
  if (q) s += `&search=${encodeURIComponent(q)}`
  if (author) s += `&author=${encodeURIComponent(author)}`
  return s + extra
}

/** 搜模型 / 模型排行。q 按名字模糊搜（可选）；task 按任务筛，如 text-generation、text-to-image、automatic-speech-recognition、
 *  image-text-to-text、feature-extraction；author 只看某个组织；sort：downloads / likes / trending / created / updated
 *  @example models('qwen3', { sort: 'downloads', limit: 10 })
 *  @example models('', { task: 'text-to-image', sort: 'trending', limit: 20 })
 *  @example models('', { author: 'deepseek-ai', sort: 'created', limit: 10 }) */
export async function models(q = '', { task = '', author = '', sort = 'trending', limit = 20 } = {}) {
  const list = await get('/api/models' + query({ q, sort, limit, author, extra: task ? `&pipeline_tag=${encodeURIComponent(task)}` : '' }))
  if (!list.length) throw new BxError('EMPTY', `没找到模型 ${q || ''}`, '换个关键词或去掉筛选条件')
  return list.map((m, i) => ({
    rank: i + 1,
    id: m.id,
    task: m.pipeline_tag,
    library: m.library_name,
    downloads: m.downloads,
    likes: m.likes,
    trending: m.trendingScore,
    license: license(m.tags),
    created: day(m.createdAt),
    updated: day(m.lastModified),
    url: `${HF}/${m.id}`,
  }))
}

/** 模型详情：参数量、架构、许可证、基座模型、关联论文、下载量、文件列表；card: true 带上模型卡（README）正文
 *  @example model('Qwen/Qwen3-8B')
 *  @example model('deepseek-ai/DeepSeek-R1', { card: true, cardLength: 3000 }) */
export async function model(id, { card = false, cardLength = 8000 } = {}) {
  const name = String(id).replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/(tree|blob)\/.*$/, '')
  const expand = ['safetensors', 'cardData', 'config', 'downloads', 'downloadsAllTime', 'likes', 'trendingScore', 'lastModified', 'createdAt', 'siblings', 'gated', 'pipeline_tag', 'library_name', 'tags']
  const m = await get(`/api/models/${name}?${expand.map(x => `expand[]=${x}`).join('&')}`)
  const tags = m.tags || []
  const files = (m.siblings || []).map(f => f.rfilename)
  const out = {
    id: m.id,
    task: m.pipeline_tag,
    library: m.library_name,
    params: num(m.safetensors?.total),
    dtype: m.safetensors?.parameters ? Object.keys(m.safetensors.parameters).join(', ') : undefined,
    architecture: m.config?.architectures?.join(', '),
    modelType: m.config?.model_type,
    license: m.cardData?.license || license(tags),
    baseModel: [].concat(m.cardData?.base_model || []).join(', ') || undefined,
    languages: [].concat(m.cardData?.language || []).join(', ') || undefined,
    papers: tags.filter(t => t.startsWith('arxiv:')).map(t => t.slice(6)).join(', ') || undefined,
    gated: m.gated || undefined,
    downloads: m.downloads,
    downloadsAllTime: m.downloadsAllTime,
    likes: m.likes,
    trending: m.trendingScore,
    created: day(m.createdAt),
    updated: day(m.lastModified),
    files: files.length > 30 ? [...files.slice(0, 30), `… 共 ${files.length} 个文件`] : files,
    tags: tags.filter(t => !/^(arxiv|license|base_model|region|deploy|endpoints_compatible):?/.test(t)).join(', '),
    url: `${HF}/${m.id}`,
  }
  if (card) {
    const md = await get(`/${m.id}/raw/main/README.md`, { text: true }).catch(() => '')
    const body = md.replace(/^---[\s\S]*?\n---\n/, '').trim()
    out.card = body.length > cardLength ? body.slice(0, cardLength) + `\n…（共 ${body.length} 字，调大 cardLength 看全部）` : body
  }
  return out
}

/** 搜数据集 / 数据集排行。sort：downloads / likes / trending / created / updated
 *  @example datasets('math reasoning', { limit: 10 })
 *  @example datasets('', { sort: 'trending', limit: 20 }) */
export async function datasets(q = '', { author = '', sort = 'trending', limit = 20 } = {}) {
  const list = await get('/api/datasets' + query({ q, sort, limit, author }))
  if (!list.length) throw new BxError('EMPTY', `没找到数据集 ${q || ''}`)
  return list.map((d, i) => ({
    rank: i + 1,
    id: d.id,
    downloads: d.downloads,
    likes: d.likes,
    trending: d.trendingScore,
    tasks: d.tags?.filter(t => t.startsWith('task_categories:')).map(t => t.slice(16)).join(', ') || undefined,
    size: d.tags?.find(t => t.startsWith('size_categories:'))?.slice(16),
    license: license(d.tags),
    description: d.description ? d.description.replace(/\s+/g, ' ').slice(0, 200) : undefined,
    updated: day(d.lastModified),
    url: `${HF}/datasets/${d.id}`,
  }))
}

/** 搜 Space（在线 demo 应用）/ Space 排行。sdk 筛选：gradio / streamlit / docker / static
 *  @example spaces('tts', { limit: 10 })
 *  @example spaces('', { sort: 'trending', limit: 20 }) */
export async function spaces(q = '', { author = '', sdk = '', sort = 'trending', limit = 20 } = {}) {
  const list = await get('/api/spaces' + query({ q, sort, limit, author, extra: sdk ? `&sdk=${sdk}` : '' }))
  if (!list.length) throw new BxError('EMPTY', `没找到 Space ${q || ''}`)
  return list.map((s, i) => ({
    rank: i + 1,
    id: s.id,
    title: s.cardData?.title,
    description: s.cardData?.short_description,
    sdk: s.sdk,
    likes: s.likes,
    trending: s.trendingScore,
    hardware: s.runtime?.hardware?.current || undefined,
    status: s.runtime?.stage,
    updated: day(s.lastModified),
    url: `${HF}/spaces/${s.id}`,
  }))
}

function paperRow(p, extra = {}) {
  const authors = (p.authors || []).map(a => a.name)
  return {
    ...extra,
    id: p.id,
    title: p.title?.replace(/\s+/g, ' ').trim(),
    upvotes: p.upvotes,
    authors: authors.length > 4 ? authors.slice(0, 4).join(', ') + ` 等 ${authors.length} 人` : authors.join(', '),
    published: day(p.publishedAt),
    summary: p.ai_summary || undefined,
    url: `${HF}/papers/${p.id}`,
    arxiv: `https://arxiv.org/abs/${p.id}`,
  }
}

/** HF 热门论文（Daily Papers，社区每天投票选出来的）。period：daily 某一天（date 不写就是最新一天）/ weekly 本周 / monthly 本月
 *  @example top({ limit: 20 })
 *  @example top({ period: 'weekly', limit: 30 })
 *  @example top({ date: '2025-06-03' }) */
export async function top({ period = 'daily', date = '', limit = 30 } = {}) {
  let list
  if (period === 'weekly' || period === 'monthly') {
    list = (await get(`/api/papers?period=${period}`)).map(p => ({ ...p, upvotes: p.upvotes }))
  } else if (period === 'daily') {
    const j = await get(`/api/daily_papers?limit=100${date ? `&date=${date}` : ''}`)
    list = j.map(x => ({ ...x.paper, title: x.title || x.paper?.title, numComments: x.numComments }))
  } else throw new BxError('BAD_ARGS', 'period 只能是 daily / weekly / monthly')
  if (!list.length) throw new BxError('EMPTY', `${date || period} 没有热门论文`, '周末和节假日常常没有，换个日期')
  return list.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0)).slice(0, limit).map((p, i) => paperRow(p, { rank: i + 1, comments: p.numComments }))
}

/** 搜 HF 收录的论文（语义搜索，结果带 AI 一句话总结）
 *  @example papers('speculative decoding', { limit: 10 }) */
export async function papers(q, { limit = 20 } = {}) {
  const j = await get(`/api/papers/search?q=${encodeURIComponent(q)}`)
  if (!j.length) throw new BxError('EMPTY', `没搜到论文 ${q}`)
  return j.slice(0, limit).map((x, i) => paperRow({ ...x.paper, title: x.title || x.paper?.title }, { rank: i + 1 }))
}

/** 单篇论文在 HF 上的信息：摘要、AI 总结和关键词、点赞数、关联了多少模型 / 数据集 / Space。id 是 arXiv 编号
 *  @example paper('2501.12948') */
export async function paper(id) {
  const p = await get(`/api/papers/${String(id).replace(/^.*\/(papers|abs)\//, '').replace(/v\d+$/, '')}`)
  return {
    ...paperRow(p),
    authors: (p.authors || []).map(a => a.name).join(', '),
    keywords: p.ai_keywords?.join(', ') || undefined,
    abstract: p.summary?.replace(/\s+/g, ' ').trim(),
    models: p.numTotalModels,
    datasets: p.numTotalDatasets,
    spaces: p.numTotalSpaces,
  }
}
