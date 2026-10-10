/* 站点笔记（同花顺）：
 * @login none 公开接口，Node 里直接 fetch
 * - 热榜接口 dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/（要带 Referer: https://eq.10jqka.com.cn/）
 *     个股 stock?stock_type=a&type=hour|day&list_type=normal|skyrocket（normal 大家都在看 / skyrocket 快速飙升），只有 A 股，一次最多 100 条
 *     板块 plate?type=concept|industry，一次 20 条，带对应的 ETF
 * - 字段：rate 热度值，rise_and_fall 涨跌幅%，hot_rank_chg 排名变化，tag.concept_tag 概念，tag.popularity_tag 人气标签（如“3天2板”）
 *   market：17 上交所 33 深交所 151 北交所
 */

const BASE = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/'

async function get(path) {
  let r
  try {
    r = await fetch(BASE + path, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36', Referer: 'https://eq.10jqka.com.cn/', Accept: 'application/json' } })
  } catch (e) {
    throw new BxError('HTTP_ERROR', `同花顺接口连不上：${e.cause?.code || e.message}`, '稍后重试')
  }
  if (!r.ok) throw new BxError(r.status === 403 ? 'BLOCKED' : 'HTTP_ERROR', `同花顺接口 HTTP ${r.status}`)
  const j = await r.json().catch(() => null)
  if (!j || j.status_code !== 0) throw new BxError('CHANGED', `同花顺热榜接口出错：${j?.status_msg || '返回的不是 JSON'}`, '去修 10jqka.com.cn')
  return j.data
}

const MKT = { 17: 'SH', 33: 'SZ', 151: 'BJ' }

/** 同花顺热股榜（A 股）。period：hour 1 小时 / day 24 小时；type：normal 大家都在看 / skyrocket 快速飙升
 *  @example hot({ limit: 20 })
 *  @example hot({ type: 'skyrocket', period: 'day' }) */
export async function hot({ period = 'hour', type = 'normal', limit = 50 } = {}) {
  const d = await get(`stock?stock_type=a&type=${period}&list_type=${type}`)
  const list = d?.stock_list || []
  if (!list.length) throw new BxError('EMPTY', '同花顺热股榜是空的')
  return list.slice(0, limit).map((x, i) => ({
    rank: x.order ?? i + 1,
    code: x.code,
    name: x.name,
    percent: x.rise_and_fall != null ? +(+x.rise_and_fall).toFixed(2) : undefined,
    heat: +x.rate,
    rankChange: x.hot_rank_chg || undefined,
    concepts: [x.tag?.concept_tag].flat().filter(Boolean).join(',') || undefined,
    tags: [x.tag?.popularity_tag].flat().filter(Boolean).join(',') || undefined,
    topic: x.topic?.title || undefined,
    url: `https://stockpage.10jqka.com.cn/${x.code}/`,
    symbol: (MKT[x.market] || '') + x.code,
  }))
}

/** 同花顺热门板块。type：concept 概念 / industry 行业（各 20 个，带跟踪的 ETF）
 *  @example hotBoards({ type: 'concept' }) */
export async function hotBoards({ type = 'concept', limit = 20 } = {}) {
  const d = await get(`plate?type=${type}`)
  const list = d?.plate_list || []
  if (!list.length) throw new BxError('EMPTY', '同花顺热门板块是空的')
  return list.slice(0, limit).map((x, i) => ({
    rank: x.order ?? i + 1,
    code: x.code,
    name: x.name,
    percent: x.rise_and_fall != null ? +(+x.rise_and_fall).toFixed(2) : undefined,
    heat: +x.rate,
    rankChange: x.hot_rank_chg || undefined,
    note: [x.tag, x.hot_tag].filter(Boolean).join('，') || undefined,
    etf: x.etf_name ? `${x.etf_name}(${x.etf_product_id}) ${x.etf_rise_and_fall != null ? (+x.etf_rise_and_fall).toFixed(2) + '%' : ''}`.trim() : undefined,
    url: `https://q.10jqka.com.cn/gn/detail/code/${x.code}/`,
  }))
}
