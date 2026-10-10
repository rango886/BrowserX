/* 站点笔记（Yahoo Finance）：
 * @login none 不用登录；但 quote / profile / options 要 crumb，得借一个 finance.yahoo.com 标签（游客 cookie 就行）
 * - 不要 crumb、Node 里直接 fetch：
 *     K 线 query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d（range：1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max；interval：1m 5m 15m 1h 1d 1wk 1mo）
 *     搜索 query2.finance.yahoo.com/v1/finance/search?q=&quotesCount=&newsCount=（股票 + 新闻）
 *     热门 query1.finance.yahoo.com/v1/finance/trending/US
 *     榜单 query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=（休市 / 周末时 Yahoo 自己排得不准，day_losers 里会出现涨的）
 *     财报时间序列 query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/AAPL?type=annualTotalRevenue,…&period1=&period2=
 * - 要 crumb（Node 直接请求 401 Invalid Crumb）：在 finance.yahoo.com 标签里 fetch /v1/test/getcrumb 拿到 crumb，再带 credentials:'include' 请求
 *     行情 /v7/finance/quote?symbols=A,B&crumb=
 *     公司资料 / 估值 / 分析师 /v10/finance/quoteSummary/AAPL?modules=price,assetProfile,financialData,defaultKeyStatistics,summaryDetail,calendarEvents,recommendationTrend&crumb=
 *     期权链 /v7/finance/options/AAPL?date=<到期日秒>&crumb=
 * - 代码：美股 AAPL，港股 0700.HK，A 股 600519.SS / 000001.SZ，指数 ^GSPC ^IXIC ^HSI，期货 GC=F CL=F，外汇 USDCNY=X，加密 BTC-USD
 */

const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', Accept: 'application/json' }

async function get(url) {
  let r
  try {
    r = await fetch(url, { headers: H })
  } catch (e) {
    throw new BxError('HTTP_ERROR', `Yahoo 接口连不上：${e.cause?.code || e.message}`, '检查网络（可能要代理）')
  }
  if (r.status === 429) throw new BxError('BLOCKED', 'Yahoo 限流了（429）', '停一会儿再试')
  const j = await r.json().catch(() => null)
  if (!j) throw new BxError('CHANGED', `Yahoo 接口返回的不是 JSON（HTTP ${r.status}）`, url)
  return j
}

/** 在 finance.yahoo.com 标签里带 crumb 请求（quote / quoteSummary / options 要用） */
let crumb
async function crumbGet(path) {
  const tab = await bx.tab('finance.yahoo.com', { open: 'https://finance.yahoo.com/' })
  const r = await tab.eval(
    async (path, crumb) => {
      const get = c => fetch(`https://query2.finance.yahoo.com${path}${path.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(c)}`, { credentials: 'include' }).then(async r => ({ status: r.status, body: await r.text() }))
      let c = crumb
      if (!c) c = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { credentials: 'include' }).then(r => r.text())
      let res = await get(c)
      if (res.status === 401 && crumb) {
        c = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { credentials: 'include' }).then(r => r.text())
        res = await get(c)
      }
      return { ...res, crumb: c }
    },
    path,
    crumb || '',
  )
  if (r.status === 429) throw new BxError('BLOCKED', 'Yahoo 限流了（429）', '停一会儿再试')
  if (r.status === 401) throw new BxError('BLOCKED', 'Yahoo 不认 crumb（401）', `bx tab activate ${tab.id}，看看是不是有 cookie 同意弹窗`)
  crumb = r.crumb
  let j
  try {
    j = JSON.parse(r.body)
  } catch {
    throw new BxError('CHANGED', `Yahoo 接口返回的不是 JSON（HTTP ${r.status}）`, path)
  }
  return j
}

const day = s => (s ? new Date(s * 1000).toISOString().slice(0, 10) : undefined)
const raw = v => (v && typeof v === 'object' ? v.raw ?? v.fmt : v)
const qs = s => encodeURIComponent(String(s).trim().toUpperCase())

/** 搜股票代码 + 相关新闻
 *  @example search('nvidia', { limit: 5 }) */
