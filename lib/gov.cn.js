/* 站点笔记（中国政府网 www.gov.cn：国务院和各部委的政策文件）：
 * - 都是公开数据，不用登录、不用浏览器
 * - 列表页的数据是静态 JSON（页面再用 JS 分页渲染），全量一次给，按发布日期倒序：
 *   最新政策 /zhengce/zuixin/ZUIXINZHENGCE.json（国务院、国办文件 + 重要政策稿件，1000 多条）
 *   国务院文件 /zhengce/zhengceku/gwywj/TONGYONGGAILAN.json，部门文件 /zhengce/zhengceku/bmwj/TONGYONGGAILAN.json
 *   政策解读 /zhengce/jiedu/ZCJD_QZ.json。每条 { TITLE, SUB_TITLE, URL, DOCRELPUBTIME }
 * - 搜索 sousuo.www.gov.cn 的结果是 JS 调接口渲染的（直接抓 HTML 只有空壳）：
 *   POST sousuoht.www.gov.cn/athena/forward/2B22E8E39E850E17F95A016A74FCB6B673336FA8B6FEC0E2955907EF9AEE06BE
 *   请求头 athenaAppKey = encodeURIComponent(RSA 公钥加密固定串 a46884b2013e4d189f2a8e2d49a23525，PKCS1 填充，base64)，
 *   athenaAppName = encodeURIComponent('国网搜索')；公钥和固定串都写在 sousuo.www.gov.cn/sousuo/search.js 里，改版了去那里找
 *   body：code 17da70961a7、dataTypeId（107 全部 / 14 国务院文件 / 15 国务院公报）、searchWord、searchBy（all 全文 / title 标题）、
 *   orderBy（related / time）、granularity（ALL / LAST_YEAR / LAST_MONTH / LAST_WEEK）、pageNo、pageSize
 *   → result.data.middle.list：title_no_tag url time summary（带 <em>）label documentType agencies pubcode（发文字号）
 * - 文件页正文在 #UCAP-CONTENT 里（电脑版、手机版各一份，取第一份）；政策库页面（/zhengce/zhengceku/、/zhengce/content/）
 *   顶上有一张表：发文机关、发文字号、主题分类、成文日期。附件是正文里的 <a href="./P0….pdf">
 */
import { publicEncrypt, constants } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const SEARCH = 'https://sousuoht.www.gov.cn/athena/forward/2B22E8E39E850E17F95A016A74FCB6B673336FA8B6FEC0E2955907EF9AEE06BE'
const PUB = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCSMhMJQ+XLI7oW0k9Bwufur4Ag40tcsrzT7WZf6Ao0O/hyY1gZtCSYFxkxIZUXjW46j27XSW8IDX1rTJoHaMxHCWsOpTi2W5stybGYZytsY5on8gd8AIaS1d52h9eaS2TFydtJJtE50xHmT0WmoyoinWCuVCOkdCLhh9b9jSdeSQIDAQAB'

async function get(url, { json = false, init = {} } = {}) {
  let r
  try {
    r = await fetch(url, { ...init, headers: { 'user-agent': UA, ...init.headers }, signal: AbortSignal.timeout(30000) })
  } catch (e) {
    throw new BxError('NETWORK', `连不上中国政府网（${e?.cause?.code || e.message}）`, '检查网络后再试')
  }
  if (r.status === 404) throw new BxError('NOT_FOUND', `中国政府网上没有这个页面：${url}`)
  if (!r.ok) throw new BxError('HTTP_ERROR', `中国政府网返回 ${r.status}`)
  return json ? r.json() : r.text()
}

const strip = s => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/[\s\u3000]+/g, ' ').trim()

const LISTS = {
  latest: '/zhengce/zuixin/ZUIXINZHENGCE.json',
  state: '/zhengce/zhengceku/gwywj/TONGYONGGAILAN.json',
  dept: '/zhengce/zhengceku/bmwj/TONGYONGGAILAN.json',
  jiedu: '/zhengce/jiedu/ZCJD_QZ.json',
}

