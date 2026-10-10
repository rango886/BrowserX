/* 站点笔记（新浪财经）：
 * @login none 全是公开接口，Node 里直接 fetch，不用开标签
 * - 定位：滚动新闻、7x24 直播、A 股涨跌排行（东方财富被限流时的备用），以及期货 / 外汇 / 全球指数 / 港美股的实时报价（东方财富、雪球不方便取的那些）
 * - 滚动新闻 feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=频道&num=&page=
 *     lid：2509 全部 2516 财经 2517 股市 2518 国际 / 美股 2515 科技 2510 国内 2511 国际新闻。k 参数不起作用，关键词只能取回来自己过滤
 * - 7x24 直播 zhibo.sina.com.cn/api/zhibo/feed?zhibo_id=152&page=&page_size=&tag_id=0（tag_id：0 全部，其余见 tag 字段）
 * - 实时报价 hq.sinajs.cn/list=代码1,代码2（一定要带 Referer: https://finance.sina.com.cn/，返回 GBK 编码的 var hq_str_xxx="…"）
 *     A 股 sh600519 / sz000001 / bj920157   指数 sh000001 sz399001 sh000300
 *     港股 hk00700 / rt_hkHSI（恒生指数）       美股 gb_aapl / gb_$dji gb_$ixic gb_$inx
 *     国内期货连续 nf_AU0 黄金 nf_RB0 螺纹 nf_SC0 原油；股指期货 CFF_RE_IF0 / IC0 / IM0
 *     外盘期货 hf_GC 纽约金 hf_SI 白银 hf_CL 纽约原油 hf_OIL 布伦特 hf_HG 铜
 *     外汇 fx_susdcny 美元人民币 fx_seurusd 欧元美元 fx_susdjpy；美元指数 DINIW
 *     全球指数 b_NKY 日经 b_SPX 标普 b_UKX 富时 b_DAX；比特币 btc_btcbtcusd
 *   每种前缀的字段顺序都不一样，解析见下面的 PARSE；不认识的前缀原样给 raw
 * - 代码联想 suggest3.sinajs.cn/suggest/type=&key=（GBK）
 * - 涨跌排行 vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?node=hs_a&sort=changepercent&asc=0&page=&num=80
 *     （GBK；mktcap / nmc 单位是万元；node：hs_a sh_a sz_a cyb kcb hs_bjs etf_hq_fund hskzz_z）
 */

const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', Referer: 'https://finance.sina.com.cn/' }