export async function search(q, { limit = 10, news = 0 } = {}) {
  const j = await get(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${limit}&newsCount=${news}`)
  const out = (j.quotes || []).map(x => ({ symbol: x.symbol, name: x.longname || x.shortname, type: x.typeDisp || x.quoteType, exchange: x.exchDisp, sector: x.sectorDisp, industry: x.industryDisp, url: `https://finance.yahoo.com/quote/${encodeURIComponent(x.symbol)}/` }))
  if (!out.length) throw new BxError('EMPTY', `Yahoo 没有找到 ${q}`, '换个名字或代码')
  return out
}

/** 新闻（按关键词或代码）
 *  @example news('AAPL', { limit: 10 }) */
export async function news(q, { limit = 10 } = {}) {
  const j = await get(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=${limit}`)
  const out = (j.news || []).map(x => ({ time: x.providerPublishTime ? new Date(x.providerPublishTime * 1000).toISOString().slice(0, 16).replace('T', ' ') : undefined, title: x.title, publisher: x.publisher, symbols: x.relatedTickers?.join(',') || undefined, url: x.link }))
  if (!out.length) throw new BxError('EMPTY', `没有 ${q} 的新闻`)
  return out
}

/** 实时行情（多个用逗号分开）：价格、涨跌、盘前盘后、市值、PE、52 周高低、分析师评级…
 *  @example quote('AAPL,MSFT,0700.HK,^GSPC,GC=F,BTC-USD') */
export async function quote(symbols) {
  const list = String(symbols).split(/[,\s]+/).filter(Boolean)
  const j = await crumbGet(`/v7/finance/quote?symbols=${list.map(qs).join(',')}`)
  const r = j.quoteResponse?.result
  if (!Array.isArray(r)) throw new BxError('CHANGED', 'quote 接口的返回结构变了', '去修 quote')
  if (!r.length) throw new BxError('NOT_FOUND', `没有这些代码：${symbols}`, '先 search 查代码')
  return r.map(x => ({
    symbol: x.symbol,
    name: x.longName || x.shortName,
    price: x.regularMarketPrice,
    change: x.regularMarketChange != null ? +x.regularMarketChange.toFixed(4) : undefined,
    percent: x.regularMarketChangePercent != null ? +x.regularMarketChangePercent.toFixed(2) : undefined,
    open: x.regularMarketOpen,
    high: x.regularMarketDayHigh,
    low: x.regularMarketDayLow,
    lastClose: x.regularMarketPreviousClose,
    volume: x.regularMarketVolume,
    preMarket: x.preMarketPrice ? `${x.preMarketPrice} (${x.preMarketChangePercent?.toFixed(2)}%)` : undefined,
    postMarket: x.postMarketPrice ? `${x.postMarketPrice} (${x.postMarketChangePercent?.toFixed(2)}%)` : undefined,
    marketCap: x.marketCap,
    pe: x.trailingPE != null ? +x.trailingPE.toFixed(2) : undefined,
    forwardPe: x.forwardPE != null ? +x.forwardPE.toFixed(2) : undefined,
    eps: x.epsTrailingTwelveMonths,
    dividendYield: x.dividendYield ?? x.trailingAnnualDividendYield,
    high52w: x.fiftyTwoWeekHigh,
    low52w: x.fiftyTwoWeekLow,
    rating: x.averageAnalystRating,
    earnings: day(x.earningsTimestamp),
    currency: x.currency,
    exchange: x.fullExchangeName,
    state: x.marketState,
    time: x.regularMarketTime ? new Date(x.regularMarketTime * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : undefined,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(x.symbol)}/`,
  }))
}

/** K 线。range：1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max；interval：1m 5m 15m 30m 1h 1d 1wk 1mo
 *  @example chart('AAPL', { range: '6mo', interval: '1d' })
 *  @example chart('^GSPC', { range: '5d', interval: '1h' }) */
