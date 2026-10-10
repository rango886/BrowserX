/* 站点笔记（蛋卷基金，雪球旗下的基金平台）：
 * @login none 公开的基金数据不用登录；只有 myFunds（自己的基金持仓）要在浏览器里登录 danjuanfunds.com
 * - 公开接口，Node 直接 fetch（带个浏览器 UA）：
 *     概况 /djapi/fund/<代码>（名称、类型、经理、规模、成立日，fund_derived 里是净值和各区间涨幅、同类排名）
 *     详情 /djapi/fund/detail/<代码>（fund_position 持仓：股票 / 债券占比和前十大重仓股；manager_list 基金经理；fund_rates 费率）
 *     净值历史 /djapi/fund/nav/history/<代码>?page=&size=
 *     风险指标 /djapi/fund/base/quote/data/index/analysis/<代码>（近 1/3/5 年波动率、夏普、最大回撤，和同类平均对比）
 *     排行 /djapi/v3/filter/fund?type=&order_by=&page=&size=（type：1 股票 2 债券 3 混合 4 货币 5 指数 6 FOF；
 *          order_by：1w 1m 3m 6m ty 今年 1y 2y 3y 5y base 成立以来）
 * - 蛋卷的基金搜索要登录，这里搜索借用东方财富的公开联想接口 fundsuggest.eastmoney.com
 * - 个人持仓（登录后）：/djapi/fundx/profit/assets/gain 拿账户列表，/djapi/fundx/profit/assets/summary?invest_account_id= 拿每个账户的持仓，
 *   要在 danjuanfunds.com 标签里带 cookie 请求
 */

const DJ = 'https://danjuanfunds.com/djapi'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new BxError('HTTP_ERROR', `蛋卷基金返回 ${r.status}`)
  const j = await r.json()
  if (j.result_code && j.result_code !== 0) {
    if (j.result_code === 300001) throw new BxError('NEED_LOGIN', '这个接口要登录蛋卷基金')
    throw new BxError('HTTP_ERROR', `蛋卷基金接口出错：${j.message || j.result_code}`)
  }
  return j.data
}

const code = c => {
  const s = String(c).match(/\d{6}/)?.[0]
  if (!s) throw new BxError('BAD_ARGS', `基金代码是 6 位数字：${c}`, '不知道代码就先 search')
  return s
}
const num = v => (v === undefined || v === null || v === '' ? undefined : +Number(v).toFixed(2))
const day = t => (t ? new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10) : undefined)
const TYPES = { stock: 1, bond: 2, mixed: 3, money: 4, index: 5, fof: 6 }
const RISK = { 1: '低', 2: '中低', 3: '中', 4: '中高', 5: '高' }

/** 按名字 / 代码 / 拼音缩写搜基金
 *  @example search('纳斯达克')
 *  @example search('中证红利', { limit: 5 }) */
export async function search(q, { limit = 20 } = {}) {
  const r = await fetch(`https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(q)}`, { headers: { 'user-agent': UA } })
  const j = await r.json()
  const list = (j.Datas || []).filter(x => x.CATEGORY === 700 && x.FundBaseInfo)
  if (!list.length) throw new BxError('EMPTY', `没搜到基金 ${q}`, '换个关键词')
  return list.slice(0, limit).map(x => ({
    code: x.CODE,
    name: x.NAME,
    type: x.FundBaseInfo.FTYPE,
    company: x.FundBaseInfo.JJGS,
    manager: x.FundBaseInfo.JJJL,
    nav: x.FundBaseInfo.DWJZ,
    navDate: x.FundBaseInfo.FSRQ,
    url: `https://danjuanfunds.com/funding/${x.CODE}`,
  }))
}

/** 基金概况：类型、公司、经理、规模、成立日、风险等级、最新净值、各区间涨幅（%）和同类排名、费率
 *  场内 ETF（蛋卷不卖的）只有净值和业绩，没有规模、费率
 *  @example fund('110011')
 *  @example fund('510300') */
