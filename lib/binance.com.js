/* 站点笔记（币安 Binance，全球最大的加密货币交易所，只取公开行情）：
 * - 现货行情走 data-api.binance.vision（币安专门给公开行情数据开的域名，不用 key；api.binance.com 也行，但部分地区会被拒）
 *   /api/v3/ticker/24hr（不带 symbol 就是全部交易对，约 3000 个）、/ticker/price、/klines、/depth、/trades、/exchangeInfo
 * - 合约数据走 fapi.binance.com（U 本位永续）：资金费率 /fapi/v1/premiumIndex、持仓量 /fapi/v1/openInterest、
 *   持仓量历史 /futures/data/openInterestHist、多空账户比 /futures/data/globalLongShortAccountRatio（只给最近 30 天）
 * - 交易对写法：BTCUSDT；这里也接受 btc（默认补 USDT）、BTC/USDT、BTC-USDT
 * - 榜单默认只看 USDT 计价的交易对，去掉稳定币互换（USDCUSDT 这类）和杠杆代币（UP/DOWN/BULL/BEAR）；成交额太小的（默认 < 100 万 USDT）也去掉
 * - 价格、数量都是字符串，这里转成数字
 */

const SPOT = 'https://data-api.binance.vision/api/v3'
const FAPI = 'https://fapi.binance.com'

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) }).catch(e => {
    throw new BxError('BLOCKED', `连不上币安（${e.cause?.code || e.message}）`, '检查网络或代理')
  })
  if (r.status === 429 || r.status === 418) throw new BxError('BLOCKED', '币安接口限流了', '等一分钟再试')
  if (r.status === 451 || r.status === 403) throw new BxError('BLOCKED', `币安拒绝了当前地区的访问（${r.status}）`, '换个代理节点')
  const j = await r.json().catch(() => null)
  if (!r.ok) {
    if (j?.code === -1121) throw new BxError('NOT_FOUND', `没有这个交易对：${url.match(/symbol=([^&]+)/)?.[1]}`, '用 pairs 查一下，写法如 BTCUSDT')
    throw new BxError('HTTP_ERROR', `币安返回 ${r.status}：${j?.msg || ''}`)
  }
  return j
}

const STABLE = /^(USDT|USDC|FDUSD|TUSD|BUSD|DAI|USDP|USDE|USD1|EUR|EURI|AEUR|XUSD|BFUSD|RLUSD|PAXG)$/
const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR', 'BRL', 'JPY']
function sym(s) {
  const x = String(s).toUpperCase().replace(/[\/\-_ ]/g, '')
  return QUOTES.some(q => x.endsWith(q) && x.length > q.length) ? x : x + 'USDT'
}
const n = v => (v === undefined || v === null ? undefined : Number(v))
const time = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)

function ticker(t) {
  return {
    symbol: t.symbol,
    price: n(t.lastPrice),
    change: n(t.priceChangePercent),
    high: n(t.highPrice),
    low: n(t.lowPrice),
    open: n(t.openPrice),
    volume: n(t.volume),
    quoteVolume: Math.round(n(t.quoteVolume)),
    trades: t.count,
    url: `https://www.binance.com/zh-CN/trade/${t.symbol}?type=spot`,
  }
}

/** 实时行情 + 24 小时统计（涨跌幅 %、最高最低、成交量、成交额）。可以一次查多个：'btc,eth,sol'
 *  @example price('BTCUSDT')
 *  @example price('btc,eth,sol,bnb') */
export async function price(symbols) {
  const list = String(symbols).split(/[,，\s]+/).filter(Boolean).map(sym)
  const j = list.length === 1 ? [await get(`${SPOT}/ticker/24hr?symbol=${list[0]}`)] : await get(`${SPOT}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(list))}`)
  const out = j.map(ticker)
  return list.length === 1 ? out[0] : out
}

/** 全部交易对的最新价（只有价格，最快）。quote 只看某种计价币，如 USDT、BTC
 *  @example prices({ quote: 'USDT', limit: 50 }) */
export async function prices({ quote = 'USDT', limit = 100 } = {}) {
  const j = await get(`${SPOT}/ticker/price`)
  return j.filter(x => !quote || x.symbol.endsWith(quote.toUpperCase())).slice(0, limit).map(x => ({ symbol: x.symbol, price: n(x.price) }))
}

/** 交易对排行。by：volume 成交额（默认）/ gainers 涨幅 / losers 跌幅 / trades 成交笔数；
 *  quote 计价币（默认 USDT，写 '' 看全部）；minVolume 最小 24h 成交额，过滤掉没人交易的冷门币
 *  @example top({ limit: 20 })
 *  @example top({ by: 'gainers', limit: 20 }) */
export async function top({ by = 'volume', quote = 'USDT', minVolume = 1e6, limit = 20 } = {}) {
  const key = { volume: t => t.quoteVolume, gainers: t => t.change, losers: t => -t.change, trades: t => t.trades }[by]
  if (!key) throw new BxError('BAD_ARGS', 'by 只能是 volume / gainers / losers / trades')
  const q = quote.toUpperCase()
  const list = (await get(`${SPOT}/ticker/24hr`))
    .filter(t => t.count > 0 && (!q || t.symbol.endsWith(q)))
    .filter(t => {
      const base = q ? t.symbol.slice(0, -q.length) : t.symbol
      return !STABLE.test(base) && !/(UP|DOWN|BULL|BEAR)$/.test(base)
    })
    .map(ticker)
    .filter(t => t.quoteVolume >= minVolume)
  return list.sort((a, b) => key(b) - key(a)).slice(0, limit).map((t, i) => ({ rank: i + 1, ...t }))
}

