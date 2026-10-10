/* 站点笔记（Barchart）：
 * @login none 游客就能用；但接口只认浏览器 cookie（Node 直接请求 403），所以借一个 www.barchart.com 标签在页面里 fetch
 * - 定位：美股期权。Yahoo（finance.yahoo.com options）有期权链但没有希腊值；这里有 delta / gamma / theta / vega / rho、IV Rank、Put/Call 比、异常期权成交
 * - 接口都在 www.barchart.com/proxies/core-api/v1/ 下，同源 fetch，credentials:'include'，不用另外带 CSRF 头；加 raw=1 返回原始数值（data[i].raw）
 *     行情 + 期权概况 quotes/get?symbols=A,B&fields=…（optionsImpliedVolatilityRank1y、optionsPutCallVolumeRatio、historicVolatility30d…）
 *     到期日 options-expirations/get?symbol=&fields=expirationDate,expirationType,daysToExpiration,putCallOpenInterestRatio（fields 必填）
 *     期权链 options/chain?symbol=&expirationDate=YYYY-MM-DD&fields=strikePrice,…,delta,gamma,theta,vega,rho,optionType,percentFromLast（不写日期 = 最近一期）
 *     榜单 options/get?list=options.unusual_activity.stocks.us | options.mostActive.us&orderBy=&orderDir=desc&limit=
 *     raw 的单位不统一：quotes 里 percentChange / optionsWeightedImpliedVolatility / IV 百分位是小数，IV Rank / historicVolatility30d 已经是百分数；
 *       chain 里 volatility 是百分数、percentFromLast 是小数；options/get 里 volatility 是小数。输出统一成百分数
 *       unusual_activity 只在交易日盘中 / 当天有数据，休市时是空的，这时改用 mostActive
 */

const tabOf = () => bx.tab('www.barchart.com', { open: 'https://www.barchart.com/' })

async function api(path) {
  const tab = await tabOf()
  const r = await tab.eval(
    async path => {
      const r = await fetch('/proxies/core-api/v1/' + path, { credentials: 'include' })
      return { status: r.status, body: await r.text() }
    },
    path,
  )
  if (r.status === 403 || r.status === 401) throw new BxError('BLOCKED', `Barchart 拒绝了请求（${r.status}）`, '在浏览器里打开一次 barchart.com（可能要过 Cloudflare 验证）后重试')
  if (r.status === 429) throw new BxError('BLOCKED', 'Barchart 限流了', '停一会儿再试')
  let j
  try {
    j = JSON.parse(r.body)
  } catch {
    throw new BxError('CHANGED', `Barchart 返回的不是 JSON（HTTP ${r.status}）`, path)
  }
  if (j.error) throw new BxError(r.status === 404 ? 'NOT_FOUND' : 'CHANGED', `Barchart 接口出错：${j.error.message || JSON.stringify(j.error)}`, path)
  return (j.data || []).map(x => x.raw || x)
}

const up = s => encodeURIComponent(String(s).trim().toUpperCase())
const r4 = v => (typeof v === 'number' ? +v.toFixed(4) : v ?? undefined)
const pc = v => (typeof v === 'number' ? +(v * 100).toFixed(2) : undefined) // 小数 → 百分数
const p2 = v => (typeof v === 'number' ? +v.toFixed(2) : undefined) // 本来就是百分数

/** 股票行情 + 期权概况：IV、IV Rank、30 日历史波动率、期权成交量 / 持仓、Put/Call 比
 *  @example quote('AAPL,TSLA,SPY') */
