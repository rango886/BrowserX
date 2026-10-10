/* 站点笔记（通达信热榜）：
 * @login none 公开接口，Node 里直接 POST，不用开页面
 * - 页面 pul.tdx.com.cn/site/app/gzhbd/tdx-topsearch/page-main.html；页面配置在 …/pagejson/page_*.js，里面写着每个榜单调哪个函数、传什么参数
 * - 接口 POST https://pul.tdx.com.cn/TQLEX?Entry=JNLPSE.<函数>&RI=，body 是 JSON 数组 [{参数}]
 *     hotStockList {listType: 0 人气榜 / 1 关注榜 / 2 热搜榜, cycle: 0 最新 / 1 30 分钟 / 2 60 分钟}（100 条，翻页参数没找到）
 *     changeStockList {changeType: 0 上升最快 / 1 下降最快}
 *     bkList {subType: 1 概念 / 0 行业}（20 条）
 *     expandList {categoryType: 2 ETF / 3 可转债 / 11 期货 / 12 港股 / 13 美股}
 * - 返回是表格：[ [状态, 错误, 行数…], [列名…], [], 行1, 行2… ]；gnbk 是 JSON 字符串（所属概念）
 * - market：1 上海 0 深圳（北交所也是 0）
 */

async function call(fn, data) {
  let r
  try {
    r = await fetch(`https://pul.tdx.com.cn/TQLEX?Entry=JNLPSE.${fn}&RI=`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36', Referer: 'https://pul.tdx.com.cn/site/app/gzhbd/tdx-topsearch/page-main.html' },
      body: JSON.stringify([data]),
    })
  } catch (e) {
    throw new BxError('HTTP_ERROR', `通达信接口连不上：${e.cause?.code || e.message}`, '稍后重试')
  }
  if (!r.ok) throw new BxError('HTTP_ERROR', `通达信接口 HTTP ${r.status}`)
  let j
  try {
    j = JSON.parse(await r.text())
  } catch {
    throw new BxError('CHANGED', '通达信接口返回的不是 JSON', '去修 tdx.com.cn')
  }
  if (!Array.isArray(j) || !Array.isArray(j[1])) throw new BxError('CHANGED', '通达信接口的返回结构变了', '去修 tdx.com.cn')
  if (j[0]?.[0] !== 0) throw new BxError('HTTP_ERROR', `通达信接口出错：${j[0]?.[1] || j[0]?.[0]}`)
  const cols = j[1]
  return j.slice(3).map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])))
}

const concepts = s => {
  try {
    return JSON.parse(s || '[]').map(x => x.name).join(',') || undefined
  } catch {
    return undefined
  }
}
const nn = v => (v === '' || v == null ? undefined : +v)
const stock = (x, i) => ({
  rank: nn(x.ranking ?? x.nowRanking) ?? i + 1,
  code: x.sec_code,
  name: x.stock_name,
  price: nn(x.now_price),
  percent: nn(x.chg),
  heat: nn(x.totalCount ?? x.nowTotal),
  concepts: concepts(x.gnbk),
  reason: x.reason || undefined,
  riseDays: x.riseDay || undefined,
  billboard: x.lhb || undefined,
  url: `https://quote.eastmoney.com/${x.market === '1' ? 'sh' : /^[48]|^92/.test(x.sec_code) ? 'bj' : 'sz'}${x.sec_code}.html`,
})

const LIST = { popular: '0', follow: '1', search: '2' }
const CYCLE = { now: '0', '30m': '1', '60m': '2' }

/** 通达信热股榜（A 股，100 条）。type：popular 人气榜 / follow 关注榜 / search 热搜榜；cycle：now 最新 / 30m / 60m
 *  @example hot({ limit: 20 })
 *  @example hot({ type: 'search', cycle: '60m' }) */
export async function hot({ type = 'popular', cycle = 'now', limit = 50 } = {}) {
  const rows = await call('hotStockList', { listType: LIST[type] ?? String(type), cycle: CYCLE[cycle] ?? String(cycle) })
  if (!rows.length) throw new BxError('EMPTY', '通达信热股榜是空的')
  return rows.slice(0, limit).map(stock)
}

/** 人气排名变化最快的股票。direction：up 上升 / down 下降
 *  @example movers({ direction: 'up', limit: 20 }) */
export async function movers({ direction = 'up', limit = 50 } = {}) {
  const rows = await call('changeStockList', { changeType: direction === 'down' ? '1' : '0' })
  if (!rows.length) throw new BxError('EMPTY', '没有数据')
  return rows.slice(0, limit).map((x, i) => ({ ...stock(x, i), rank: i + 1, popularRank: nn(x.nowRanking), lastRank: nn(x.lastRanking), rankChange: nn(x.changeCount) }))
}

/** 热门板块。type：concept 概念 / industry 行业（各 20 个）
 *  @example boards({ type: 'industry' }) */
export async function boards({ type = 'concept', limit = 20 } = {}) {
  const rows = await call('bkList', { subType: type === 'industry' ? '0' : '1' })
  if (!rows.length) throw new BxError('EMPTY', '没有数据')
  return rows.slice(0, limit).map((x, i) => ({ rank: nn(x.nowRanking) ?? i + 1, code: x.sec_code, name: x.stock_name, price: nn(x.now_price), percent: nn(x.chg), heat: nn(x.nowTotal), lastRank: nn(x.lastRanking), days: x.listDay || undefined }))
}

const CAT = { etf: '2', bond: '3', futures: '11', hk: '12', us: '13' }

/** 其他品种的人气榜。category：etf / bond 可转债 / futures 期货 / hk 港股 / us 美股
 *  @example others({ category: 'etf', limit: 20 })
 *  @example others({ category: 'us' }) */
export async function others({ category = 'etf', limit = 50 } = {}) {
  const t = CAT[category]
  if (!t) throw new BxError('BAD_ARGS', `category 只能是 ${Object.keys(CAT).join(' / ')}`)
  const rows = await call('expandList', { categoryType: t })
  if (!rows.length) throw new BxError('EMPTY', '没有数据')
  return rows.slice(0, limit).map((x, i) => ({ rank: nn(x.nowRanking) ?? i + 1, code: x.sec_code, name: x.stock_name, price: nn(x.now_price), percent: nn(x.chg), heat: nn(x.nowTotal), lastRank: nn(x.lastRanking) }))
}
