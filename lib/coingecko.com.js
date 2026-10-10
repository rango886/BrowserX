/* 站点笔记（CoinGecko，加密货币全市场行情聚合，汇总几百家交易所的数据）：
 * - 免费公开接口 api.coingecko.com/api/v3，不用 key。限流很紧（大约每分钟 5～15 次，超了返回 429），
 *   这里所有请求排队串行，遇到 429 等 15 / 30 / 45 秒重试三次；批量查时尽量用一次 top / prices 拿多个币
 *   有 Demo key 的话设环境变量 COINGECKO_API_KEY（走 x-cg-demo-api-key 请求头，限额高很多）
 * - 币的 id 是小写英文（bitcoin、ethereum、solana），不是代码 BTC；这里传代码或名字时会先用 /search 换成 id
 *   排行 /coins/markets?vs_currency=usd&order=market_cap_desc&category=&price_change_percentage=1h,24h,7d,30d
 *   单币 /coins/<id>（社区、开发者数据关掉）；历史 /coins/<id>/market_chart?days=&interval=daily
 *   板块 /coins/categories（id 可以给 markets 的 category 用，如 artificial-intelligence、meme-token、layer-1）
 *   全市场 /global（总市值、BTC 占比）；热搜 /search/trending（按 CoinGecko 上的搜索量）
 *   交易所 /exchanges；合约市场 /derivatives（各交易所永续合约的资金费率、持仓量）
 */

const API = 'https://api.coingecko.com/api/v3'

let chain = Promise.resolve()
function get(path) {
  const run = async () => {
    const headers = { accept: 'application/json' }
    if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY
    for (let i = 0; ; i++) {
      const r = await fetch(API + path, { headers, signal: AbortSignal.timeout(30000) }).catch(e => {
        throw new BxError('BLOCKED', `连不上 CoinGecko（${e.cause?.code || e.message}）`, '检查网络或代理')
      })
      if (r.status === 429 && i < 3) {
        await bx.sleep(15000 * (i + 1))
        continue
      }
      if (r.status === 429) throw new BxError('BLOCKED', 'CoinGecko 限流了（免费接口每分钟只能请求几次）', '等一两分钟再试，或者设置环境变量 COINGECKO_API_KEY')
      if (r.status === 404) throw new BxError('NOT_FOUND', `CoinGecko 没有：${path}`, '币的 id 是小写英文全名，如 bitcoin；可以先用 search 查')
      if (!r.ok) throw new BxError('HTTP_ERROR', `CoinGecko 返回 ${r.status}`)
      return r.json()
    }
  }
  const p = chain.then(run, run)
  chain = p.then(() => bx.sleep(1200), () => bx.sleep(1200))
  return p
}

const COMMON = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', bnb: 'binancecoin', xrp: 'ripple', doge: 'dogecoin', ada: 'cardano', trx: 'tron', usdt: 'tether', usdc: 'usd-coin', ton: 'the-open-network', avax: 'avalanche-2', link: 'chainlink', dot: 'polkadot', ltc: 'litecoin', sui: 'sui' }
/** 代码 / 名字 → CoinGecko id */
async function coinId(s) {
  const x = String(s).trim().toLowerCase()
  if (COMMON[x]) return COMMON[x]
  const j = await get(`/search?query=${encodeURIComponent(x)}`)
  const c = j.coins?.find(c => c.symbol.toLowerCase() === x || c.id === x || c.name.toLowerCase() === x) || j.coins?.[0]
  if (!c) throw new BxError('NOT_FOUND', `CoinGecko 上找不到 ${s}`, '用 search 查一下准确名字')
  return c.id
}

const pct = v => (v === undefined || v === null ? undefined : +v.toFixed(2))

