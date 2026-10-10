/* 站点笔记（Internet Archive / Wayback Machine 网页时光机）：
 * - 公开接口，不用登录。两部分：
 *   1. 网页快照（Wayback）：看一个网页过去长什么样，比如产品改价前的定价页、被删掉的文章、公司官网的历史版本
 *      最接近某个时间的快照 archive.org/wayback/available?url=&timestamp=YYYYMMDD（这个在 archive.org 主站上）
 *      快照历史 web.archive.org/cdx/search/cdx?url=&output=json&from=&to=&limit=&collapse=timestamp:8（按天去重；6 按月、4 按年）
 *        limit 是负数时取最新的 N 条；filter=statuscode:200 只要成功抓到的
 *      快照原文 web.archive.org/web/<时间戳>id_/<网址>（加 id_ 去掉 Wayback 的工具栏，拿原始 HTML）
 *   2. 馆藏（书、影音、软件、数据集）：搜索 archive.org/advancedsearch.php；单项 archive.org/metadata/<identifier>
 * - 坑：web.archive.org 在国内经常连不上（连接被重置），archive.org 主站一般能连。连不上时报 BLOCKED。
 *   wayback/available 请求太快会 429
 * - 看快照内容：拿到 snapshot 网址后用 bx read <网址>
 */

const UA = 'BrowserX/1.0 (https://github.com/rango886/BrowserX)'

async function get(url, { json = true } = {}) {
  let r
  for (let i = 0; i < 2; i++) {
    r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(45000) }).catch(e => e)
    if (r instanceof Error) {
      const host = new URL(url).host
      if (i === 0) continue
      throw new BxError('BLOCKED', `连不上 ${host}（${r.cause?.code || r.message}）`, host === 'web.archive.org' ? 'web.archive.org 在国内经常被重置连接，换个网络或代理节点再试' : '检查网络后再试')
    }
    if (r.status === 429 && i === 0) {
      await bx.sleep(5000)
      continue
    }
    break
  }
  if (r.status === 429) throw new BxError('BLOCKED', 'Internet Archive 限流了', '等半分钟再试')
  if (r.status === 404) return null
  if (!r.ok) throw new BxError('HTTP_ERROR', `Internet Archive 返回 ${r.status}：${url}`)
  return json ? r.json() : r.text()
}

const ts = s => {
  const d = String(s || '').replace(/[^\d]/g, '')
  if (s && !/^\d{4,14}$/.test(d)) throw new BxError('BAD_ARGS', `时间格式不对：${s}`, '写 2023、202301、20230115 或 2023-01-15')
  return d
}
const pretty = t => `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`

/** 某个网页最接近指定时间的快照（不写 time 就是最新一次）。返回快照网址，再用 bx read 看内容
 *  @example wayback('openai.com/pricing', { time: '2023-06-01' })
 *  @example wayback('https://example.com') */
export async function wayback(url, { time = '' } = {}) {
  const t = ts(time)
  const j = await get(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}${t ? `&timestamp=${t}` : ''}`)
  const s = j?.archived_snapshots?.closest
  if (!s?.available) throw new BxError('EMPTY', `Wayback 没有 ${url} 的快照`, '换个写法（带不带 www、末尾斜杠），或者用 snapshots 看全部历史')
  return { url: s.url.replace(/^http:/, 'https:'), time: pretty(s.timestamp), timestamp: s.timestamp, status: s.status, original: url }
}

const COLLAPSE = { all: 0, hour: 10, day: 8, month: 6, year: 4 }

/** 一个网页的快照历史（时间、状态码、内容是否变化）。from / to 限定时间；every 去重粒度：all / hour / day / month / year；
 *  latest: true 取最新的 limit 条（默认从最早开始）；changed: true 只保留内容有变化的快照
 *  @example snapshots('openai.com/pricing', { every: 'month', latest: true, limit: 24 })
 *  @example snapshots('news.ycombinator.com', { from: '2010', to: '2011', every: 'month' }) */
export async function snapshots(url, { from = '', to = '', every = 'day', latest = false, changed = false, ok = true, limit = 50 } = {}) {
  if (!(every in COLLAPSE)) throw new BxError('BAD_ARGS', `every 只能是 ${Object.keys(COLLAPSE).join(' / ')}`)
  let q = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,original,statuscode,mimetype,digest,length`
  if (from) q += `&from=${ts(from)}`
  if (to) q += `&to=${ts(to)}`
  if (COLLAPSE[every]) q += `&collapse=timestamp:${COLLAPSE[every]}`
  if (changed) q += '&collapse=digest'
  if (ok) q += '&filter=statuscode:200'
  q += `&limit=${latest ? -Math.min(limit, 10000) : Math.min(limit, 10000)}`
  const rows = await get(q)
  if (!rows || rows.length < 2) throw new BxError('EMPTY', `Wayback 没有 ${url} 的快照`, '放宽时间范围，或者 ok: false 把失败的抓取也算上')
  const [head, ...data] = rows
  const c = Object.fromEntries(head.map((h, i) => [h, i]))
  const list = data.map(r => ({
    time: pretty(r[c.timestamp]),
    status: r[c.statuscode],
    type: r[c.mimetype],
    size: Number(r[c.length]) || undefined,
    digest: r[c.digest],
    url: `https://web.archive.org/web/${r[c.timestamp]}/${r[c.original]}`,
  }))
  return latest ? list.reverse() : list
}

