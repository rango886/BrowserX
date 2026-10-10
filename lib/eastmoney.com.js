/* 站点笔记（东方财富）：
 * @login none 全是公开接口，Node 里直接 fetch，不用开标签
 * - 定位：补雪球没有的东西（7x24 快讯、公告、龙虎榜、资金流、南北向、板块、十大股东、涨跌排行）。行情、K 线、财务用 xueqiu.com
 * - 股票代码：600519 / SH600519 / 600519.SH 都行。接口里的 secid = 市场.代码，1 = 上交所，0 = 深交所 / 北交所；板块是 90.BKxxxx
 * - 金额单位都是“元”；只有 northbound() 是“亿元”（接口原始单位是百万元）
 * - 接口：
 *     7x24 快讯 np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&pageSize=&sortEnd=（翻页传上一页返回的 sortEnd）
 *     公告列表 np-anotice-stock.eastmoney.com/api/security/ann?ann_type=A&stock_list=600519&f_node=分类&page_size=&page_index=
 *       f_node：1 财务报告 2 融资公告 3 风险提示 4 信息变更 5 重大事项 6 资产重组 7 持股变动；不传 stock_list 就是全市场
 *     公告正文 np-cnotice-stock.eastmoney.com/api/content/ann?art_code=AN…&page_index=（notice_content 是纯文本，长公告有多页 page_size）
 *     数据中心 datacenter-web.eastmoney.com/api/data/v1/get?reportName=…&columns=ALL&filter=(字段='值')&sortColumns=&sortTypes=-1
 *       龙虎榜 RPT_DAILYBILLBOARD_DETAILSNEW；营业部买入 / 卖出 RPT_BILLBOARD_DAILYDETAILSBUY / …SELL
 *       南北向 RPT_MUTUAL_DEAL_HISTORY（MUTUAL_TYPE 001 沪股通 003 深股通 005 北向合计 002/004/006 港股通沪/深/合计）
 *       北向十大成交股 RPT_MUTUAL_TOP10DEAL
 *     行情列表 push2.eastmoney.com/api/qt/clist/get?fs=范围&fid=排序字段&po=1 降序 / 0 升序&pz=每页（最多 100）&pn=页&fltt=2&fields=
 *       f2 价 f3 涨幅% f4 涨跌 f5 成交量(手) f6 成交额 f7 振幅% f8 换手% f9 市盈率(动) f10 量比 f12 代码 f14 名称 f15 高 f16 低 f17 开 f18 昨收 f20 总市值 f21 流通市值 f23 市净率
 *       资金流 f62 主力净流入 f184 主力净占比 f66/f69 超大单 f72/f75 大单 f78/f81 中单 f84/f87 小单（净额 / 占比）
 *       板块 f104 上涨家数 f105 下跌家数 f128 领涨股 f140 领涨股代码 f136 领涨股涨幅
 *       fs：沪深京 A 股 m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048；行业板块 m:90+t:2；概念 m:90+t:3；地域 m:90+t:1；板块成分 b:BK0477
 *     个股日资金流 push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=&lmt=天数&klt=101&fields2=f51…f63
 *     股东 emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=SH600519（sdgd 十大股东 sdltgd 十大流通 gdrs 股东户数）
 *     代码联想 searchapi.eastmoney.com/api/suggest/get?input=&type=14&token=D43BF722C8E33BDC906FB84D85E326E8
 *     人气榜 POST emappdata.eastmoney.com/stockrank/getAllCurrentList {appId:'appId01',globalId,pageNo,pageSize}（只给代码，再用
 *       push2.eastmoney.com/api/qt/ulist.np/get?secids=1.600519,0.000001&fields= 批量取行情）
 *     ETF b:MK0021  可转债 b:MK0354（clist 的 fs）
 * - 北向资金：2024-08 起交易所不再公布北向实时 / 每日净买入，NET_DEAL_AMT 是 null，只剩成交额、领涨股、十大成交股
 * - 坑：push2.eastmoney.com 主域名短时间请求太多会封 IP（TLS 直接断开，浏览器里也连不上），但 1~99.push2.eastmoney.com 这些分流域名不受影响。
 *   get() 里每次随机挑一个分流域名，连不上就换。push2his 没遇到过这个问题
 */