function market(c, i) {
  return {
    rank: c.market_cap_rank ?? i + 1,
    id: c.id,
    symbol: c.symbol?.toUpperCase(),
    name: c.name,
    price: c.current_price,
    change1h: pct(c.price_change_percentage_1h_in_currency),
    change24h: pct(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
    change7d: pct(c.price_change_percentage_7d_in_currency),
    change30d: pct(c.price_change_percentage_30d_in_currency),
    marketCap: c.market_cap,
    volume: c.total_volume,
    fdv: c.fully_diluted_valuation || undefined,
    ath: c.ath,
    fromAth: pct(c.ath_change_percentage),
    url: `https://www.coingecko.com/zh/coins/${c.id}`,
  }
}

/** 按市值排行（涨跌幅是 %）。category 只看某个板块，如 artificial-intelligence、meme-token、layer-1、real-world-assets-rwa（id 见 categories）；
 *  ids 只看指定的几个币（'bitcoin,ethereum'）；currency 计价：usd / cny / eur …；sort：market_cap / volume
 *  @example top({ limit: 20 })
 *  @example top({ category: 'artificial-intelligence', limit: 10 })
 *  @example top({ ids: 'bitcoin,ethereum,solana', currency: 'cny' }) */
export async function top({ limit = 50, page = 1, category = '', ids = '', currency = 'usd', sort = 'market_cap' } = {}) {
  let q = `/coins/markets?vs_currency=${currency}&order=${sort}_desc&per_page=${Math.min(limit, 250)}&page=${page}&price_change_percentage=1h,24h,7d,30d`
  if (category) q += `&category=${encodeURIComponent(category)}`
  if (ids) q += `&ids=${encodeURIComponent(ids)}`
  const j = await get(q)
  if (!j.length) throw new BxError('EMPTY', '没有结果', category ? '板块 id 用 categories 查' : '')
  return j.map(market)
}

/** 单个币的详情：价格、各周期涨跌、市值和完全稀释估值、流通量 / 总量 / 上限、历史最高最低、所属板块、官网和白皮书、简介。
 *  id 可以是 CoinGecko id（bitcoin）、代码（BTC）或名字
 *  @example coin('bitcoin')
 *  @example coin('SOL', { currency: 'cny' }) */
export async function coin(id, { currency = 'usd' } = {}) {
  const cid = await coinId(id)
  const c = await get(`/coins/${cid}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`)
  const m = c.market_data || {}
  const cur = v => v?.[currency]
  const desc = (c.description?.zh || c.description?.en || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return {
    id: c.id,
    symbol: c.symbol?.toUpperCase(),
    name: c.name,
    rank: c.market_cap_rank,
    price: cur(m.current_price),
    change24h: pct(m.price_change_percentage_24h),
    change7d: pct(m.price_change_percentage_7d),
    change30d: pct(m.price_change_percentage_30d),
    change1y: pct(m.price_change_percentage_1y),
    marketCap: cur(m.market_cap),
    fdv: cur(m.fully_diluted_valuation),
    volume: cur(m.total_volume),
    tvl: cur(m.total_value_locked) || undefined,
    circulating: m.circulating_supply,
    total: m.total_supply,
    max: m.max_supply ?? (m.max_supply_infinite ? '无上限' : undefined),
    ath: cur(m.ath),
    athDate: cur(m.ath_date)?.slice(0, 10),
    fromAth: pct(cur(m.ath_change_percentage)),
    atl: cur(m.atl),
    atlDate: cur(m.atl_date)?.slice(0, 10),
    categories: c.categories?.filter(Boolean).join(', '),
    chain: c.asset_platform_id || undefined,
    genesis: c.genesis_date || undefined,
    homepage: c.links?.homepage?.find(Boolean),
    whitepaper: c.links?.whitepaper || undefined,
    github: c.links?.repos_url?.github?.find(Boolean),
    twitter: c.links?.twitter_screen_name ? `https://x.com/${c.links.twitter_screen_name}` : undefined,
    sentimentUp: c.sentiment_votes_up_percentage ? `${c.sentiment_votes_up_percentage}%` : undefined,
    description: desc.length > 800 ? desc.slice(0, 800) + '…' : desc || undefined,
    url: `https://www.coingecko.com/zh/coins/${c.id}`,
  }
}

/** 价格 / 市值 / 成交额的历史走势（按天）。days：7 / 30 / 90 / 365（免费接口最多 365 天）
 *  @example history('bitcoin', { days: 30 }) */
export async function history(id, { days = 30, currency = 'usd' } = {}) {
  const cid = await coinId(id)
  const j = await get(`/coins/${cid}/market_chart?vs_currency=${currency}&days=${Math.min(days, 365)}&interval=daily`)
  const caps = new Map(j.market_caps.map(([t, v]) => [t, v]))
  const vols = new Map(j.total_volumes.map(([t, v]) => [t, v]))
  return j.prices.map(([t, p]) => ({ date: new Date(t).toISOString().slice(0, 10), price: +p.toPrecision(8), marketCap: Math.round(caps.get(t) || 0) || undefined, volume: Math.round(vols.get(t) || 0) || undefined }))
}

/** 按名字或代码搜币，拿到 CoinGecko id（给 coin / history 用）
 *  @example search('pepe') */
export async function search(q, { limit = 10 } = {}) {
  const j = await get(`/search?query=${encodeURIComponent(q)}`)
  if (!j.coins?.length) throw new BxError('EMPTY', `没搜到 ${q}`)
  return j.coins.slice(0, limit).map(c => ({ id: c.id, symbol: c.symbol, name: c.name, rank: c.market_cap_rank, url: `https://www.coingecko.com/zh/coins/${c.id}` }))
}

/** 热搜币和热门板块（按 CoinGecko 用户最近 24 小时的搜索量，看散户在关注什么）
 *  @example trending() */
export async function trending() {
  const j = await get('/search/trending')
  const coins = (j.coins || []).map((x, i) => {
    const c = x.item
    return { rank: i + 1, type: 'coin', id: c.id, symbol: c.symbol, name: c.name, marketCapRank: c.market_cap_rank, price: c.data?.price ? +Number(c.data.price).toPrecision(6) : undefined, change24h: pct(c.data?.price_change_percentage_24h?.usd), marketCap: c.data?.market_cap, url: `https://www.coingecko.com/zh/coins/${c.id}` }
  })
  const cats = (j.categories || []).map((c, i) => ({ rank: i + 1, type: 'category', id: c.slug, name: c.name, change24h: pct(c.data?.market_cap_change_percentage_24h?.usd), marketCap: c.data?.market_cap, url: `https://www.coingecko.com/zh/categories/${c.slug}` }))
  return [...coins, ...cats]
}

/** 全市场概况：总市值和 24h 变化、总成交额、BTC / ETH 市值占比、币的数量
 *  @example global() */
export async function global({ currency = 'usd' } = {}) {
  const d = (await get('/global')).data
  const dom = Object.entries(d.market_cap_percentage || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
  return {
    marketCap: Math.round(d.total_market_cap?.[currency]),
    change24h: pct(d.market_cap_change_percentage_24h_usd),
    volume: Math.round(d.total_volume?.[currency]),
    btcDominance: `${d.market_cap_percentage?.btc?.toFixed(2)}%`,
    ethDominance: `${d.market_cap_percentage?.eth?.toFixed(2)}%`,
    dominance: Object.fromEntries(dom.map(([k, v]) => [k.toUpperCase(), `${v.toFixed(2)}%`])),
    coins: d.active_cryptocurrencies,
    markets: d.markets,
    updated: new Date(d.updated_at * 1000).toISOString().slice(0, 16).replace('T', ' '),
  }
}

/** 板块排行（AI、Meme、Layer 1、RWA …），看资金在往哪个方向走。sort：market_cap / change（24h 市值变化）
 *  id 可以给 top({ category }) 用
 *  @example categories({ limit: 20 })
 *  @example categories({ sort: 'change', limit: 20 }) */
export async function categories({ sort = 'market_cap', limit = 30 } = {}) {
  const order = { market_cap: 'market_cap_desc', change: 'market_cap_change_24h_desc' }[sort]
  if (!order) throw new BxError('BAD_ARGS', 'sort 只能是 market_cap / change')
  const j = await get(`/coins/categories?order=${order}`)
  return j.filter(c => c.market_cap).slice(0, limit).map((c, i) => ({ rank: i + 1, id: c.id, name: c.name, marketCap: Math.round(c.market_cap), change24h: pct(c.market_cap_change_24h), volume: Math.round(c.volume_24h || 0) || undefined, top3: c.top_3_coins_id?.join(', '), url: `https://www.coingecko.com/zh/categories/${c.id}` }))
}

/** 交易所排行（按 24h 成交额，单位 BTC；trustScore 是 CoinGecko 的信任评分 1～10）
 *  @example exchanges({ limit: 20 }) */
export async function exchanges({ limit = 30, page = 1 } = {}) {
  const j = await get(`/exchanges?per_page=${Math.min(limit, 250)}&page=${page}`)
  return j.map((e, i) => ({ rank: (page - 1) * limit + i + 1, id: e.id, name: e.name, country: e.country || undefined, year: e.year_established || undefined, trustScore: e.trust_score, volumeBtc: Math.round(e.trade_volume_24h_btc), url: e.url }))
}

/** 各交易所的合约市场：价格、基差、资金费率、持仓量、成交额。symbol 筛选，如 'BTC'
 *  @example derivatives({ symbol: 'BTC', limit: 20 }) */
export async function derivatives({ symbol = '', limit = 30 } = {}) {
  const j = await get('/derivatives')
  const s = symbol.toUpperCase()
  const list = j.filter(d => !s || d.symbol?.toUpperCase().includes(s) || d.index_id?.toUpperCase() === s).sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0))
  if (!list.length) throw new BxError('EMPTY', `没有 ${symbol} 的合约市场`)
  return list.slice(0, limit).map((d, i) => ({
    rank: i + 1,
    market: d.market,
    symbol: d.symbol,
    type: d.contract_type,
    price: Number(d.price),
    change24h: pct(d.price_percentage_change_24h),
    basis: pct(d.basis),
    fundingRate: d.funding_rate !== null && d.funding_rate !== undefined ? `${d.funding_rate.toFixed(4)}%` : undefined,
    openInterest: Math.round(d.open_interest || 0) || undefined,
    volume: Math.round(d.volume_24h || 0) || undefined,
  }))
}