async function get(url, enc = 'utf-8') {
  let r
  try {
    r = await fetch(url, { headers: H })
  } catch (e) {
    throw new BxError('HTTP_ERROR', `新浪接口连不上：${e.cause?.code || e.message}`, '稍后重试')
  }
  if (!r.ok) throw new BxError(r.status === 403 || r.status === 456 ? 'BLOCKED' : 'HTTP_ERROR', `新浪接口 HTTP ${r.status}`, '停一会儿再试')
  return new TextDecoder(enc).decode(await r.arrayBuffer())
}
const json = async url => {
  const t = await get(url)
  try {
    return JSON.parse(t)
  } catch {
    throw new BxError('CHANGED', '新浪接口返回的不是 JSON', url)
  }
}
const ts = s => (s ? new Date(+s * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : undefined)
const kw = q => (q ? new RegExp(q.replace(/[.*+?^${}()[\]\\]/g, '\\$&').split(/\s+/).join('|'), 'i') : null)

const LID = { all: 2509, finance: 2516, stock: 2517, world: 2518, tech: 2515, china: 2510, intl: 2511 }

/** 滚动新闻（最新在前）。channel：all finance 财经 stock 股市 world 国际/美股 tech 科技 china 国内 intl 国际；q 按标题 / 摘要过滤
 *  @example news({ channel: 'stock', limit: 30 })
 *  @example news({ q: '黄金 原油', limit: 20 }) */
export async function news({ channel = 'finance', q = '', limit = 30 } = {}) {
  const lid = LID[channel] || Number(channel)
  if (!lid) throw new BxError('BAD_ARGS', `channel 只能是 ${Object.keys(LID).join(' / ')}`)
  const re = kw(q)
  const out = []
  for (let page = 1; out.length < limit && page <= (re ? 20 : 10); page++) {
    const j = await json(`https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=${lid}&k=&num=50&page=${page}`)
    const d = j.result?.data
    if (!Array.isArray(d)) throw new BxError('CHANGED', '滚动新闻接口的返回结构变了', '去修 news')
    for (const x of d) {
      if (re && !re.test(x.title + (x.intro || '') + (x.keywords || ''))) continue
      if (out.some(o => o.url === x.url)) continue
      out.push({ time: ts(x.ctime), title: x.title, intro: x.intro || undefined, media: x.media_name || undefined, keywords: x.keywords || undefined, url: x.url })
    }
    if (!d.length) break
  }
  if (!out.length) throw new BxError('EMPTY', q ? `最近的新闻里没有 ${q}` : '没有新闻', '换个关键词或频道')
  return out.slice(0, limit)
}

/** 7x24 财经直播（快讯，最新在前）。q 按内容过滤
 *  @example live({ limit: 50 })
 *  @example live({ q: '美联储', limit: 10 }) */
export async function live({ q = '', limit = 50 } = {}) {
  const re = kw(q)
  const out = []
  for (let page = 1; out.length < limit && page <= (re ? 30 : 10); page++) {
    const j = await json(`https://zhibo.sina.com.cn/api/zhibo/feed?zhibo_id=152&page=${page}&page_size=50&tag_id=0&dire=f&dpc=1`)
    const list = j.result?.data?.feed?.list
    if (!Array.isArray(list)) throw new BxError('CHANGED', '7x24 接口的返回结构变了', '去修 live')
    for (const x of list) {
      const text = String(x.rich_text || '').replace(/<[^>]+>/g, '').trim()
      if (re && !re.test(text)) continue
      let ext = {}
      try {
        ext = JSON.parse(x.ext || '{}')
      } catch {}
      out.push({ time: x.create_time?.slice(0, 16), text, tags: x.tag?.map(t => t.name).join(',') || undefined, stocks: ext.stocks?.map(s => s.symbol || s.key).filter(Boolean).join(',') || undefined, url: ext.docurl || x.docurl })
    }
    if (!list.length) break
  }
  if (!out.length) throw new BxError('EMPTY', q ? `最近的直播里没有 ${q}` : '没有直播内容', '换个关键词')
  return out.slice(0, limit)
}

const n = v => (v === '' || v == null || isNaN(+v) ? undefined : +v)
const pct = (p, c) => (p && c ? +(((p - c) / c) * 100).toFixed(2) : undefined)

/** 每种前缀的字段顺序。返回 { name, price, change, percent, open, high, low, lastClose, volume, amount, time } */
const PARSE = [
  [/^(sh|sz|bj)\d+$/, f => ({ name: f[0], open: n(f[1]), lastClose: n(f[2]), price: n(f[3]), high: n(f[4]), low: n(f[5]), volume: n(f[8]), amount: n(f[9]), time: `${f[30]} ${f[31]}` })],
  [/^s_(sh|sz)\d+$/, f => ({ name: f[0], price: n(f[1]), change: n(f[2]), percent: n(f[3]), volume: n(f[4]), amount: n(f[5]) })],
  [/^gb_/, f => ({ name: f[0], price: n(f[1]), percent: n(f[2]), change: n(f[4]), open: n(f[5]), high: n(f[6]), low: n(f[7]), high52w: n(f[8]), low52w: n(f[9]), volume: n(f[10]), marketCap: n(f[12]) || undefined, pe: n(f[14]), lastClose: n(f[26]), time: f[3] })],
  [/^(rt_)?hk/, f => ({ name: f[1], enName: f[0], open: n(f[2]), lastClose: n(f[3]), high: n(f[4]), low: n(f[5]), price: n(f[6]), change: n(f[7]), percent: n(f[8]), amount: n(f[11]), volume: n(f[12]), high52w: n(f[15]), low52w: n(f[16]), time: `${f[17]} ${f[18]}` })],
  [/^nf_/, f => ({ name: f[0], open: n(f[2]), high: n(f[3]), low: n(f[4]), price: n(f[8]), lastSettle: n(f[10]), position: n(f[13]), volume: n(f[14]), exchange: f[15], time: f[17] })],
  [/^CFF_RE_/, f => ({ name: f.at(-1), open: n(f[0]), high: n(f[1]), low: n(f[2]), price: n(f[3]), volume: n(f[4]), amount: n(f[5]), position: n(f[6]), time: `${f[36]} ${f[37]}`, lastSettle: n(f[13]) })],
  [/^hf_/, f => ({ name: f[13], price: n(f[0]), high: n(f[4]), low: n(f[5]), lastClose: n(f[7]), open: n(f[8]), time: `${f[12]} ${f[6]}` })],
  [/^fx_/, f => ({ name: f[9], price: n(f[8]), lastClose: n(f[3]), open: n(f[5]), high: n(f[6]), low: n(f[7]), percent: n(f[10]), change: n(f[11]), time: `${f.at(-1)} ${f[0]}` })],
  [/^DINI/, f => ({ name: f[9], price: n(f[8]), lastClose: n(f[3]), open: n(f[5]), high: n(f[6]), low: n(f[7]), time: `${f.at(-1)} ${f[0]}` })],
  [/^btc_/, f => ({ name: f[9], price: n(f[8]), lastClose: n(f[3]), open: n(f[5]), high: n(f[6]), low: n(f[7]), time: `${f[11]} ${f[0]}` })],
  [/^b_/, f => ({ name: f[0], price: n(f[1]), change: n(f[2]), percent: n(f[3]), time: `${f[6]} ${f[5]}` })],
  [/^int_/, f => ({ name: f[0], price: n(f[1]), change: n(f[2]), percent: n(f[3]) })],
]

/** 600519 → sh600519，AAPL → gb_aapl，00700 → hk00700；其余原样 */
function code(s) {
  s = String(s).trim()
  if (/^\d{6}$/.test(s)) return (/^[569]/.test(s) ? 'sh' : /^[48]|^92/.test(s) ? 'bj' : 'sz') + s
  if (/^(SH|SZ|BJ)\d{6}$/.test(s)) return s.toLowerCase()
  if (/^\d{5}$/.test(s)) return 'hk' + s
  if (/^[A-Z][A-Z.]{0,5}$/.test(s) && !/^(DINIW)$/.test(s)) return 'gb_' + s.toLowerCase().replace('.', '$')
  return s
}

/** 实时报价，多个代码用逗号分开。A 股 / 港美股直接写代码；期货、外汇、全球指数用新浪代码（见站点笔记，比如 hf_GC 纽约金、fx_susdcny、b_NKY）
 *  @example quote('hf_GC,hf_CL,fx_susdcny,DINIW')
 *  @example quote('600519,AAPL,00700,rt_hkHSI,gb_$ixic')
 *  @example quote('nf_AU0,CFF_RE_IF0,b_NKY,btc_btcbtcusd') */
export async function quote(symbols) {
  const list = String(symbols).split(/[,\s]+/).filter(Boolean).map(code)
  if (!list.length) throw new BxError('BAD_ARGS', '要至少一个代码')
  const t = await get(`https://hq.sinajs.cn/list=${list.join(',')}`, 'gbk')
  const out = []
  for (const m of t.matchAll(/var hq_str_([^=]+)="([^"]*)"/g)) {
    const [, sym, body] = m
    if (!body) {
      out.push({ symbol: sym, error: '没有这个代码' })
      continue
    }
    const f = body.split(',')
    const p = PARSE.find(([re]) => re.test(sym))
    const o = p ? p[1](f) : { raw: body }
    if (o.change == null && o.price != null && (o.lastClose ?? o.lastSettle)) o.change = +(o.price - (o.lastClose ?? o.lastSettle)).toFixed(4)
    if (o.percent == null) o.percent = pct(o.price, o.lastClose ?? o.lastSettle)
    out.push({ symbol: sym, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== 'undefined undefined')) })
  }
  if (!out.length) throw new BxError('CHANGED', '报价接口的返回格式变了', '去修 quote')
  return out
}