/** 最新发布的政策文件（按发布日期倒序）。list：latest 最新政策（默认，国务院 / 国办文件 + 重要政策稿件）/ state 国务院文件 /
 *  dept 国务院部门文件 / jiedu 政策解读。since 只要这天以后的（'2026-09-01'），q 标题里要有这个词
 *  @example recent({ limit: 20 })
 *  @example recent({ list: 'dept', limit: 30 })
 *  @example recent({ list: 'state', q: '消费', limit: 10 }) */
export async function recent({ list = 'latest', since = '', q = '', limit = 20 } = {}) {
  const path = LISTS[list]
  if (!path) throw new BxError('BAD_ARGS', `list 只能是 ${Object.keys(LISTS).join(' / ')}`)
  const j = await get('https://www.gov.cn' + path, { json: true })
  if (!Array.isArray(j)) throw new BxError('CHANGED', '政策列表 JSON 的结构变了', '去修 recent')
  const out = j
    .map(x => ({ title: strip(x.TITLE), subtitle: strip(x.SUB_TITLE) || undefined, date: x.DOCRELPUBTIME, url: x.URL }))
    .filter(x => x.title && (!since || x.date >= since) && (!q || x.title.includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date))
  if (!out.length) throw new BxError('EMPTY', '没有符合条件的政策文件', '放宽 since / q')
  return out.slice(0, limit).map((x, i) => ({ rank: i + 1, ...x }))
}

const TYPES = { all: '107', state: '14', gazette: '15' }
const RANGES = { all: 'ALL', year: 'LAST_YEAR', month: 'LAST_MONTH', week: 'LAST_WEEK' }

/** 搜政策文件（国务院文件、部门文件、公报、政策解读和要闻）。type：all 全部（默认）/ state 国务院文件 / gazette 国务院公报；
 *  by：all 全文（默认）/ title 只搜标题；sort：related 相关度（默认）/ time 最新；time：all / year / month / week
 *  @example search('新质生产力', { limit: 10 })
 *  @example search('人工智能', { type: 'state', sort: 'time', time: 'year', limit: 20 })
 *  @example search('数据要素', { by: 'title', type: 'gazette' }) */
export async function search(q, { type = 'all', by = 'all', sort = 'related', time = 'all', limit = 20 } = {}) {
  if (!String(q || '').trim()) throw new BxError('BAD_ARGS', '要给搜索关键词')
  if (!TYPES[type]) throw new BxError('BAD_ARGS', `type 只能是 ${Object.keys(TYPES).join(' / ')}`)
  if (!RANGES[time]) throw new BxError('BAD_ARGS', `time 只能是 ${Object.keys(RANGES).join(' / ')}`)
  const key = encodeURIComponent(publicEncrypt({ key: `-----BEGIN PUBLIC KEY-----\n${PUB}\n-----END PUBLIC KEY-----`, padding: constants.RSA_PKCS1_PADDING }, Buffer.from('a46884b2013e4d189f2a8e2d49a23525')).toString('base64'))
  const headers = { 'content-type': 'application/json;charset=utf-8', athenaAppKey: key, athenaAppName: encodeURIComponent('国网搜索'), origin: 'https://sousuo.www.gov.cn', referer: 'https://sousuo.www.gov.cn/' }
  const out = []
  let total = 0
  for (let page = 1; out.length < limit && page <= 10; page++) {
    const body = { code: '17da70961a7', historySearchWords: [], dataTypeId: TYPES[type], orderBy: sort === 'time' ? 'time' : 'related', searchBy: by === 'title' ? 'title' : 'all', appendixType: '', granularity: RANGES[time], trackTotalHits: true, beginDateTime: '', endDateTime: '', isSearchForced: 0, filters: [], pageNo: page, pageSize: 20, customFilter: { operator: 'and', properties: [] }, searchWord: String(q).trim() }
    const j = await get(SEARCH, { json: true, init: { method: 'POST', headers, body: JSON.stringify(body) } })
    if (j?.resultCode?.code !== 200) throw new BxError('CHANGED', `政府网搜索接口返回 ${JSON.stringify(j?.resultCode)}`, '加密参数可能换了，看站点笔记去 search.js 里找')
    const d = j.result?.data
    total = d?.pager?.total || 0
    const list = d?.middle?.list || []
    for (const x of list) {
      const agencies = Array.isArray(x.agencies) ? x.agencies.join('，') : x.agencies
      out.push({
        title: strip(x.title_no_tag || x.title),
        date: x.time?.slice(0, 10),
        label: x.label || undefined,
        agency: agencies || undefined,
        docNo: x.pubcode || undefined,
        docType: x.documentType || undefined,
        summary: strip(x.summary || x.content).slice(0, 200),
        url: x.url?.replace(/^http:/, 'https:'),
      })
    }
    if (list.length < 20 || page >= (d?.pager?.pageCount || 0)) break
  }
  if (!out.length) throw new BxError('EMPTY', `政府网没搜到 ${q}`, '换个词，或者 time 放宽、by 改成 all')
  return out.slice(0, limit).map((x, i) => ({ rank: i + 1, total, ...x }))
}