export async function chart(symbol, { range = '3mo', interval = '1d' } = {}) {
  const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${qs(symbol)}?range=${range}&interval=${interval}&includePrePost=false`)
  const r = j.chart?.result?.[0]
  if (!r) throw new BxError(j.chart?.error?.code === 'Not Found' ? 'NOT_FOUND' : 'CHANGED', `K 线取不到：${j.chart?.error?.description || symbol}`, '检查代码和 range / interval 组合')
  const q = r.indicators?.quote?.[0] || {}
  const adj = r.indicators?.adjclose?.[0]?.adjclose
  const intraday = /m|h/.test(interval)
  const off = (r.meta?.gmtoffset || 0) * 1000
  const f = v => (v == null ? undefined : +v.toFixed(4))
  return (r.timestamp || []).map((t, i) => ({
    date: new Date(t * 1000 + off).toISOString().slice(0, intraday ? 16 : 10).replace('T', ' '),
    open: f(q.open?.[i]),
    high: f(q.high?.[i]),
    low: f(q.low?.[i]),
    close: f(q.close?.[i]),
    adjClose: adj ? f(adj[i]) : undefined,
    volume: q.volume?.[i] ?? undefined,
  })).filter(x => x.close != null)
}

/** 公司资料 + 估值 + 财务摘要 + 分析师目标价 + 下次财报日
 *  @example profile('NVDA') */
export async function profile(symbol) {
  const j = await crumbGet(`/v10/finance/quoteSummary/${qs(symbol)}?modules=price,assetProfile,financialData,defaultKeyStatistics,summaryDetail,calendarEvents,recommendationTrend`)
  const r = j.quoteSummary?.result?.[0]
  if (!r) throw new BxError('NOT_FOUND', `${symbol} 没有资料：${j.quoteSummary?.error?.description || ''}`, '先 search 查代码')
  const p = r.assetProfile || {}
  const fd = r.financialData || {}
  const ks = r.defaultKeyStatistics || {}
  const sd = r.summaryDetail || {}
  const rec = r.recommendationTrend?.trend?.[0]
  return {
    symbol: r.price?.symbol,
    name: r.price?.longName || r.price?.shortName,
    price: raw(r.price?.regularMarketPrice),
    currency: r.price?.currency,
    marketCap: raw(r.price?.marketCap),
    sector: p.sector,
    industry: p.industry,
    country: p.country,
    employees: p.fullTimeEmployees,
    website: p.website,
    summary: p.longBusinessSummary,
    officers: p.companyOfficers?.slice(0, 5).map(o => `${o.name}（${o.title}）`).join('；') || undefined,
    pe: raw(sd.trailingPE),
    forwardPe: raw(sd.forwardPE),
    pb: raw(ks.priceToBook),
    ps: raw(sd.priceToSalesTrailing12Months),
    peg: raw(ks.pegRatio) ?? raw(ks.trailingPegRatio),
    beta: raw(sd.beta),
    dividendYield: raw(sd.dividendYield),
    revenue: raw(fd.totalRevenue),
    revenueGrowth: raw(fd.revenueGrowth),
    grossMargin: raw(fd.grossMargins),
    operatingMargin: raw(fd.operatingMargins),
    profitMargin: raw(fd.profitMargins),
    roe: raw(fd.returnOnEquity),
    freeCashFlow: raw(fd.freeCashflow),
    cash: raw(fd.totalCash),
    debt: raw(fd.totalDebt),
    targetMean: raw(fd.targetMeanPrice),
    targetHigh: raw(fd.targetHighPrice),
    targetLow: raw(fd.targetLowPrice),
    analysts: raw(fd.numberOfAnalystOpinions),
    recommendation: fd.recommendationKey,
    ratings: rec ? `强买 ${rec.strongBuy} / 买 ${rec.buy} / 持有 ${rec.hold} / 卖 ${rec.sell} / 强卖 ${rec.strongSell}` : undefined,
    nextEarnings: r.calendarEvents?.earnings?.earningsDate?.map(d => day(raw(d))).join(' ~ ') || undefined,
    shortPercent: raw(ks.shortPercentOfFloat),
    insiders: raw(ks.heldPercentInsiders),
    institutions: raw(ks.heldPercentInstitutions),
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/profile/`,
  }
}

const FIN = ['TotalRevenue', 'GrossProfit', 'OperatingIncome', 'NetIncome', 'DilutedEPS', 'OperatingCashFlow', 'FreeCashFlow', 'CapitalExpenditure', 'TotalAssets', 'TotalDebt', 'CashAndCashEquivalents', 'StockholdersEquity', 'ResearchAndDevelopment']

/** 财报主要科目（营收、毛利、营业利润、净利润、EPS、现金流、资产负债…）。period：annual 年报 / quarterly 季报
 *  @example financials('AAPL')
 *  @example financials('TSLA', { period: 'quarterly' }) */