const TYPE = { 11: 'A股', 12: 'B股', 13: '指数', 21: '基金', 22: '基金', 23: '基金', 31: '港股', 33: '指数', 41: '美股', 71: '外汇', 81: '债券', 86: '外盘期货', 87: '国内期货', 88: '股指期货', 109: '期权', 203: 'ETF' }
/** 联想结果 → quote() 认的代码 */
const toQuote = (type, c, s) =>
  ({ 31: 'hk' + c, 41: 'gb_' + c.toLowerCase(), 86: 'hf_' + c.toUpperCase(), 87: 'nf_' + c.toUpperCase(), 88: 'CFF_RE_' + c.toUpperCase(), 71: c === 'diniw' ? 'DINIW' : 'fx_s' + c })[type] || s

/** 按名字 / 拼音找代码（返回新浪代码，可直接给 quote）
 *  @example search('茅台') */
export async function search(q, { limit = 10 } = {}) {
  const t = await get(`https://suggest3.sinajs.cn/suggest/type=&key=${encodeURIComponent(q)}&name=s`, 'gbk')
  const body = t.match(/="(.*)"/)?.[1] || ''
  const out = body
    .split(';')
    .filter(Boolean)
    .map(r => r.split(','))
    .map(f => ({ name: f[4] || f[0], code: f[2], symbol: toQuote(f[1], f[2], f[3]), type: TYPE[f[1]] || f[1] }))
  if (!out.length) throw new BxError('EMPTY', `新浪没有找到 ${q}`, '换个名字')
  return out.slice(0, limit)
}