/** 某个快照的原始网页文字（去掉 Wayback 工具栏，HTML 转成纯文本）。snapshot 是 snapshots / wayback 返回的网址
 *  @example text('https://web.archive.org/web/20230601000000/https://openai.com/pricing', { maxLength: 5000 }) */
export async function text(snapshot, { maxLength = 20000 } = {}) {
  const m = String(snapshot).match(/web\.archive\.org\/web\/(\d+)[a-z_]*\/(.+)$/)
  if (!m) throw new BxError('BAD_ARGS', `不是快照网址：${snapshot}`, '格式是 https://web.archive.org/web/<时间戳>/<网址>')
  const html = await get(`https://web.archive.org/web/${m[1]}id_/${m[2]}`, { json: false })
  if (!html) throw new BxError('NOT_FOUND', '快照不存在')
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
  let body = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()
  if (body.length > maxLength) body = body.slice(0, maxLength) + '…'
  return { title, time: pretty(m[1]), url: snapshot, content: body }
}

const MEDIA = ['texts', 'movies', 'audio', 'software', 'image', 'web', 'data', 'collection']
const SORTS = { downloads: 'downloads', date: 'date', added: 'addeddate', week: 'week', title: 'titleSorter' }
// 多个词又没写语法时当成短语搜，否则按下载量排序会把只沾一个词的热门条目排到前面
const phrase = q => (/\s/.test(q) && !/["():]|\b(AND|OR|NOT)\b/.test(q) ? `"${q}"` : q)
const join = v => (Array.isArray(v) ? v.join(', ') : v || undefined)

/** 搜馆藏（书、论文、影音、软件、数据集）。type：texts movies audio software image data collection；
 *  sort：downloads 下载量 / date 出版时间 / added 收录时间 / week 本周热度
 *  @example search('machine learning', { type: 'texts', limit: 10 }) */
export async function search(q, { type = '', sort = 'downloads', limit = 20 } = {}) {
  if (type && !MEDIA.includes(type)) throw new BxError('BAD_ARGS', `type 只能是 ${MEDIA.join(' / ')}`)
  if (!SORTS[sort]) throw new BxError('BAD_ARGS', `sort 只能是 ${Object.keys(SORTS).join(' / ')}`)
  const fl = ['identifier', 'title', 'creator', 'date', 'mediatype', 'downloads', 'description'].map(f => `fl[]=${f}`).join('&')
  const j = await get(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(type ? `(${phrase(q)}) AND mediatype:${type}` : phrase(q))}&${fl}&rows=${Math.min(limit, 100)}&sort[]=${encodeURIComponent(SORTS[sort] + ' desc')}&output=json`)
  const docs = j?.response?.docs || []
  if (!docs.length) throw new BxError('EMPTY', `Internet Archive 没搜到 ${q}`)
  return docs.map((d, i) => ({
    rank: i + 1,
    id: d.identifier,
    title: join(d.title),
    creator: join(d.creator),
    date: String(d.date || '').slice(0, 10) || undefined,
    type: d.mediatype,
    downloads: d.downloads,
    description: d.description ? String(join(d.description)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 200) : undefined,
    url: `https://archive.org/details/${d.identifier}`,
  }))
}

/** 馆藏单项详情：标题、作者、日期、简介、所属合集、文件列表（带下载链接）
 *  @example item('TheStoryOfCivilizationcomplete') */
export async function item(id, { files = 30 } = {}) {
  const ident = String(id).replace(/^.*archive\.org\/details\//, '').split(/[/?#]/)[0]
  const j = await get(`https://archive.org/metadata/${encodeURIComponent(ident)}`)
  const m = j?.metadata
  if (!m?.identifier) throw new BxError('NOT_FOUND', `Internet Archive 没有 ${id}`)
  const fs = (j.files || []).filter(f => f.source === 'original' || /\.(pdf|epub|txt|mp4|mp3|zip|json|csv)$/i.test(f.name))
  return {
    id: m.identifier,
    title: join(m.title),
    creator: join(m.creator),
    date: m.date,
    type: m.mediatype,
    collection: join(m.collection),
    subject: join(m.subject),
    description: m.description ? String(join(m.description)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 2000) : undefined,
    downloads: j.item?.downloads,
    files: fs.slice(0, files).map(f => ({ name: f.name, format: f.format, size: Number(f.size) || undefined, url: `https://archive.org/download/${m.identifier}/${encodeURIComponent(f.name)}` })),
    url: `https://archive.org/details/${m.identifier}`,
  }
}