const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', Referer: 'https://data.eastmoney.com/' }

async function get(url) {
  let r
  for (let i = 0; ; i++) {
    // push2 主域名请求多了会封 IP（连接直接断掉），网页自己也是随机用 1~99.push2.eastmoney.com 分流，这里一样做，连不上就换一个
    const u = url.replace(/^https:\/\/(\d+\.)?push2\.eastmoney\.com/, () => `https://${1 + Math.floor(Math.random() * 99)}.push2.eastmoney.com`)
    try {
      r = await fetch(u, { headers: H })
      break
    } catch (e) {
      if (i < 3) {
        await bx.sleep(500 * (i + 1))
        continue
      }
      throw new BxError('BLOCKED', `东方财富接口连不上（${e.cause?.code || e.message}），多半是请求太多被临时封了 IP`, /clist/.test(url) ? '过几分钟再试；急用的话涨跌排行换 sina.com.cn rank，热门板块换 10jqka.com.cn hotBoards / tdx.com.cn boards' : '过几分钟再试')
    }
  }
  if (!r.ok) throw new BxError(r.status === 403 || r.status === 429 ? 'BLOCKED' : 'HTTP_ERROR', `东方财富接口 HTTP ${r.status}`, '停一会儿再试')
  const t = await r.text()
  try {
    return JSON.parse(t.replace(/^[\w$]+\((.*)\);?$/s, '$1'))
  } catch {
    throw new BxError('CHANGED', '东方财富接口返回的不是 JSON', url)
  }
}

/** 600519 / SH600519 / 600519.SH → { code, mkt: 'SH'|'SZ'|'BJ', secid } */
function sym(s) {
  s = String(s).trim().toUpperCase()
  let m = s.match(/^(SH|SZ|BJ)?(\d{6})(?:\.(SH|SZ|BJ))?$/)
  if (!m) throw new BxError('BAD_ARGS', `看不懂的 A 股代码：${s}`, '写 6 位代码，比如 600519；不知道代码先 search')
  const code = m[2]
  const mkt = m[1] || m[3] || (/^[569]/.test(code) ? 'SH' : /^[48]|^92/.test(code) ? 'BJ' : 'SZ')
  return { code, mkt, secid: `${mkt === 'SH' ? 1 : 0}.${code}` }
}

const day = s => (s ? String(s).slice(0, 10) : undefined)
const quoteUrl = (code, mkt) => `https://quote.eastmoney.com/${(mkt || sym(code).mkt).toLowerCase()}${code}.html`

async function dc(report, { filter = '', sort = '', order = '-1', size = 50, page = 1 } = {}) {
  const u = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=${report}&columns=ALL&source=WEB&client=WEB&pageSize=${size}&pageNumber=${page}` + (sort ? `&sortColumns=${sort}&sortTypes=${order}` : '') + (filter ? `&filter=${encodeURIComponent(filter)}` : '')
  const j = await get(u)
  if (j.success === false && !/数据/.test(j.message || '')) throw new BxError('CHANGED', `数据中心 ${report} 出错：${j.message}`)
  return j.result?.data || []
}

/** clist 行情列表，自动翻页（每页最多 100） */
async function clist(fs, fields, { fid = 'f3', desc = true, limit = 50 } = {}) {
  const out = []
  for (let pn = 1; out.length < limit && pn <= 60; pn++) {
    const j = await get(`https://push2.eastmoney.com/api/qt/clist/get?fid=${fid}&po=${desc ? 1 : 0}&pz=100&pn=${pn}&np=1&fltt=2&invt=2&fs=${fs}&fields=${fields}`)
    const d = j.data?.diff || []
    out.push(...d)
    if (d.length < 100) break
    await bx.sleep(600) // 翻页太快容易被封
  }
  return out.slice(0, limit)
}
const num = v => (v === '-' || v == null ? undefined : v)