const NODE = { all: 'hs_a', sh: 'sh_a', sz: 'sz_a', cyb: 'cyb', kcb: 'kcb', bj: 'hs_bjs', etf: 'etf_hq_fund', bond: 'hskzz_z' }
const SORT = { percent: 'changepercent', amount: 'amount', turnover: 'turnoverratio', volume: 'volume', marketCap: 'mktcap', pe: 'per', price: 'trade' }

/** A 股涨跌排行（东方财富 rank 被限流时的备用）。by：percent amount turnover volume marketCap pe price；order：desc / asc；
 *  market：all 沪深京 sh sz cyb 创业板 kcb 科创板 bj 北交所 etf bond 可转债
 *  @example rank({ limit: 20 })
 *  @example rank({ by: 'amount', market: 'kcb', limit: 10 }) */
export async function rank({ by = 'percent', order = 'desc', market = 'all', limit = 50 } = {}) {
  const node = NODE[market] || market
  const out = []
  for (let page = 1; out.length < limit && page <= 60; page++) {
    const t = await get(`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=80&sort=${SORT[by] || by}&asc=${order === 'asc' ? 1 : 0}&node=${node}&symbol=&_s_r_a=page`, 'gbk')
    let d
    try {
      d = JSON.parse(t)
    } catch {
      throw new BxError('CHANGED', '新浪排行接口返回的不是 JSON', t.slice(0, 100))
    }
    if (!Array.isArray(d)) break
    out.push(...d)
    if (d.length < 80) break
    await bx.sleep(300)
  }
  if (!out.length) throw new BxError('EMPTY', `新浪 ${market} 没有行情数据`, 'market 写错了？')
  return out.slice(0, limit).map((x, i) => ({
    rank: i + 1,
    code: x.code,
    name: x.name,
    price: n(x.trade),
    percent: n(x.changepercent) != null ? +(+x.changepercent).toFixed(2) : undefined,
    change: n(x.pricechange),
    volume: n(x.volume),
    amount: n(x.amount),
    turnover: n(x.turnoverratio) != null ? +(+x.turnoverratio).toFixed(2) : undefined,
    pe: n(x.per),
    pb: n(x.pb),
    marketCap: n(x.mktcap) != null ? Math.round(x.mktcap * 10000) : undefined,
    floatCap: n(x.nmc) != null ? Math.round(x.nmc * 10000) : undefined,
    symbol: x.symbol,
    url: `https://finance.sina.com.cn/realstock/company/${x.symbol}/nc.shtml`,
  }))
}