export async function fund(c) {
  const fc = code(c)
  const [b0, d, detail] = await Promise.all([get(`${DJ}/fund/${fc}`).catch(() => null), get(`${DJ}/fund/derived/${fc}`).catch(() => null), get(`${DJ}/fund/detail/${fc}`).catch(() => null)])
  if (!b0 && !d) throw new BxError('NOT_FOUND', `蛋卷上没有基金 ${fc}`, '先用 search 确认代码')
  // 场内 ETF 等蛋卷不卖的基金没有概况，用东方财富的搜索结果补名称、公司、经理
  const s = b0 ? null : (await search(fc).catch(() => [])).find(x => x.code === fc)
  const b = b0 || { fd_code: fc, fd_name: s?.name, type_desc: s?.type, keeper_name: s?.company, manager_name: s?.manager }
  const rates = detail?.fund_rates
  return {
    code: b.fd_code,
    name: b.fd_name,
    fullName: b.fd_full_name,
    type: b.type_desc || undefined,
    company: b.keeper_name,
    manager: b.manager_name,
    custodian: b.trup_name,
    size: b.totshare,
    founded: b.found_date,
    risk: RISK[b.risk_level] || b.risk_level,
    nav: Number(d?.unit_nav) || undefined,
    accNav: Number(d?.unit_acc_nav) || undefined,
    navDate: d?.end_date,
    today: num(d?.nav_grtd),
    week: num(d?.nav_grl1w),
    month: num(d?.nav_grl1m),
    month3: num(d?.nav_grl3m),
    month6: num(d?.nav_grl6m),
    ytd: num(d?.nav_grlty),
    year: num(d?.nav_grl1y),
    year3: num(d?.nav_grl3y),
    year5: num(d?.nav_grl5y),
    sinceFound: num(d?.nav_grbase),
    rank1y: d?.srank_l1y,
    rank3y: d?.srank_l3y,
    buyFee: rates?.declare_rate ? `${rates.declare_rate}%（打折后 ${num(rates.declare_rate * (rates.declare_discount || 1))}%）` : undefined,
    sellFee: rates?.withdraw_rate ? `最高 ${rates.withdraw_rate}%` : undefined,
    manageFee: rates?.manage_rate ? `${rates.manage_rate}%` : undefined,
    url: `https://danjuanfunds.com/funding/${fc}`,
  }
}

/** 基金持仓（来自最近一期季报 / 中报 / 年报）：股票、债券、现金占比，前十大重仓股和较上期的变化。
 *  股票代码可以接着用 xueqiu.com 的 quote 查行情
 *  @example holdings('110011')
 *  @example holdings('005827') */
export async function holdings(c) {
  const fc = code(c)
  const p = (await get(`${DJ}/fund/detail/${fc}`).catch(e => {
    if (/暂不销售/.test(e.message)) throw new BxError('EMPTY', `${fc} 蛋卷不卖（多半是场内 ETF），没有持仓数据`, '指数 ETF 的持仓基本就是指数成分股；或者查它的场外联接基金')
    throw e
  }))?.fund_position
  if (!p) throw new BxError('EMPTY', `${fc} 没有持仓数据`, '货币基金、刚成立的基金没有')
  return {
    code: fc,
    report: p.source_mark,
    date: day(p.enddate),
    totalAsset: p.asset_tot ? `${(p.asset_tot / 1e8).toFixed(2)} 亿` : undefined,
    stock: p.stock_percent !== undefined ? `${p.stock_percent}%` : undefined,
    bond: p.bond_percent !== undefined ? `${p.bond_percent}%` : undefined,
    cash: p.cash_percent !== undefined ? `${p.cash_percent}%` : undefined,
    other: p.other_percent !== undefined ? `${p.other_percent}%` : undefined,
    stocks: (p.stock_list || []).map(s => ({ name: s.name, symbol: s.xq_symbol || s.code, percent: s.percent, change: s.change_of_pre_quarter || undefined, price: s.current_price, todayChange: s.change_percentage })),
    bonds: (p.bond_list || []).map(s => ({ name: s.name, code: s.code, percent: s.percent })),
  }
}

/** 基金经理：从业年限、简历、管理过的基金和任职回报
 *  @example managers('110011') */
export async function managers(c) {
  const fc = code(c)
  const list = (await get(`${DJ}/fund/detail/${fc}`))?.manager_list || []
  if (!list.length) throw new BxError('EMPTY', `${fc} 没有基金经理信息`)
  return list.map(m => ({
    name: m.name,
    years: m.work_year ? Number(m.work_year) : undefined,
    resume: m.resume?.replace(/\s+/g, ' ').trim(),
    funds: (m.achievement_list || []).map(a => ({ code: a.fund_code, name: a.fundsname, since: a.post_date, return: a.cp_rate !== undefined ? `${a.cp_rate}%` : undefined })),
  }))
}

/** 历史净值，最新的在前（percent 是当天涨跌 %）
 *  @example nav('110011', { limit: 30 }) */
export async function nav(c, { limit = 60 } = {}) {
  const fc = code(c)
  const out = []
  for (let page = 1; out.length < limit && page <= 50; page++) {
    const d = await get(`${DJ}/fund/nav/history/${fc}?page=${page}&size=${Math.min(limit, 200)}`)
    out.push(...(d.items || []))
    if (page >= (d.total_pages || 1)) break
  }
  if (!out.length) throw new BxError('EMPTY', `${fc} 没有净值数据`)
  return out.slice(0, limit).map(x => ({ date: x.date, nav: Number(x.nav), percent: num(x.percent ?? x.percentage) }))
}

/** 风险指标：近 1 / 3 / 5 年的年化波动率、夏普比率、最大回撤，以及同类基金的平均值；
 *  costPerformance 风险收益比、riskControl 抗风险波动（同类排名百分位，越大越好）
 *  @example risk('110011') */
