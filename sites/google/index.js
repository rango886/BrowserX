// Google 搜索：bx google search <关键词>
// 这类站点没有公开接口，走"打开页面 → 在页面里提取"的方式

function extract() {
  if (location.pathname.startsWith('/sorry')) return { captcha: true }
  const seen = new Set()
  const items = []
  for (const h of document.querySelectorAll('#search a h3, #rso a h3')) {
    const a = h.closest('a')
    if (!a || seen.has(a.href) || !a.href.startsWith('http')) continue
    seen.add(a.href)
    const box = a.closest('.MjjYud, .g, [data-hveid]') || a.parentElement
    const snip = box?.querySelector('.VwiC3b, [data-sncf], .IsZvec, [style*="-webkit-line-clamp"]')
    const site = box?.querySelector('cite')
    items.push({ title: h.innerText.trim(), url: a.href, site: site?.innerText.split('›')[0].trim(), snippet: (snip?.innerText || '').replace(/\s+/g, ' ').trim() })
  }
  const next = !!document.querySelector('#pnnext, a[aria-label="下一页"], a[aria-label="Next page"]')
  return { items, next }
}

export default {
  name: 'google',
  description: 'Google 搜索',
  home: 'https://www.google.com',
  domains: ['google.com'],
  commands: {
    search: {
      summary: '搜索，返回标题 / 链接 / 摘要',
      args: [{ name: 'query', desc: '搜索词', rest: true }],
      key: ['query', 'keyword', 'title'],
      opts: {
        limit: { type: 'number', default: 10 },
        lang: { type: 'string', default: 'zh-CN', desc: '界面语言' },
        time: { type: 'string', choices: ['hour', 'day', 'week', 'month', 'year'], desc: '时间范围' },
      },
      examples: ['bx google search 最近有什么电影', 'bx google search bx browser agent --limit 20 -o yaml'],
      async *run(ctx) {
        const q = [].concat(ctx.args.query).join(' ')
        const tbs = ctx.opts.time ? `&tbs=qdr:${ctx.opts.time[0]}` : ''
        let n = 0
        let tab
        for (let start = 0; n < ctx.opts.limit && start < 100; start += 10) {
          const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=${ctx.opts.lang}&start=${start}${tbs}`
          if (!tab) tab = await ctx.open(url)
          else await tab.goto(url)
          // 等结果出来（或者被重定向到验证页）
          await tab.waitFor({ fn: `document.querySelector('#search h3, #rso h3, #botstuff') || location.pathname.startsWith('/sorry')`, timeout: 10000 }).catch(() => {})
          const r = await tab.eval(extract)
          if (r.captcha) throw new Error('被 Google 人机验证拦住了：用 `bx tab list` 找到这个标签、`bx tab activate` 切过去手动验证一次，再重试（或设置 BX_KEEP_TABS=1 保留标签）')
          for (const it of r.items) {
            yield { rank: ++n, ...it }
            if (n >= ctx.opts.limit) return
          }
          if (!r.next || !r.items.length) break
          await ctx.sleep(800)
        }
      },
    },
  },
}
