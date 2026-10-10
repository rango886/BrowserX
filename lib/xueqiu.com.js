/* 站点笔记（雪球）：
 * @login optional 行情、K 线、财务不用登录（游客 token 就行）；帖子、评论、搜索登录后更全，也不容易被风控
 * - 股票代码：A 股 SH600519 / SZ000895，港股 00700，美股 AAPL；search() 可以把名字换成代码
 * - stock.xueqiu.com 的接口（行情、K 线、财务、公司资料、热股）在 xueqiu.com 标签里带 cookie 直接 fetch：
 *     行情 /v5/stock/batch/quote.json?symbol=A,B&extend=detail
 *     K 线 /v5/stock/chart/kline.json?symbol=&begin=<毫秒>&period=day|week|month|60m…&type=before（前复权）&count=-N&indicator=kline,pe,pb,market_capital
 *     财务指标 /v5/stock/finance/{cn|hk|us}/indicator.json?symbol=&type=Q4|all&is_detail=true&count=（每个指标是 [值, 同比]）
 *     公司资料 /v5/stock/f10/{cn|hk|us}/company.json?symbol=
 *     热股 /v5/stock/hot_stock/list.json?size=&type=10 人气 / 12 关注
 * - xueqiu.com 自己的接口（帖子、搜索、热帖、评论）有阿里云 WAF：页面里 fetch 会拿到 <textarea id="renderData">{"_waf_…"} 挑战页。
 *   做法是在后台标签里直接打开接口网址，让挑战 JS 跑完自动跳回 JSON，再读 body（navJson）。每次请求都要这样，不能复用 cookie
 *     个股讨论 /query/v1/symbol/search/status.json?symbol=&sort=time|reply&count=&page=&type=11&source=all
 *     搜帖子 /query/v1/search/status.json?q=&sortId=1（相关）|2（最新）&count=&page=
 *     股票联想 /query/v1/suggest_stock.json?q=
 *     热帖 /statuses/hot/listV3.json?source=hot&page=
 *     评论 /statuses/v3/comments.json?id=<帖子id>&type=4&size=20&max_id=-1（翻页用返回的 next_max_id）
 * - 帖子页 xueqiu.com/<uid>/<id>：window.SNOWMAN_STATUS 是帖子数据（text 是 HTML）
 */

const tabOf = () => bx.tab('xueqiu.com', { open: 'https://xueqiu.com/' })
const ms = t => (t ? new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined)
const strip = h => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()
const market = s => (/^(SH|SZ|BJ)\d{6}$/i.test(s) ? 'cn' : /^\d{4,5}$/.test(s) ? 'hk' : 'us')
const norm = s => {
  s = String(s).trim().toUpperCase()
  if (/^\d{6}$/.test(s)) return (/^[69]/.test(s) ? 'SH' : /^[48]/.test(s) ? 'BJ' : 'SZ') + s
  return s
}

async function stockApi(path) {
  const tab = await tabOf()
  const j = await tab.fetch('https://stock.xueqiu.com' + path)
  if (j.error_code && j.error_code !== 0) throw new BxError(String(j.error_code) === '400016' ? 'NEED_LOGIN' : 'HTTP_ERROR', `雪球接口出错：${j.error_description || j.error_code}`, '在浏览器里打开一次 xueqiu.com（拿游客 token）或登录后重试')
  return j.data
}