export async function risk(c) {
  const fc = code(c)
  const d = await get(`${DJ}/fund/base/quote/data/index/analysis/${fc}`)
  const list = d?.index_data_list || []
  if (!list.length) throw new BxError('EMPTY', `${fc} 没有风险指标`, '成立不满半年的基金没有')
  const pc = v => (v === undefined || v === null ? undefined : `${(v * 100).toFixed(2)}%`)
  return list.map(x => ({
    period: x.index_time_period,
    volatility: pc(x.self_index?.volatility_rank),
    volatilityAvg: pc(x.average_index?.volatility_rank),
    sharpe: x.self_index?.sharpe_rank,
    sharpeAvg: x.average_index?.sharpe_rank,
    maxDrawdown: pc(x.self_index?.max_draw_down),
    maxDrawdownAvg: pc(x.average_index?.max_draw_down),
    costPerformance: x.investment_cost_performance,
    riskControl: x.risk_control,
  }))
}

/** 基金业绩排行。type：stock 股票 / mixed 混合 / bond 债券 / index 指数 / money 货币 / fof；
 *  period：1w 1m 3m 6m ty（今年以来）1y 2y 3y 5y base（成立以来）；返回值 return 是这段时间的涨幅 %
 *  @example rank({ type: 'stock', period: '1y', limit: 20 })
 *  @example rank({ type: 'index', period: '3m', limit: 20 }) */
export async function rank({ type = 'stock', period = '1y', limit = 30, page = 1 } = {}) {
  const t = TYPES[type]
  if (!t) throw new BxError('BAD_ARGS', `type 只能是 ${Object.keys(TYPES).join(' / ')}`)
  const d = await get(`${DJ}/v3/filter/fund?type=${t}&order_by=${period}&size=${Math.min(limit, 100)}&page=${page}`)
  if (!d?.items?.length) throw new BxError('EMPTY', '没有排行数据', 'period 写法：1w 1m 3m 6m ty 1y 2y 3y 5y base')
  return d.items.map((x, i) => ({ rank: (page - 1) * limit + i + 1, code: x.fd_code, name: x.fd_name, return: num(x.yield), nav: Number(x.unit_nav), url: `https://danjuanfunds.com/funding/${x.fd_code}` }))
}

/** 我自己在蛋卷的基金持仓（总资产、每个子账户、每只基金的市值、收益、收益率）。account 按子账户名称或 id 过滤
 *  @login required
 *  @example myFunds() */
export async function myFunds({ account = '' } = {}) {
  const tab = await bx.tab('danjuanfunds.com', { open: 'https://danjuanfunds.com/my-money' })
  const raw = await tab.eval(async () => {
    const f = async u => {
      const r = await fetch(u, { credentials: 'include' })
      return r.ok ? r.json() : { _err: r.status }
    }
    const gain = await f('/djapi/fundx/profit/assets/gain?gains=%5B%22private%22%5D')
    if (gain._err || gain.result_code === 300001) return { login: false }
    const root = gain.data || {}
    const sec = (root.items || []).find(i => i?.summary_type === 'FUND')
    const accs = sec?.invest_account_list || []
    const details = await Promise.all(accs.map(a => f('/djapi/fundx/profit/assets/summary?invest_account_id=' + encodeURIComponent(a.invest_account_id))))
    return { login: true, root: { date: root.daily_gain_date, amount: root.amount, dailyGain: root.daily_gain, holdGain: root.hold_gain, totalGain: root.total_gain, fund: sec?.amount }, accs, details }
  })
  if (!raw.login) throw new BxError('NEED_LOGIN', '没登录蛋卷基金', '在浏览器里登录 danjuanfunds.com 后重试')
  if (!raw.accs.length) throw new BxError('EMPTY', '蛋卷基金账户里没有基金')
  const funds = []
  raw.accs.forEach((a, i) => {
    const d = raw.details[i]?.data || {}
    for (const x of d.items || [])
      funds.push({
        account: d.invest_account_name || a.invest_account_name,
        accountId: String(a.invest_account_id),
        code: x.fd_code,
        name: x.fd_name,
        category: x.category_text || x.category,
        marketValue: num(x.market_value),
        shares: num(x.volume),
        nav: Number(x.nav) || undefined,
        dailyGain: num(x.daily_gain),
        holdGain: num(x.hold_gain),
        holdGainRate: x.hold_gain_rate !== undefined ? `${num(x.hold_gain_rate * 100)}%` : undefined,
        totalGain: num(x.total_gain),
        weight: x.market_percent !== undefined ? `${num(x.market_percent * 100)}%` : undefined,
      })
  })
  const list = account ? funds.filter(f => f.accountId === account || f.account?.includes(account)) : funds
  return {
    date: raw.root.date,
    totalAsset: num(raw.root.amount),
    fundValue: num(raw.root.fund),
    dailyGain: num(raw.root.dailyGain),
    holdGain: num(raw.root.holdGain),
    totalGain: num(raw.root.totalGain),
    accounts: raw.accs.map(a => ({ id: String(a.invest_account_id), name: a.invest_account_name, type: a.invest_account_type, marketValue: num(a.market_value), dailyGain: num(a.daily_gain) })),
    funds: list,
  }
}