const A_SHARES = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'
const MARKETS = { all: A_SHARES, sh: 'm:1+t:2,m:1+t:23', sz: 'm:0+t:6,m:0+t:80', bj: 'm:0+t:81+s:2048', cyb: 'm:0+t:80', kcb: 'm:1+t:23', etf: 'b:MK0021', bond: 'b:MK0354' }
const BOARDS = { industry: 'm:90+t:2', concept: 'm:90+t:3', region: 'm:90+t:1' }

/** 按名字 / 拼音 / 代码找股票（A 股、港股、美股、基金、板块都能找到）
 *  @example search('茅台') */
export async function search(q, { limit = 10 } = {}) {
  const j = await get(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=${limit}`)
  const d = j.QuotationCodeTable?.Data || []
  if (!d.length) throw new BxError('EMPTY', `东方财富没有找到 ${q}`, '换个名字或代码')
  return d.map(x => ({ code: x.Code, name: x.Name, type: x.SecurityTypeName, secid: x.QuoteID, url: `https://quote.eastmoney.com/unify/r/${x.QuoteID}` }))
}

/** 7x24 快讯（最新在前）。q 只保留标题 / 正文含关键词的
 *  @example news({ limit: 50 })
 *  @example news({ q: '央行', limit: 20 }) */
export async function news({ limit = 50, q = '' } = {}) {
  const out = []
  let sortEnd = ''
  const re = q ? new RegExp(q.replace(/[.*+?^${}()[\]\\]/g, '\\$&').split(/\s+/).join('|'), 'i') : null
  for (let i = 0; out.length < limit && i < (re ? 40 : 20); i++) {
    const j = await get(`https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=${sortEnd}&pageSize=50&req_trace=${Date.now()}`)
    const list = j.data?.fastNewsList
    if (!Array.isArray(list)) throw new BxError('CHANGED', '快讯接口的返回结构变了', '去修 news')
    for (const x of list) {
      if (re && !re.test(x.title + x.summary)) continue
      out.push({ time: x.showTime, title: x.title, text: x.summary, stocks: x.stockList?.length ? x.stockList.join(',') : undefined, comments: x.pinglun_Num, url: `https://finance.eastmoney.com/a/${x.code}.html` })
    }
    if (!list.length || !j.data.sortEnd) break
    sortEnd = j.data.sortEnd
  }
  if (!out.length) throw new BxError('EMPTY', q ? `最近的快讯里没有 ${q}` : '没有快讯', '换个关键词')
  return out.slice(0, limit)
}

const NOTICE_TYPE = { all: 0, finance: 1, financing: 2, risk: 3, change: 4, major: 5, restructure: 6, holding: 7 }

/** 公告列表。不传代码就是全市场最新公告。type：all finance 财务报告 financing 融资 risk 风险提示 change 信息变更 major 重大事项 restructure 资产重组 holding 持股变动
 *  @example notices('600519', { limit: 20 })
 *  @example notices('', { type: 'holding', limit: 30 }) */
export async function notices(symbol = '', { type = 'all', limit = 20 } = {}) {
  const fnode = NOTICE_TYPE[type] ?? (Number(type) || 0)
  const stock = symbol ? `&stock_list=${sym(symbol).code}` : ''
  const out = []
  for (let page = 1; out.length < limit && page <= 20; page++) {
    const j = await get(`https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${Math.min(100, limit)}&page_index=${page}&ann_type=A&client_source=web${stock}&f_node=${fnode}&s_node=0`)
    const list = j.data?.list
    if (!Array.isArray(list)) throw new BxError('CHANGED', '公告接口的返回结构变了', '去修 notices')
    for (const x of list) {
      const c = x.codes?.[0] || {}
      out.push({ date: day(x.notice_date), code: c.stock_code, name: c.short_name, title: x.title, type: x.columns?.map(c => c.column_name).join(','), id: x.art_code, url: `https://data.eastmoney.com/notices/detail/${c.stock_code}/${x.art_code}.html` })
    }
    if (list.length < Math.min(100, limit)) break
  }
  if (!out.length) throw new BxError('EMPTY', '没有公告', '换个代码或类型')
  return out.slice(0, limit)
}

/** 一篇公告的正文（纯文本）和 PDF 链接。参数是公告编号 AN… 或公告网址
 *  @example notice('AN202608141827994407') */
export async function notice(id, { maxChars = 30000 } = {}) {
  const art = String(id).match(/AN\d+/)?.[0]
  if (!art) throw new BxError('BAD_ARGS', '要公告编号 AN… 或公告网址（notices() 结果里的 id / url）')
  let text = ''
  let d
  for (let page = 1; page <= 50; page++) {
    const j = await get(`https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=${art}&client_source=web&page_index=${page}`)
    if (!j.data) throw new BxError('NOT_FOUND', `公告 ${art} 不存在`)
    d ||= j.data
    text += j.data.notice_content || ''
    if (page >= (j.data.page_size || 1) || text.length >= maxChars) break
  }
  const code = d.security?.[0]?.stock || ''
  return {
    title: d.notice_title,
    date: day(d.notice_date),
    name: d.short_name,
    text: text.trim().slice(0, maxChars),
    truncated: text.length > maxChars || undefined,
    pdf: d.attach_url_web || d.attach_url,
    url: `https://data.eastmoney.com/notices/detail/${code}/${art}.html`,
  }
}

/** 龙虎榜（某天上榜的股票）。date 默认最近一个交易日；symbol 只看某只股票的上榜记录
 *  @example billboard({ limit: 30 })
 *  @example billboard({ date: '2026-10-09' })
 *  @example billboard({ symbol: '000011', limit: 10 }) */
export async function billboard({ date = '', symbol = '', limit = 50 } = {}) {
  let filter = ''
  if (symbol) filter = `(SECURITY_CODE="${sym(symbol).code}")`
  else {
    if (!date) date = day((await dc('RPT_DAILYBILLBOARD_DETAILSNEW', { sort: 'TRADE_DATE', size: 1 }))[0]?.TRADE_DATE)
    filter = `(TRADE_DATE='${date}')`
  }
  const rows = []
  for (let page = 1; rows.length < limit && page <= 20; page++) {
    const d = await dc('RPT_DAILYBILLBOARD_DETAILSNEW', { filter, sort: symbol ? 'TRADE_DATE' : 'BILLBOARD_NET_AMT', size: Math.min(500, limit), page })
    rows.push(...d)
    if (d.length < Math.min(500, limit)) break
  }
  if (!rows.length) throw new BxError('EMPTY', `${symbol || date} 没有龙虎榜数据`, '换个日期（非交易日没有）')
  return rows.slice(0, limit).map(x => ({
    date: day(x.TRADE_DATE),
    code: x.SECURITY_CODE,
    name: x.SECURITY_NAME_ABBR,
    close: x.CLOSE_PRICE,
    percent: x.CHANGE_RATE,
    turnover: x.TURNOVERRATE,
    netBuy: x.BILLBOARD_NET_AMT,
    buy: x.BILLBOARD_BUY_AMT,
    sell: x.BILLBOARD_SELL_AMT,
    dealAmount: x.ACCUM_AMOUNT,
    reason: x.EXPLANATION,
    explain: x.EXPLAIN,
    url: `https://data.eastmoney.com/stock/lhb,${day(x.TRADE_DATE)},${x.SECURITY_CODE}.html`,
  }))
}

/** 龙虎榜营业部明细：某只股票某天买入 / 卖出前五的席位（机构、游资、沪深股通）
 *  @example seats('000011', '2026-10-09') */
export async function seats(symbol, date = '') {
  const { code } = sym(symbol)
  if (!date) date = day((await dc('RPT_DAILYBILLBOARD_DETAILSNEW', { filter: `(SECURITY_CODE="${code}")`, sort: 'TRADE_DATE', size: 1 }))[0]?.TRADE_DATE)
  if (!date) throw new BxError('EMPTY', `${code} 没有上过龙虎榜`)
  const filter = `(TRADE_DATE='${date}')(SECURITY_CODE="${code}")`
  const [buy, sell] = await Promise.all([dc('RPT_BILLBOARD_DAILYDETAILSBUY', { filter, sort: 'BUY' }), dc('RPT_BILLBOARD_DAILYDETAILSSELL', { filter, sort: 'SELL' })])
  const row = side => x => ({ side, date, seat: x.OPERATEDEPT_NAME, buy: x.BUY, sell: x.SELL, net: x.NET, reason: x.EXPLANATION })
  const out = [...buy.map(row('买')), ...sell.map(row('卖'))]
  if (!out.length) throw new BxError('EMPTY', `${code} 在 ${date} 没有龙虎榜明细`, '日期要是上榜那天，先 billboard({ symbol }) 看看')
  return out
}

/** 个股每天的资金流向（主力 = 超大单 + 大单），最近 days 个交易日
 *  @example moneyflow('600519', { days: 20 }) */
export async function moneyflow(symbol, { days = 20 } = {}) {
  const { secid } = sym(symbol)
  const j = await get(`https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&lmt=${days}&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63`)
  const k = j.data?.klines
  if (!k) throw new BxError('NOT_FOUND', `${symbol} 没有资金流数据`, '检查代码')
  return k.map(l => {
    const [date, main, small, mid, big, huge, mainPct, smallPct, midPct, bigPct, hugePct, close, percent] = l.split(',')
    return { date, close: +close, percent: +percent, main: +main, mainPct: +mainPct, huge: +huge, big: +big, mid: +mid, small: +small, hugePct: +hugePct, bigPct: +bigPct, midPct: +midPct, smallPct: +smallPct }
  })
}

/** 今日资金流排行。scope：stock 个股 / industry 行业 / concept 概念 / region 地域；order：desc 净流入最多 / asc 净流出最多
 *  @example moneyflowRank({ limit: 20 })
 *  @example moneyflowRank({ scope: 'industry', order: 'asc' }) */
export async function moneyflowRank({ scope = 'stock', order = 'desc', limit = 30 } = {}) {
  const fs = scope === 'stock' ? A_SHARES : BOARDS[scope]
  if (!fs) throw new BxError('BAD_ARGS', 'scope 只能是 stock / industry / concept / region')
  const d = await clist(fs, 'f12,f13,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87', { fid: 'f62', desc: order !== 'asc', limit })
  return d.map((x, i) => ({
    rank: i + 1,
    code: x.f12,
    name: x.f14,
    price: num(x.f2),
    percent: num(x.f3),
    main: num(x.f62),
    mainPct: num(x.f184),
    huge: num(x.f66),
    big: num(x.f72),
    mid: num(x.f78),
    small: num(x.f84),
    url: scope === 'stock' ? quoteUrl(x.f12, x.f13 === 1 ? 'SH' : undefined) : `https://quote.eastmoney.com/bk/90.${x.f12}.html`,
  }))
}

const MUTUAL = { north: '005', sh: '001', sz: '003', south: '006', hksh: '002', hksz: '004' }

/** 南北向资金每天的成交额（亿元）和领涨股。type：north 北向合计 sh 沪股通 sz 深股通 south 南向合计。
 *  注意：2024-08 起北向不再公布净买入，netBuy 只有南向有
 *  @example northbound({ days: 20 }) */
export async function northbound({ type = 'north', days = 20 } = {}) {
  const t = MUTUAL[type] || type
  const d = await dc('RPT_MUTUAL_DEAL_HISTORY', { filter: `(MUTUAL_TYPE="${t}")`, sort: 'TRADE_DATE', size: days })
  if (!d.length) throw new BxError('EMPTY', '没有南北向数据')
  const yi = v => (v == null ? undefined : Math.round(v) / 100) // 百万元 → 亿元
  return d.map(x => ({ date: day(x.TRADE_DATE), amount: yi(x.DEAL_AMT), netBuy: yi(x.NET_DEAL_AMT), deals: x.DEAL_NUM, leader: x.LEAD_STOCKS_NAME, leaderPct: x.LS_CHANGE_RATE, index: x.INDEX_CLOSE_PRICE, indexPct: x.INDEX_CHANGE_RATE }))
}

/** 北向（沪股通 / 深股通）十大成交股。type：sh / sz；date 默认最近一天
 *  @example northTop10({ type: 'sh' }) */
export async function northTop10({ type = 'sh', date = '' } = {}) {
  const t = MUTUAL[type] || type
  if (!date) date = day((await dc('RPT_MUTUAL_TOP10DEAL', { filter: `(MUTUAL_TYPE="${t}")`, sort: 'TRADE_DATE', size: 1 }))[0]?.TRADE_DATE)
  const d = await dc('RPT_MUTUAL_TOP10DEAL', { filter: `(MUTUAL_TYPE="${t}")(TRADE_DATE='${date}')`, sort: 'RANK', order: '1', size: 10 })
  if (!d.length) throw new BxError('EMPTY', `${date} 没有十大成交股`)
  return d.map(x => ({ date: day(x.TRADE_DATE), rank: x.RANK, code: x.SECURITY_CODE, name: x.SECURITY_NAME, close: x.CLOSE_PRICE, percent: x.CHANGE_RATE, dealAmount: x.DEAL_AMT, ratio: x.MUTUAL_RATIO, netBuy: x.NET_BUY_AMT ?? undefined, url: quoteUrl(x.SECURITY_CODE) }))
}

const BOARD_SORT = { percent: 'f3', amount: 'f6', turnover: 'f8', marketCap: 'f20', moneyflow: 'f62' }

/** 板块排行。type：industry 行业 / concept 概念 / region 地域；by：percent 涨幅 amount 成交额 turnover 换手 marketCap 市值 moneyflow 主力净流入；order：desc / asc
 *  @example boards({ type: 'concept', limit: 20 })
 *  @example boards({ type: 'industry', by: 'moneyflow' }) */
export async function boards({ type = 'industry', by = 'percent', order = 'desc', limit = 30 } = {}) {
  const fs = BOARDS[type]
  if (!fs) throw new BxError('BAD_ARGS', 'type 只能是 industry / concept / region')
  const d = await clist(fs, 'f12,f14,f2,f3,f6,f8,f20,f62,f104,f105,f128,f140,f136', { fid: BOARD_SORT[by] || by, desc: order !== 'asc', limit })
  return d.map((x, i) => ({ rank: i + 1, code: x.f12, name: x.f14, percent: num(x.f3), amount: num(x.f6), turnover: num(x.f8), marketCap: num(x.f20), main: num(x.f62), up: x.f104, down: x.f105, leader: x.f128, leaderCode: x.f140, leaderPct: num(x.f136), url: `https://quote.eastmoney.com/bk/90.${x.f12}.html` }))
}

/** 板块成分股（按涨幅排）。board 是板块代码 BK…（boards() 结果里的 code）
 *  @example boardStocks('BK0477', { limit: 30 }) */
export async function boardStocks(board, { by = 'percent', order = 'desc', limit = 50 } = {}) {
  if (!/^BK\d+$/i.test(board)) throw new BxError('BAD_ARGS', '要板块代码 BK…，先用 boards() 查')
  return rank({ market: `b:${board.toUpperCase()}`, by, order, limit })
}

const RANK_SORT = { percent: 'f3', amount: 'f6', turnover: 'f8', volumeRatio: 'f10', amplitude: 'f7', marketCap: 'f20', pe: 'f9', price: 'f2' }

/** A 股涨跌排行。by：percent 涨幅 amount 成交额 turnover 换手 volumeRatio 量比 amplitude 振幅 marketCap 市值；order：desc / asc（跌幅榜）；
 *  market：all 沪深京 sh sz bj cyb 创业板 kcb 科创板 etf 场内 ETF bond 可转债
 *  @example rank({ limit: 20 })
 *  @example rank({ order: 'asc', limit: 20 })
 *  @example rank({ by: 'amount', market: 'kcb' })
 *  @example rank({ by: 'amount', market: 'etf', limit: 20 }) */
export async function rank({ by = 'percent', order = 'desc', market = 'all', limit = 50 } = {}) {
  const fs = MARKETS[market] || market
  const d = await clist(fs, 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23', { fid: RANK_SORT[by] || by, desc: order !== 'asc', limit })
  if (!d.length) throw new BxError('EMPTY', '没有行情数据')
  return d.map((x, i) => ({
    rank: i + 1,
    code: x.f12,
    name: x.f14,
    price: num(x.f2),
    percent: num(x.f3),
    change: num(x.f4),
    volume: num(x.f5),
    amount: num(x.f6),
    amplitude: num(x.f7),
    turnover: num(x.f8),
    volumeRatio: num(x.f10),
    pe: num(x.f9),
    pb: num(x.f23),
    marketCap: num(x.f20),
    floatCap: num(x.f21),
    url: quoteUrl(x.f12, x.f13 === 1 ? 'SH' : x.f13 === 0 ? (/^[48]|^92/.test(x.f12) ? 'BJ' : 'SZ') : undefined),
  }))
}

/** 十大股东（float: true 看十大流通股东），最近一期；带股东户数变化
 *  @example holders('600519')
 *  @example holders('600519', { float: true }) */
export async function holders(symbol, { float = false } = {}) {
  const { code, mkt } = sym(symbol)
  const j = await get(`https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=${mkt}${code}`)
  const list = float ? j.sdltgd : j.sdgd
  if (!Array.isArray(list)) throw new BxError('NOT_FOUND', `${symbol} 没有股东数据`, '检查代码（只支持 A 股）')
  const g = (j.gdrs || [])[0]
  return {
    date: day(list[0]?.END_DATE),
    holderCount: g?.HOLDER_TOTAL_NUM,
    holderCountChange: g?.TOTAL_NUM_RATIO != null ? +g.TOTAL_NUM_RATIO.toFixed(2) : undefined,
    concentration: g?.HOLD_FOCUS,
    holders: list.map(x => ({ rank: x.HOLDER_RANK, name: x.HOLDER_NAME, type: x.HOLDER_TYPE || x.SHARES_TYPE, shares: x.HOLD_NUM, ratio: +(x.HOLD_NUM_RATIO ?? x.FREE_HOLDNUM_RATIO)?.toFixed(2), change: x.HOLD_NUM_CHANGE, changeRatio: x.CHANGE_RATIO ?? undefined })),
    url: `https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/Index?type=web&code=${mkt}${code}`,
  }
}

/** 东方财富股吧人气榜（A 股，按人气排名）。带实时价格和涨跌幅
 *  @example hot({ limit: 20 }) */
export async function hot({ limit = 50 } = {}) {
  let r
  try {
    r = await fetch('https://emappdata.eastmoney.com/stockrank/getAllCurrentList', {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'appId01', globalId: '786e4c21-70dc-435a-93bb-38', marketType: '', pageNo: 1, pageSize: Math.min(100, limit) }),
    }).then(r => r.json())
  } catch (e) {
    throw new BxError('HTTP_ERROR', `人气榜接口出错：${e.message}`)
  }
  const list = r?.data
  if (!Array.isArray(list)) throw new BxError('CHANGED', '人气榜接口的返回结构变了', '去修 hot')
  if (!list.length) throw new BxError('EMPTY', '人气榜是空的')
  const secids = list.map(x => `${x.sc.startsWith('SH') ? 1 : 0}.${x.sc.slice(2)}`)
  const q = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=${secids.join(',')}&fields=f12,f14,f2,f3,f6,f8`)
  const by = Object.fromEntries((q.data?.diff || []).map(x => [x.f12, x]))
  return list.map(x => {
    const code = x.sc.slice(2)
    const s = by[code] || {}
    return { rank: x.rk, code, name: s.f14, price: num(s.f2), percent: num(s.f3), amount: num(s.f6), turnover: num(s.f8), rankChange: x.rc || undefined, url: `https://guba.eastmoney.com/list,${code}.html` }
  })
}