export async function financials(symbol, { period = 'annual' } = {}) {
  const types = FIN.map(t => period + t).join(',')
  const j = await get(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${qs(symbol)}?type=${types}&period1=1420070400&period2=${Math.floor(Date.now() / 1000)}`)
  const res = j.timeseries?.result
  if (!Array.isArray(res)) throw new BxError('CHANGED', '财报接口的返回结构变了', '去修 financials')
  const rows = {}
  for (const x of res) {
    const k = x.meta?.type?.[0]
    for (const v of x[k] || []) {
      if (!v) continue
      const name = k.slice(period.length)
      ;(rows[v.asOfDate] ||= { date: v.asOfDate, currency: v.currencyCode })[name[0].toLowerCase() + name.slice(1)] = v.reportedValue?.raw
    }
  }
  const out = Object.values(rows).sort((a, b) => (a.date < b.date ? 1 : -1))
  if (!out.length) throw new BxError('NOT_FOUND', `${symbol} 没有财报数据`, '指数、基金、期货没有财报')
  return out
}

/** 期权链（默认最近到期日）。date 写到期日 YYYY-MM-DD；type：call / put / all；near：只要离现价最近的 N 个行权价（0 = 全部）
 *  不知道有哪些到期日：先调一次，结果里的 expirations 就是
 *  @example options('AAPL', { near: 10 })
 *  @example options('TSLA', { date: '2026-12-18', type: 'put' }) */
export async function options(symbol, { date = '', type = 'all', near = 20 } = {}) {
  const d = date ? `&date=${Math.floor(Date.parse(date + 'T00:00:00Z') / 1000)}` : ''
  const j = await crumbGet(`/v7/finance/options/${qs(symbol)}?${d.slice(1)}`)
  const r = j.optionChain?.result?.[0]
  if (!r) throw new BxError('NOT_FOUND', `${symbol} 没有期权`, '检查代码')
  const o = r.options?.[0] || {}
  const spot = r.quote?.regularMarketPrice
  const pick = (list, side) => {
    let l = (list || []).map(c => ({ side, strike: c.strike, last: c.lastPrice, bid: c.bid, ask: c.ask, change: c.change != null ? +c.change.toFixed(2) : undefined, percent: c.percentChange != null ? +c.percentChange.toFixed(2) : undefined, volume: c.volume, openInterest: c.openInterest, iv: c.impliedVolatility != null ? +c.impliedVolatility.toFixed(4) : undefined, itm: c.inTheMoney, contract: c.contractSymbol }))
    if (near && spot) l = l.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, near).sort((a, b) => a.strike - b.strike)
    return l
  }
  const chain = [...(type !== 'put' ? pick(o.calls, 'call') : []), ...(type !== 'call' ? pick(o.puts, 'put') : [])]
  if (!chain.length) throw new BxError('EMPTY', `${symbol} 在 ${date || '最近到期日'} 没有期权`, '换个到期日（见 expirations）')
  return { symbol: r.underlyingSymbol, price: spot, expiration: day(o.expirationDate), expirations: (r.expirationDates || []).map(day), chain }
}

/** 美股热门代码
 *  @example trending({ limit: 10 }) */
export async function trending({ region = 'US', limit = 20 } = {}) {
  const j = await get(`https://query1.finance.yahoo.com/v1/finance/trending/${region}?count=${limit}`)
  const syms = (j.finance?.result?.[0]?.quotes || []).map(x => x.symbol)
  if (!syms.length) throw new BxError('EMPTY', '没有热门代码')
  const s = await get(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${syms.map(encodeURIComponent).join(',')}&range=1d&interval=1d`)
  const meta = Object.fromEntries((s.spark?.result || []).map(x => [x.symbol, x.response?.[0]?.meta || {}]))
  return syms.map((sym, i) => {
    const m = meta[sym] || {}
    const prev = m.chartPreviousClose ?? m.previousClose
    return { rank: i + 1, symbol: sym, name: m.longName || m.shortName, price: m.regularMarketPrice, percent: prev && m.regularMarketPrice ? +(((m.regularMarketPrice - prev) / prev) * 100).toFixed(2) : undefined, url: `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/` }
  })
}

/** 预设榜单。list：day_gainers 涨幅 day_losers 跌幅 most_actives 成交活跃 most_shorted_stocks 做空最多 undervalued_growth_stocks growth_technology_stocks aggressive_small_caps small_cap_gainers
 *  @example movers({ list: 'day_gainers', limit: 20 }) */
export async function movers({ list = 'day_gainers', limit = 25 } = {}) {
  const j = await get(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${list}&count=${limit}`)
  const q = j.finance?.result?.[0]?.quotes
  if (!Array.isArray(q)) throw new BxError(j.finance?.error ? 'BAD_ARGS' : 'CHANGED', `榜单取不到：${j.finance?.error?.description || list}`, '换个 list')
  return q.map((x, i) => ({ rank: i + 1, symbol: x.symbol, name: x.longName || x.shortName, price: x.regularMarketPrice, percent: x.regularMarketChangePercent != null ? +x.regularMarketChangePercent.toFixed(2) : undefined, volume: x.regularMarketVolume, marketCap: x.marketCap, pe: x.trailingPE != null ? +x.trailingPE.toFixed(2) : undefined, url: `https://finance.yahoo.com/quote/${encodeURIComponent(x.symbol)}/` }))
}