/** 24 小时涨幅榜（等于 top({ by: 'gainers' })）
 *  @example gainers({ limit: 10 }) */
export async function gainers({ quote = 'USDT', minVolume = 1e6, limit = 20 } = {}) {
  return top({ by: 'gainers', quote, minVolume, limit })
}

/** 24 小时跌幅榜（等于 top({ by: 'losers' })）
 *  @example losers({ limit: 10 }) */
export async function losers({ quote = 'USDT', minVolume = 1e6, limit = 20 } = {}) {
  return top({ by: 'losers', quote, minVolume, limit })
}

const INTERVALS = ['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']

/** K 线。interval：1m 5m 15m 30m 1h 4h 1d 1w 1M 等；limit 最多 1000；时间是北京时间
 *  @example klines('BTCUSDT', { interval: '1d', limit: 30 })
 *  @example klines('eth', { interval: '4h', limit: 50 }) */
export async function klines(symbol, { interval = '1d', limit = 100 } = {}) {
  if (!INTERVALS.includes(interval)) throw new BxError('BAD_ARGS', `interval 只能是 ${INTERVALS.join(' ')}`)
  const j = await get(`${SPOT}/klines?symbol=${sym(symbol)}&interval=${interval}&limit=${Math.min(limit, 1000)}`)
  return j.map(k => ({ time: time(k[0]), open: n(k[1]), high: n(k[2]), low: n(k[3]), close: n(k[4]), volume: n(k[5]), quoteVolume: Math.round(n(k[7])), trades: k[8] }))
}

/** 盘口：买单（bids）和卖单（asks）各前 limit 档，附带买卖价差和两边挂单总量。limit：5 10 20 50 100 500 1000
 *  @example depth('BTCUSDT', { limit: 10 }) */
export async function depth(symbol, { limit = 20 } = {}) {
  const s = sym(symbol)
  const j = await get(`${SPOT}/depth?symbol=${s}&limit=${limit}`)
  const side = a => a.map(([p, q]) => ({ price: n(p), qty: n(q) }))
  const bids = side(j.bids), asks = side(j.asks)
  const sum = a => a.reduce((x, y) => x + y.qty, 0)
  return {
    symbol: s,
    bestBid: bids[0]?.price,
    bestAsk: asks[0]?.price,
    spread: asks[0] && bids[0] ? +(asks[0].price - bids[0].price).toPrecision(6) : undefined,
    bidQty: +sum(bids).toFixed(6),
    askQty: +sum(asks).toFixed(6),
    bids,
    asks,
  }
}

/** 最近的成交明细（时间、价格、数量、主动买还是主动卖）
 *  @example trades('BTCUSDT', { limit: 20 }) */
export async function trades(symbol, { limit = 50 } = {}) {
  const j = await get(`${SPOT}/trades?symbol=${sym(symbol)}&limit=${Math.min(limit, 1000)}`)
  return j.reverse().map(t => ({ time: new Date(t.time).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }), price: n(t.price), qty: n(t.qty), value: +(n(t.price) * n(t.qty)).toFixed(2), side: t.isBuyerMaker ? '卖' : '买' }))
}

/** 交易对列表（正在交易的）。q 按币名筛，如 'sol'；quote 只看某种计价币
 *  @example pairs({ q: 'sol' })
 *  @example pairs({ quote: 'USDT', limit: 50 }) */
export async function pairs({ q = '', quote = '', limit = 100 } = {}) {
  const j = await get(`${SPOT}/exchangeInfo?permissions=SPOT&symbolStatus=TRADING`)
  const Q = q.toUpperCase(), QU = quote.toUpperCase()
  const list = (j.symbols || []).filter(s => (!Q || s.baseAsset.includes(Q)) && (!QU || s.quoteAsset === QU))
  if (!list.length) throw new BxError('EMPTY', `没有匹配 ${q || quote} 的交易对`)
  return list.slice(0, limit).map(s => ({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset }))
}

/** 永续合约数据：标记价、资金费率（正数 = 多头付钱给空头，说明做多的人多）、持仓量和近几天变化、多空账户比。
 *  合约情绪指标，看市场是不是过热。days 看最近几天的持仓量和多空比（最多 30）
 *  @example futures('BTCUSDT')
 *  @example futures('eth', { days: 14 }) */
export async function futures(symbol, { days = 7 } = {}) {
  const s = sym(symbol)
  const d = Math.min(days, 30)
  const [p, oi, hist, ls] = await Promise.all([
    get(`${FAPI}/fapi/v1/premiumIndex?symbol=${s}`),
    get(`${FAPI}/fapi/v1/openInterest?symbol=${s}`),
    get(`${FAPI}/futures/data/openInterestHist?symbol=${s}&period=1d&limit=${d}`),
    get(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${s}&period=1d&limit=${d}`),
  ])
  const lsBy = new Map(ls.map(x => [x.timestamp, x]))
  return {
    symbol: s,
    markPrice: n(p.markPrice),
    indexPrice: n(p.indexPrice),
    fundingRate: `${(n(p.lastFundingRate) * 100).toFixed(4)}%`,
    nextFunding: time(p.nextFundingTime),
    openInterest: n(oi.openInterest),
    openInterestUsd: Math.round(n(oi.openInterest) * n(p.markPrice)),
    history: hist.map(h => ({
      date: time(h.timestamp).slice(0, 10),
      openInterest: n(h.sumOpenInterest),
      openInterestUsd: Math.round(n(h.sumOpenInterestValue)),
      longShortRatio: n(lsBy.get(h.timestamp)?.longShortRatio),
      longAccount: lsBy.get(h.timestamp) ? `${(n(lsBy.get(h.timestamp).longAccount) * 100).toFixed(1)}%` : undefined,
    })),
  }
}