export async function quote(symbols) {
  const list = String(symbols).split(/[,\s]+/).filter(Boolean).map(up)
  const f = 'symbol,symbolName,lastPrice,priceChange,percentChange,highPrice,lowPrice,volume,tradeTime,historicVolatility30d,optionsWeightedImpliedVolatility,optionsImpliedVolatilityRank1y,optionsImpliedVolatilityPercentile1y,optionsTotalVolume,optionsTotalOpenInterest,optionsPutCallVolumeRatio,optionsPutCallOpenInterestRatio'
  const d = await api(`quotes/get?symbols=${list.join(',')}&fields=${f}&raw=1`)
  if (!d.length) throw new BxError('NOT_FOUND', `Barchart 没有这些代码：${symbols}`)
  return d.map(x => ({
    symbol: x.symbol,
    name: x.symbolName,
    price: x.lastPrice,
    change: r4(x.priceChange),
    percent: pc(x.percentChange),
    high: x.highPrice,
    low: x.lowPrice,
    volume: x.volume,
    iv: pc(x.optionsWeightedImpliedVolatility),
    ivRank: p2(x.optionsImpliedVolatilityRank1y),
    ivPercentile: pc(x.optionsImpliedVolatilityPercentile1y),
    hv30: p2(x.historicVolatility30d),
    optionsVolume: x.optionsTotalVolume,
    optionsOI: x.optionsTotalOpenInterest,
    putCallVolume: r4(x.optionsPutCallVolumeRatio),
    putCallOI: r4(x.optionsPutCallOpenInterestRatio),
    time: typeof x.tradeTime === 'number' ? new Date(x.tradeTime * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : x.tradeTime,
    url: `https://www.barchart.com/stocks/quotes/${x.symbol}/overview`,
  }))
}

/** 期权到期日列表（weekly / monthly、剩余天数、Put/Call 持仓比）
 *  @example expirations('AAPL') */
export async function expirations(symbol) {
  const d = await api(`options-expirations/get?symbol=${up(symbol)}&fields=expirationDate,expirationType,daysToExpiration,putCallOpenInterestRatio&raw=1`)
  if (!d.length) throw new BxError('NOT_FOUND', `${symbol} 没有期权`)
  return d.map(x => ({ date: x.expirationDate, type: x.expirationType, days: x.daysToExpiration, putCallOI: r4(x.putCallOpenInterestRatio) }))
}

/** 期权链 + 希腊值（delta gamma theta vega rho）+ IV。date：到期日 YYYY-MM-DD（不写 = 最近一期）；type：call / put / all；near：只要离现价最近的 N 个行权价（0 = 全部）
 *  @example options('AAPL', { near: 10 })
 *  @example options('SPY', { date: '2026-12-18', type: 'put', near: 15 }) */
export async function options(symbol, { date = '', type = 'all', near = 20 } = {}) {
  const f = 'symbol,strikePrice,bidPrice,askPrice,lastPrice,volume,openInterest,volatility,delta,gamma,theta,vega,rho,expirationDate,optionType,percentFromLast,moneyness'
  const d = await api(`options/chain?symbol=${up(symbol)}&fields=${f}&raw=1${date ? `&expirationDate=${date}` : ''}`)
  let rows = d.filter(x => type === 'all' || String(x.optionType).toLowerCase() === type)
  if (!rows.length) throw new BxError('EMPTY', `${symbol} ${date || '最近一期'} 没有期权`, '先 expirations() 看有哪些到期日')
  if (near) {
    const strikes = [...new Set(rows.map(x => x.strikePrice))].sort((a, b) => {
      const pa = Math.abs(rows.find(x => x.strikePrice === a).percentFromLast ?? 99)
      const pb = Math.abs(rows.find(x => x.strikePrice === b).percentFromLast ?? 99)
      return pa - pb
    })
    const keep = new Set(strikes.slice(0, near))
    rows = rows.filter(x => keep.has(x.strikePrice))
  }
  return rows
    .sort((a, b) => (a.optionType === b.optionType ? a.strikePrice - b.strikePrice : a.optionType < b.optionType ? -1 : 1))
    .map(x => ({
      side: String(x.optionType).toLowerCase(),
      expiration: x.expirationDate,
      strike: x.strikePrice,
      bid: x.bidPrice,
      ask: x.askPrice,
      last: x.lastPrice,
      volume: x.volume,
      openInterest: x.openInterest,
      iv: p2(x.volatility),
      delta: r4(x.delta),
      gamma: r4(x.gamma),
      theta: r4(x.theta),
      vega: r4(x.vega),
      rho: r4(x.rho),
      fromPrice: pc(x.percentFromLast),
      contract: x.symbol,
    }))
}

/** 异常期权成交（成交量 / 持仓量比最高的合约，大资金动向）。休市时没有数据，自动改用当天最活跃合约。type：call / put / all
 *  @example flow({ limit: 20 })
 *  @example flow({ type: 'put', limit: 30 }) */
export async function flow({ type = 'all', limit = 30 } = {}) {
  const f = 'baseSymbol,symbol,strikePrice,expirationDate,daysToExpiration,optionType,lastPrice,volume,openInterest,volumeOpenInterestRatio,volatility,delta,tradeTime'
  let source = 'unusual'
  const want = type === 'all' ? limit : limit * 3
  let d = await api(`options/get?list=options.unusual_activity.stocks.us&fields=${f}&orderBy=volumeOpenInterestRatio&orderDir=desc&raw=1&limit=${want}`)
  if (!d.length) {
    source = 'mostActive'
    d = await api(`options/get?list=options.mostActive.us&fields=${f}&orderBy=volume&orderDir=desc&raw=1&limit=${want}`)
  }
  if (type !== 'all') d = d.filter(x => String(x.optionType).toLowerCase() === type)
  if (!d.length) throw new BxError('EMPTY', '没有期权成交数据')
  if (source !== 'unusual') bx.log('⚠ 现在没有异常期权数据（休市？），改用当天最活跃的合约')
  return d.slice(0, limit).map((x, i) => ({
    rank: i + 1,
    source,
    symbol: x.baseSymbol,
    side: String(x.optionType).toLowerCase(),
    strike: x.strikePrice,
    expiration: x.expirationDate,
    days: x.daysToExpiration,
    last: x.lastPrice,
    volume: x.volume,
    openInterest: x.openInterest,
    volOi: r4(x.volumeOpenInterestRatio),
    iv: pc(x.volatility),
    delta: r4(x.delta),
    contract: x.symbol,
    url: `https://www.barchart.com/stocks/quotes/${x.baseSymbol}/options`,
  }))
}