/** 在后台标签里打开接口网址（过 WAF），读出 JSON */
let navTab
async function navJson(url) {
  navTab ||= await bx.open('about:blank')
  await navTab.goto(url)
  let body = ''
  for (let i = 0; i < 15; i++) {
    await bx.sleep(600)
    body = await navTab.eval(() => document.body?.innerText || '').catch(() => '')
    if (/^\s*[[{]/.test(body)) break
  }
  if (!/^\s*[[{]/.test(body)) throw new BxError('BLOCKED', '雪球 WAF 没放行', `bx tab activate ${navTab.id} 看看是不是要滑块验证`)
  const j = JSON.parse(body)
  if (j.error_code) {
    if (/登录|login/i.test(j.error_description || '')) throw new BxError('NEED_LOGIN', '雪球要登录', '在浏览器里登录 xueqiu.com 后重试')
    throw new BxError('HTTP_ERROR', `雪球接口出错：${j.error_description || j.error_code}`)
  }
  return j
}
async function done() {
  if (navTab) await navTab.close().catch(() => {})
  navTab = undefined
}

const postOf = p => ({
  id: p.id,
  title: p.title || undefined,
  user: p.user?.screen_name,
  text: strip(p.text || p.description).slice(0, 2000),
  time: ms(p.created_at),
  replies: p.reply_count,
  retweets: p.retweet_count,
  likes: p.like_count,
  views: p.view_count || undefined,
  url: 'https://xueqiu.com' + (p.target || `/${p.user_id}/${p.id}`),
})

/** 按名字 / 代码找股票，返回雪球代码
 *  @login none
 *  @example search('茅台') */
export async function search(q, { limit = 10 } = {}) {
  try {
    const j = await navJson(`https://xueqiu.com/query/v1/suggest_stock.json?q=${encodeURIComponent(q)}`)
    return (j.data || []).slice(0, limit).map(x => ({ symbol: x.code, name: x.query, type: x.stock_type, url: `https://xueqiu.com/S/${x.code}` }))
  } finally {
    await done()
  }
}

/** 实时行情（多个代码用逗号分开）：价格、涨跌幅、市值、PE/PB、换手率、52 周高低…
 *  @login none
 *  @example quote('SH600519,AAPL,00700') */
export async function quote(symbols) {
  const list = String(symbols).split(/[,\s]+/).filter(Boolean).map(norm)
  const d = await stockApi(`/v5/stock/batch/quote.json?symbol=${list.join(',')}&extend=detail`)
  return (d.items || []).map(({ quote: q, market: m }) => ({
    symbol: q.symbol,
    name: q.name,
    price: q.current,
    change: q.chg,
    percent: q.percent,
    open: q.open,
    high: q.high,
    low: q.low,
    lastClose: q.last_close,
    volume: q.volume,
    amount: q.amount,
    turnover: q.turnover_rate,
    marketCap: q.market_capital,
    pe: q.pe_ttm,
    pb: q.pb,
    dividendYield: q.dividend_yield,
    high52w: q.high52w,
    low52w: q.low52w,
    ytd: q.current_year_percent,
    currency: q.currency,
    status: m?.status,
    time: ms(q.timestamp),
    url: `https://xueqiu.com/S/${q.symbol}`,
  }))
}

/** K 线（默认前复权）。period：day week month quarter year 1m 5m 15m 30m 60m 120m；count 往前取多少根
 *  @login none
 *  @example kline('SH600519', { period: 'day', count: 60 }) */
export async function kline(symbol, { period = 'day', count = 120, adjust = 'before' } = {}) {
  const d = await stockApi(`/v5/stock/chart/kline.json?symbol=${norm(symbol)}&begin=${Date.now()}&period=${period}&type=${adjust}&count=-${count}&indicator=kline,pe,pb,market_capital`)
  const cols = d.column || []
  return (d.item || []).map(row => {
    const o = Object.fromEntries(cols.map((c, i) => [c, row[i]]))
    return { date: ms(o.timestamp)?.slice(0, period.endsWith('m') ? 16 : 10), open: o.open, high: o.high, low: o.low, close: o.close, volume: o.volume, amount: o.amount, percent: o.percent, turnover: o.turnoverrate, pe: o.pe, pb: o.pb, marketCap: o.market_capital }
  })
}

/** 主要财务指标（营收、净利、毛利率、ROE、负债率…，带同比）。type：Q4 只看年报 / all 每个季度
 *  @login none
 *  @example finance('SH600519', { type: 'Q4', count: 5 }) */
export async function finance(symbol, { type = 'Q4', count = 5 } = {}) {
  const s = norm(symbol)
  const d = await stockApi(`/v5/stock/finance/${market(s)}/indicator.json?symbol=${s}&type=${type}&is_detail=true&count=${count}`)
  return (d.list || []).map(r => {
    const o = { report: r.report_name, date: ms(r.report_date)?.slice(0, 10) }
    for (const [k, v] of Object.entries(r)) if (Array.isArray(v)) o[k] = v[0] != null && v[1] != null ? `${v[0]} (${(v[1] * 100).toFixed(1)}%)` : v[0]
    return o
  })
}

/** 公司资料：全称、主营业务、行业、上市日期、董事长、员工人数、简介
 *  @login none
 *  @example company('SH600519') */
export async function company(symbol) {
  const s = norm(symbol)
  const d = await stockApi(`/v5/stock/f10/${market(s)}/company.json?symbol=${s}`)
  const c = d.company || {}
  return {
    name: c.org_name_cn || c.org_name_en,
    shortName: c.org_short_name_cn || c.org_short_name_en,
    business: c.main_operation_business || undefined,
    scope: c.operating_scope?.slice(0, 500) || undefined,
    industry: c.affiliate_industry?.ind_name || c.classi_name || undefined,
    listed: ms(c.listed_date)?.slice(0, 10),
    chairman: c.chairman || undefined,
    employees: c.staff_num || undefined,
    province: c.provincial_name || undefined,
    website: c.org_website || undefined,
    intro: c.org_cn_introduction?.slice(0, 1500) || c.org_introduction?.slice(0, 1500) || undefined,
  }
}

/** 热股榜。type：10 人气 / 12 关注
 *  @login none
 *  @example hotStocks({ limit: 20 }) */
export async function hotStocks({ type = 10, limit = 20 } = {}) {
  const d = await stockApi(`/v5/stock/hot_stock/list.json?size=${limit}&type=${type}`)
  return (d.items || []).map((x, i) => ({ rank: i + 1, symbol: x.symbol, name: x.name, price: x.current, percent: x.percent, heat: x.value, url: `https://xueqiu.com/S/${x.symbol}` }))
}

/** 个股讨论帖。sort：time 最新 / reply 最多回复
 *  @example posts('SH600519', { sort: 'reply', limit: 20 }) */
export async function posts(symbol, { sort = 'time', limit = 20 } = {}) {
  const out = []
  try {
    for (let page = 1; out.length < limit && page <= 10; page++) {
      const j = await navJson(`https://xueqiu.com/query/v1/symbol/search/status.json?count=20&comment=0&symbol=${norm(symbol)}&hl=0&source=all&sort=${sort}&page=${page}&q=&type=11`)
      out.push(...(j.list || []).map(postOf))
      if (!(j.list || []).length) break
    }
  } finally {
    await done()
  }
  return out.slice(0, limit)
}

/** 按关键词搜帖子。sort：relevance 相关 / time 最新
 *  @example searchPosts('双汇 处罚', { limit: 20 }) */
export async function searchPosts(q, { sort = 'relevance', limit = 20 } = {}) {
  const out = []
  try {
    for (let page = 1; out.length < limit && page <= 10; page++) {
      const j = await navJson(`https://xueqiu.com/query/v1/search/status.json?sortId=${sort === 'time' ? 2 : 1}&q=${encodeURIComponent(q)}&count=20&page=${page}`)
      out.push(...(j.list || []).map(postOf))
      if (!(j.list || []).length) break
    }
  } finally {
    await done()
  }
  if (!out.length) throw new BxError('EMPTY', `雪球没有搜到 ${q}`, '换个关键词')
  return out.slice(0, limit)
}

/** 雪球热帖
 *  @example hot({ limit: 20 }) */
export async function hot({ limit = 20 } = {}) {
  try {
    const j = await navJson('https://xueqiu.com/statuses/hot/listV3.json?source=hot&page=1')
    return (j.items || j.list || []).map(x => x.original_status || x).slice(0, limit).map(postOf)
  } finally {
    await done()
  }
}

/** 一个帖子的正文 + 评论
 *  @example post('https://xueqiu.com/4261231916/411768458', { comments: 20 }) */
export async function post(url, { comments = 20 } = {}) {
  const m = String(url).match(/xueqiu\.com\/(\d+)\/(\d+)/)
  if (!m) throw new BxError('BAD_ARGS', '要帖子链接 xueqiu.com/<uid>/<id>')
  const tab = await bx.open(`https://xueqiu.com/${m[1]}/${m[2]}`)
  try {
    await tab.waitFor({ fn: 'window.SNOWMAN_STATUS', timeout: 15000 }).catch(() => {})
    const s = await tab.eval(() => (window.SNOWMAN_STATUS ? JSON.parse(JSON.stringify(window.SNOWMAN_STATUS)) : null))
    if (!s) throw new BxError('NOT_FOUND', '帖子打不开（删除了或要登录）', '在浏览器里打开看看')
    const list = []
    let maxId = -1
    while (list.length < comments) {
      const j = await navJson(`https://xueqiu.com/statuses/v3/comments.json?id=${m[2]}&type=4&size=20&max_id=${maxId}`).catch(() => null)
      if (!j) break
      for (const c of j.comments || []) list.push({ user: c.user?.screen_name, text: strip(c.text), likes: c.like_count, time: ms(c.created_at), replyTo: c.reply_screenName || undefined })
      if (!j.next_max_id || j.next_max_id === -1 || !(j.comments || []).length) break
      maxId = j.next_max_id
    }
    return { ...postOf(s), text: strip(s.text || s.description), symbols: s.topic_symbol || undefined, commentList: list.slice(0, comments) }
  } finally {
    await done()
    await tab.close().catch(() => {})
  }
}