/** 政策文件全文：标题、发文机关、发文字号、成文 / 发布日期、正文、附件（PDF 等）链接
 *  @example article('https://www.gov.cn/zhengce/zhengceku/202609/content_7080773.htm')
 *  @example article('https://www.gov.cn/zhengce/202610/content_7082820.htm') */
export async function article(url) {
  const u = String(url).trim().replace(/^http:/, 'https:')
  if (!/^https:\/\/([\w-]+\.)*gov\.cn\//.test(u)) throw new BxError('BAD_ARGS', '要给 gov.cn 的文件网址')
  const html = await get(u)
  const meta = n => html.match(new RegExp(`<meta name="${n}" content="([^"]*)"`))?.[1]?.trim()
  const info = {}
  const table = html.match(/policyLibraryOverview_header[\s\S]*?<\/table>/)?.[0] || ''
  const cells = [...table.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => strip(m[1]))
  for (let i = 0; i + 1 < cells.length; i += 2) info[cells[i].replace(/[\s：:]/g, '')] = cells[i + 1]
  const start = html.indexOf('id="UCAP-CONTENT"')
  if (start < 0) throw new BxError('CHANGED', '这个页面没有 #UCAP-CONTENT 正文', '不是文件页的话用 bx read')
  let body = html.slice(html.indexOf('>', start) + 1)
  const end = body.search(/<div class="pages_content|<div class="(?:editor|pages-date|mxxgk|shuzi|share)|<!--\s*(?:分享|附件|责任编辑)/)
  if (end > 0) body = body.slice(0, end)
  const attachments = [...body.matchAll(/<a[^>]+href="([^"]+\.(?:pdf|docx?|xlsx?|wps|ofd|zip|rar))"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ name: strip(m[2]) || m[1].split('/').pop(), url: new URL(m[1], u).href }))
  const content = body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”').replace(/&amp;/g, '&')
    .split('\n').map(s => s.replace(/[ \t\u3000]+/g, ' ').trim()).filter(Boolean).join('\n')
  const title = info['标题'] || strip(html.match(/<title>([\s\S]*?)<\/title>/)?.[1]).split('_')[0]
  return {
    title,
    agency: info['发文机关'] || undefined,
    docNo: info['发文字号'] || undefined,
    category: info['主题分类'] || undefined,
    docType: info['公文种类'] || undefined,
    written: info['成文日期'] || undefined,
    published: meta('firstpublishedtime')?.replace(/^(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2}).*/, '$1 $2'),
    column: meta('lanmu') || undefined,
    source: info['来源'] || strip(html.match(/来源[：:]\s*(?:<[^>]+>)*\s*([^<]+)/)?.[1]) || undefined,
    attachments: attachments.length ? attachments : undefined,
    url: u,
    content,
  }
}

/** 政府网文件页的读法：带上发文机关、字号、附件 */
export async function read(tab) {
  const u = await tab.url()
  if (!/gov\.cn\/.+content_\d+\.html?/.test(u)) return null
  const a = await article(u).catch(() => null)
  if (!a?.content) return null
  const head = [a.agency && `发文机关：${a.agency}`, a.docNo && `发文字号：${a.docNo}`, a.written && `成文日期：${a.written}`, a.category && `主题分类：${a.category}`].filter(Boolean).join('\n')
  const att = a.attachments?.map(x => `- [${x.name}](${x.url})`).join('\n')
  return { title: a.title, type: 'article', meta: { author: a.agency || a.source, published: a.published, site: `中国政府网 · ${a.column || ''}` }, content: [head, a.content, att && `附件：\n${att}`].filter(Boolean).join('\n\n') }
}
