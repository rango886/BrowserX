---
name: browserx
description: BrowserX（命令 bx）：借用户已登录的浏览器上网。读网页、搜索和取数据（Google、B 站、YouTube、Reddit、HN、微博、知乎、小红书、雪球、东方财富、Yahoo Finance、arXiv、维基百科等 50 多个网站有现成函数）、跨多个网站检索调研、点击填表、上传下载、截图、看接口请求。只要任务要用到网页内容或网站操作（尤其是要登录的网站），就用它。
---

# BrowserX（bx）：借用户的浏览器上网

`bx` 是命令行工具，后台 daemon 会自动启动。浏览器的登录状态、打开的标签、网络记录都存在 daemon 里，所以每条命令跑完就退出也不会丢东西。

## 0. 先选对工具

| 要做的事 | 用什么 |
|---|---|
| 看一个网页讲了什么 | `bx read <网址>` |
| 长文章 / 长评论区里只找和问题相关的部分 | `bx read <网址> --grep '关键词1\|关键词2'` |
| 搜索引擎 | `bx call google.com search …`（被拦自动换必应 / DuckDuckGo）；中文内容加一路 `baidu.com` |
| 在某个网站上搜索、取列表、取评论 | 先 `bx lib list` 看有没有现成函数；有就 `bx call <域名> <函数> …`（网站目录见第 4 节） |
| 视频讲了什么 | `youtube.com transcript` / `bilibili.com subtitles` 取字幕，B 站还有 `summary` |
| 股票、公告、资金流、期货外汇、美股期权 | `xueqiu.com` / `eastmoney.com` / `sina.com.cn` / `finance.yahoo.com` / `barchart.com`，怎么选见第 4 节 |
| 加密货币行情、市值榜、趋势币 | `binance.com` / `coingecko.com` |
| 论文、审稿、AI 模型和数据集 | `arxiv.org` / `semanticscholar.org` / `openreview.net` / `huggingface.co` |
| 百科词条、网页的历史存档 | `wikipedia.org` / `archive.org`（Wayback） |
| 依赖包详情、下载量、CVE / 开源漏洞 | `npmjs.com` / `pypi.org` / `crates.io` / `nvd.nist.gov` / `osv.dev` |
| 英文新闻、Newsletter、新产品发布 | `bbc.com` / `substack.com` / `producthunt.com` / `lobste.rs` |
| 中国政府和部委的政策文件 | `gov.cn`（搜索、最新列表、全文） |
| 跨好几个网站调研一个问题 | `bx run -f 脚本.js`，分步做，见第 7 节 |
| 一次做一串事、批量处理、拼接几个网站的数据 | `bx run`（写 JS，全局有 `bx` 对象） |
| 在页面上点按钮、填表、上传、下载 | `bx snapshot -i` / `bx find` 找元素，然后 `bx click` / `bx fill` |
| 想知道网站的数据来自哪个接口 | `bx net log --api -t <标签>`，然后 `bx net show <id>` |

**开工时先跑这两条**：

```bash
bx browser list     # 有没有连上浏览器；有多个时问用户用哪个，之后都加 --browser <名字>
bx lib list         # 有哪些网站的现成函数；[要登录] / [登录更好] 标出哪些站要用户先登录
```

任务要用到标了 `[要登录]` 的网站时，开工前就告诉用户“这几个站需要你在浏览器里登录”，别等报错了才说。

`browser list` 为空：先等几秒再试（插件连上要一点时间）。还是空就请用户在 `chrome://extensions` 里加载仓库的 `extension/` 目录。用户不想用自己的浏览器时，用 `bx browser launch [名字]` 启动一个专用浏览器（无头加 `--headless`，但无头浏览器没有登录状态，很多网站会拦）。

## 1. 守则

- **不打扰用户**：自己要用的标签在后台开（`bx tab open <url> --bg --keep` 或 `bx.open(url)`）。不要关闭或跳转用户自己的标签，用完自己开的标签要关掉（`bx tab close t5`，或在 `bx run` 里 `await bx.cleanup()`）。
- **每条页面命令都带 `-t <标签>`**，不要依赖“当前标签”，它可能被别的任务改掉。
- **省上下文**：大块数据写进文件，只把摘要打印出来看（一行一条、长文本截断）。`bx run` 的结果超过 2 万字会自动写到 `~/.bx/out/`，只打印路径和摘要。
- **先读后操作**：查信息用 `read` / 函数库；要操作时再 `snapshot -i` 或 `find`；截图放到最后。
- **遇到登录、验证码不要硬闯**：`bx tab activate <标签>` 把标签切到前台，请用户处理完再继续。

## 2. 错误码怎么处理

报错的格式是 `✗ [CODE] 说明`，下一行 `→` 后面是建议。

| code | 什么情况 | 你该怎么做 |
|---|---|---|
| `NEED_LOGIN` | 没登录、登录过期；403 也可能是被网站拦了 | 告诉用户去浏览器里登录这个网站；用的是无头 / 专用浏览器的话，换用户日常的浏览器 |
| `BLOCKED` | 验证码、风控、请求太频繁 | 停一停再试；有验证码就请用户在浏览器里处理（错误提示里有标签编号） |
| `EMPTY` | 正常执行了，但没有结果 | 换关键词、放宽条件 |
| `NOT_FOUND` | 帖子、用户、视频不存在 | 检查参数 |
| `CHANGED` | 网站改版了，函数解析不出来 | 用 `bx read` 或 `bx run` 现场取数据，再修函数库里的那个函数 |
| `AMBIGUOUS` | 目标元素匹配到多个 | 照着列出的候选写得更具体，或者用 snapshot 编号 |
| `STALE_REF` / `UNKNOWN_REF` | 编号失效（页面跳转了） | 重新 `bx snapshot -i` |
| `COVERED` | 元素被弹层挡住了 | 先关掉弹层（`bx press Escape`，或点关闭按钮） |
| `NO_LIB` / `NO_FUNCTION` | 没有这个函数库 / 函数 | `bx lib list [域名]` 看看有什么 |

## 3. 读网页

```bash
bx read <网址>           # 后台开标签，读完关掉；--keep 保留（输出里有标签编号）
bx read -t t5            # 读已经打开的标签
bx read <网址> -b        # 只看概要和分段，最省 token
bx read -t t5 -s comments   # 展开某一段（分段 id 见输出末尾）
bx read -t t5 --offset 6000 # 内容被截断时接着读；--limit 50 列表多取几项；--budget 20000 放宽字数
bx read <网址> --scroll 3   # 先往下滚 3 屏再读（懒加载的评论、无限滚动的列表）
bx read <网址> --grep '断货|限购'      # 只看命中的段落（前后各带一段）；-C 0 不带上下文，-C 2 多带点
bx read <网址> -s comments --grep AMD # 只在评论区里找
```

- **长文章只关心其中几件事时用 `--grep`**，比读全文省很多：它在整篇内容里按段落找（一整段不换行的中文网页按句子找），相邻命中合并成一块。关键词按正则、不分大小写。每块前面的 `〔@1304〕` 是它在全文里的位置，`bx read --offset 1304` 从那里接着读。列表页上 `--grep` 是按条目过滤。脚本里：`(await bx.read(url, { grep: /断货|限购/ })).matches` → `[{ offset, text, hits }]`。
- `via: lib:<域名>` 表示用的是函数库里的专用读法（最准），`readability` / `list` / `outline` 是通用提取。内容不对时可以用 `--via readability|list|outline` 手动指定。
- **输出末尾如果列出了“这个网站有函数库 …”**，要批量取数据时就用那些函数，别自己去解析页面。
- 出现 💡 提示页面里有 `window.__INITIAL_STATE__` 这类数据时，用 `bx eval "window.__INITIAL_STATE__.xxx" -t t5` 直接拿结构化数据。

## 4. 函数库：bx call

### 有哪些网站

函数名只是大概，参数、例子和坑以 `bx lib list <域名>` 为准。标 🔑 的要用户在浏览器里登录；（🔑）是登录后更全 / 不容易被限流。

| 类别 | 域名 | 能取什么 |
|---|---|---|
| 搜索引擎 | `google.com` | 网页搜索（被拦自动换必应 / DDG）、`suggest` 联想词、`news` Google 新闻、`trends` 热搜 |
| | `bing.com` `duckduckgo.com` `baidu.com` | 网页搜索；`baidu.com hot` 百度热搜（实时 / 财经 / 民生 / 影视 / 小说 / 汽车 / 游戏） |
| 技术社区 | `news.ycombinator.com` | 搜索、`stories` 首页 / 最新 / Ask / Show 榜、评论（按网页上的排名顺序）、用户 |
| | `reddit.com`（🔑） | 搜索、`posts` 版块帖子 / 热门、评论（会展开“加载更多”）、用户及其帖子 / 评论、版块信息 |
| | `github.com`（🔑） `stackoverflow.com` `v2ex.com` `linux.do` 🔑 `medium.com`（🔑） | 搜索、帖子 / 问题 / issue / 仓库、热门 / trending |
| | `x.com` 🔑 | 搜推文、推文详情和回复、用户 |
| 学术 / AI | `arxiv.org` | 搜论文、论文摘要和 PDF 链接、作者的全部论文、分类最新；`semanticscholar.org` 搜论文、引用和参考文献、相关论文推荐；`openreview.net` 搜投稿、审稿意见和评分、作者；`huggingface.co`（🔑 登录看私有）搜模型 / 数据集 / Spaces、模型详情、每日 / 每周热门榜 |
| 参考 / 存档 | `wikipedia.org` | 搜词条、摘要、正文（按小节）、每日 / 每月最多浏览、随机词条；`archive.org` 查 Wayback 历史快照和快照里的正文、搜存档资料和文件列表 |
| 包和漏洞 | `npmjs.com` `pypi.org` `crates.io` | 搜索、包详情（版本、依赖、仓库）、下载量（按日 / 周）；`nvd.nist.gov` 查 CVE 详情和按关键词 / 严重度 / 时间搜漏洞；`osv.dev` 按包名（指定生态、版本）查已知漏洞和漏洞详情 |
| 币圈 | `binance.com` | 实时价格、全市场行情、成交额排行、涨跌幅榜、K 线、盘口、成交流水、合约资金费率 |
| | `coingecko.com` | 市值榜（可按分类过滤）、币详情、历史价格、趋势币、全球行情、分类、交易所、衍生品 |
| 视频 | `youtube.com`（🔑） | 搜索、频道 / 频道全部视频、视频详情、`comments` 评论（翻页、按最新、楼中楼）、`transcript` 字幕（可机翻）、播放列表；🔑 订阅 / 历史 / 稍后观看 |
| | `bilibili.com`（🔑） | 搜索、排行 / 热门、视频详情、评论、`subtitles` 字幕、`summary` 官方 AI 总结、UP 主及其视频 / 动态、下载、收藏夹、🔑 历史、关注 |
| | `douyin.com`（🔑） | 热榜、搜索、视频详情、评论、用户视频 |
| 中文资讯 / 社交 | `weibo.com` 🔑 | 热搜（不用登录）、搜索、微博正文、评论（带楼中楼）、用户及其微博 |
| | `zhihu.com` 🔑 `xiaohongshu.com` 🔑 `toutiao.com`（🔑） `weixin.qq.com` `36kr.com` | 搜索、热榜、问答 / 笔记 / 文章正文、评论 |
| 外文新闻 / Newsletter | `reuters.com`（🔑） `bloomberg.com`（🔑） | 搜索、栏目列表、文章正文 |
| | `bbc.com` | 各栏目头条（RSS，含 BBC 中文）、搜索、文章正文 |
| | `substack.com` | 分类热榜（文章和热门 Notes）、搜文章和 Newsletter、某个 Newsletter 的最新文章、正文 |
| | `lobste.rs` | 热门 / 最新 / 活跃榜、按标签和域名看帖子、搜帖子、评论 |
| | `producthunt.com` | 今日发布、日 / 周 / 月 / 年排行榜、最新、分类佳作、搜产品、产品详情 |
| 中国政策 | `gov.cn` | 国务院文件、部门文件、政策解读的最新列表（可按日期和标题过滤）、全文搜索（国务院文件 / 公报 / 全部）、正文和附件链接 |
| A 股 / 国内财经 | `xueqiu.com`（🔑） | 股票代码、行情、K 线、财务指标、公司资料、热股；讨论帖、帖子评论 |
| | `eastmoney.com` | 7x24 快讯、公告列表和正文、龙虎榜和营业部席位、个股 / 板块资金流、北向成交、板块排行和成分股、涨跌排行（含 ETF / 可转债）、十大股东、人气榜 |
| | `sina.com.cn` | 滚动新闻、7x24 直播、实时报价（**期货、外汇、全球指数**、港美股）、涨跌排行（东方财富被限流时用它） |
| | `10jqka.com.cn` `tdx.com.cn` | 同花顺 / 通达信热股榜、热门板块；通达信还有 ETF / 可转债 / 期货 / 港美股人气榜 |
| 美股 | `finance.yahoo.com` | 行情（含盘前盘后）、K 线、公司资料和估值、财报科目、期权链、新闻、热门、涨跌榜 |
| | `barchart.com` | 期权：IV / IV Rank / Put-Call 比、带希腊值的期权链、到期日、异常期权成交 |
| AI | `aistudio.google.com` 🔑 | 向 Gemini 提问 |

```bash
bx lib list bilibili.com     # 站点笔记 + 每个函数的签名、说明、例子、命令行写法（第一次用某个网站先看这个）
bx call google.com search "sqlite production" --limit 20 --time year
bx call google.com news "deno cloudflare" --days 7
bx call bilibili.com comments BV1GJ411x7h7 --limit 50 -o csv > 评论.csv
bx call bilibili.com subtitles BV1GJ411x7h7 --text      # 视频内容先看字幕 / summary，比看简介准
bx call youtube.com transcript dQw4w9WgXcQ --translate zh-Hans --text
bx call youtube.com videos '@doctorx2023' --limit 200    # PowerShell 里 @ 开头的参数要加引号
bx call reddit.com comments "https://www.reddit.com/r/xxx/comments/abc/" --limit 300
bx call eastmoney.com notices 600519 --type finance      # 公告；正文用 notice <id>
bx call sina.com.cn quote "hf_GC,hf_CL,fx_susdcny,DINIW"  # 纽约金、原油、美元人民币、美元指数
bx call finance.yahoo.com profile NVDA                   # 公司资料 + 估值 + 分析师目标价
bx call binance.com top --limit 10                       # 币安成交额前十；coingecko.com top 是市值榜
bx call gov.cn search 消费 --type state --sort time      # 国务院文件全文搜；正文用 gov.cn article <网址>
```

- **搜索引擎**：`google.com search` 自带排队（同一个进程里的搜索一个接一个发，并行写 `Promise.allSettled` 也没事）、被人机验证拦住时等一会儿重试一次，还不行就**自动改用必应、再不行用 DuckDuckGo**（结果里 `engine` 字段标明来源，stderr 会打一行 ⚠），之后 10 分钟内直接走兜底。只要 Google 的结果就传 `--fallback false`；指定兜底顺序用 `--fallback baidu,bing`。`suggest` / `news` / `trends` 走公开接口，不会被拦。
- **视频内容**：先用字幕（`youtube.com transcript`、`bilibili.com subtitles`）或 B 站 `summary`，比读简介、看评论猜要准得多。YouTube 列表类（`videos`、`playlist`）走内部翻页接口，几秒拉完几百条，不要自己滚动抓 DOM。
- **金融数据怎么选**：A 股行情 / K 线 / 财务用 `xueqiu.com`；快讯、公告、龙虎榜、资金流、板块、股东用 `eastmoney.com`；期货、外汇、全球指数用 `sina.com.cn quote`；美股用 `finance.yahoo.com`，期权希腊值用 `barchart.com`；币圈实时行情和盘口用 `binance.com`，市值榜和趋势币用 `coingecko.com`。东方财富的行情列表接口（`rank` `boards` `moneyflowRank`）请求多了会被临时封 IP，报 `BLOCKED` 时按提示换新浪 / 同花顺 / 通达信。
- 位置参数按函数签名的顺序传，`--名字 值` 合成最后一个对象参数；`--full` 这种是开关。函数自己有 `tab` 参数时（如 `youtube.com videos --tab streams`），`--tab` 交给函数，指定标签用 `-t`。
- 输出被管道或程序接走时默认是 JSONL；给人看用 `-o table` / `-o yaml`；要解析就用 `-o json`。stderr 里“字段 xx 在全部记录里都是 undefined”多半只是这批数据没有这个字段，不用管。
- **管道**：第一个参数写 `-` 就从 stdin 一行一条地读，每条执行一次。JSON 记录默认取它的 `url` 字段（`--field mid` 指定别的字段）；`--concurrency 3` 并发；某条失败只在 stderr 打 `✗`，其余照常。

```bash
bx call bilibili.com search 电影解说 --limit 5 | bx call bilibili.com comments - --limit 3
bx call bilibili.com rank 动画 --limit 5 | bx call bilibili.com user - --field mid
bx call news.ycombinator.com search "bun in production" -o jsonl | bx call news.ycombinator.com comments - --limit 50
bx call sina.com.cn search 黄金 --limit 3 | bx call sina.com.cn quote - --field symbol
```
## 5. bx run：写 JS 串起来

代码在 Node 里执行（ES 模块）：可以用顶层 `await` 和 `import fs from 'node:fs'`，`return` 的值会打印出来。只有一个表达式时可以不写 `return`。

```bash
bx run 'await bx.tabs()'
bx run -f step1.js 0,3,7     # 多出来的参数在 bx.args 里
```

```js
// 标签
const tab = await bx.open(url)                 // 后台新开
const tab = await bx.tab('t5')                 // 按编号拿回之前开的标签（上次 bx run 开的也行）
const tab = await bx.tab('reddit.com')         // 复用已打开的、网址匹配的标签（带登录状态），没有就后台新开
await bx.cleanup()                             // 关掉这次运行自己开的标签

// 取数据
await bx.read(url, { budget: 4000 })           // → { title, content, … }，读完自动关标签
await bx.read(url, { grep: /断货|限购/ })        // 只要命中的段落 → .matches = [{ offset, text, hits }]
await bx.lib('reddit.com').search('x', { limit: 20 })
await fetch('https://api.github.com/...')      // 公开接口直接用 Node 的 fetch，不用开标签
await tab.fetch(url)                           // 在页面里发请求，带着登录状态，返回 JSON
await tab.eval(() => document.title)           // 在页面里跑 JS（函数会被序列化，用不了外面的变量）
await tab.eval(n => [...document.querySelectorAll('h3')].slice(0, n).map(h => h.innerText), 10)  // 参数从后面传

// 接口带签名、自己发不了请求时：让页面自己翻页，接住每一页的返回
for await (const res of tab.collect('/api/search', { more: () => tab.scroll() })) { … }

// 操作（和命令行一一对应）
await tab.click(目标)  tab.fill(目标, 文字, { submit: true })  tab.fill({ 目标: 值, … })
tab.press('Enter')  tab.type(文字)  tab.select(目标, 选项)  tab.upload(目标, 文件)  tab.scroll()
tab.snapshot({ interactive: true })  tab.find(文字)  tab.waitFor({ text })  tab.waitFor({ url: /issues\/\d+/ })  tab.shot({ save })  tab.close()
bx.log(...)  bx.sleep(ms)   // 日志走 stderr，不混进结果
```

- 先试 `tab.fetch`：很多看起来带签名的接口，在页面里带着 cookie 直接请求也能用。不行再用 `collect`。
- JS 变量在进程退出后就没了：要留的结果写文件；标签留着，下次用 `bx.tab('t5')` 拿回来。

## 6. 操作页面

目标元素有四种写法，所有点击、填写类命令都接受：

```bash
bx click e15 -t t5                                      # snapshot 编号（临时操作用）
bx click "#main button.submit" -t t5                    # CSS 选择器
bx click "getByRole('button', { name: '提交' })" -t t5  # 按角色 + 名字（写脚本时推荐）
bx fill "getByLabel('邮箱')" a@b.com -t t5              # 还有 getByText('下一步')、getByPlaceholder('搜索')
```

```bash
bx snapshot -i -t t5              # 可操作的元素 + 编号；不加 -i 会连文字一起显示
bx find "加入购物车" -t t5         # 只返回匹配的那几行和编号，比整页 snapshot 省很多
bx click <目标> -t t5             # --double --right --middle --modifiers Shift --force（被挡住也点）
bx fill <目标> "内容" --submit -t t5
bx fill e3=张三 e5=13800000000 e7=true -t t5    # 一次填多个：勾选框填 true/false，下拉框填选项文字
bx select <目标> 北京 -t t5 / check <目标> / uncheck <目标> / press Enter / type "文字"
bx upload <目标> ./a.png -t t5    # 目标可以是“点了会弹选文件窗口”的按钮
bx click <目标> --download --save ./out -t t5   # 等下载完成，返回文件路径
bx scroll [down|bottom|<目标>] -t t5           # 返回 atBottom
bx wait --text 加载完成 -t t5     # 还有 --gone / --selector / --url / --fn / --idle
bx wait --url '/issues\/\d+/' -t t5   # --url：子串 /issues/、通配 '*github.com/*/issues/*'、斜杠包起来的正则（net log / collect 的匹配也一样）
bx mouse click 320 240 -t t5      # canvas、地图这类：坐标从 bx shot --marks 的截图上看
bx shot --marks -t t5             # 截图，在图上标出编号
```

- 每次操作都返回 `changes`：`navigated`（页面跳转了，编号作废，要重新 snapshot）、`newTabs`（开了新标签，在后台，用 `-t <新编号>` 操作它）、`dialogs`（弹窗已自动确认）、`note`。
- 加 `--snap` 操作完顺带返回新的 snapshot，省一次调用。
- 页面局部重绘后编号会自动按“角色 + 名字”重新定位（结果里会注明）；页面跳转后要重新 snapshot。

## 7. 跨站检索的最佳实践

跨几个网站调研一个问题（“X 能不能用于生产环境”“大家怎么评价 Y”“Z 方案现在什么状况”）时，**不要一个网站一个网站地手动 `read`**。按下面的步骤做，每一步是一次 `bx run`：

1. **广撒网**：几个站并行搜索。中英文网站各用对应语言的关键词。把结果规整成同一种结构 `{ site, title, url, heat, time }`，写进 `research/posts.json`。只返回“每个来源成功/失败 + 一行一条、带序号的摘要”。
2. **挑着深挖**：看摘要按标题挑出真正相关的几条（搜索结果里总会混进跑题的帖子）。用序号作参数，拉评论或正文，写进 `research/threads.json`。文章拆成段落，关心特定问题时在脚本顶部设 `KEY`（正则），文章用 `bx.read(url, { grep })` 只取命中段落、评论也按它过滤。
3. **一手资料**：官方文档用 `bx.read`，项目数据用公开接口（GitHub API 等）。
4. **写结论**：每个说法后面带来源链接；分清是谁的经验、哪篇文章、官方怎么写的；矛盾的说法都列出来，写清楚各自的前提。
5. **存下来**：现场摸通的网站写成 `~/.bx/lib/<域名>.js` 里的函数，下次直接用（见第 8 节）。

几个要点：

- 用 `Promise.allSettled` 并行。一个站失败（`NEED_LOGIN` / `BLOCKED`）不影响其它站，把失败原因报出来就行。多个 Google 查询也可以并行写（函数库里会排队、被拦会自动换引擎）；中文问题可以加一路 `baidu.com`。
- PowerShell 里序号参数要加引号：`bx run -f step2.js "0,31,60"`（不加会被拆成数组）。
- 保留各站自己的相关度顺序，不要按评论数排序（会把跑题的热帖排到前面）。
- 拉详情时限制并发（同时 3 个左右），结束时 `await bx.cleanup()`。
- 中间结果都写文件，所以每一步都可以单独重跑。

**可以直接复制的脚本**：本 skill 目录下的 `examples/cross-site-research/`（`step1.js` 搜索汇总、`step2.js` 拉详情、`step3.js` 一手资料，`README.md` 是说明）。三个脚本都在真实浏览器里跑通过（HN + Reddit + B 站 + Google）。复制到工作目录，改脚本顶部的关键词就能用：

```bash
bx run -f step1.js              # → 来源状态 + 带序号的摘要
bx run -f step2.js 0,31,60,80   # → 挑中的几条的评论 / 正文
bx run -f step3.js
```

## 8. 把摸通的网站存成函数库

```
第一次遇到 → bx read <网址> 看一眼
不够用     → bx run 里试：tab.eval 看页面数据、bx net log --api -t t5 找接口、tab.fetch 调一下
试通了     → 改成函数，存进 ~/.bx/lib/<域名>.js
写完 / 修完 → bx lib test <域名> [函数]，把 @example 真跑一遍验证
```

```js
// ~/.bx/lib/example.com.js
/* 站点笔记：接口在哪、字段什么意思、有什么坑（bx lib list 时显示；下次来修先看它）
 * @login required 没登录会怎样（required 必须登录 / optional 登录更好 / 不写就是不用登录；函数说明里也能写，覆盖这里） */

/** 一行说明
 *  @example search('关键词', { limit: 20 }) */
export async function search(q, { limit = 20 } = {}) {
  const tab = await bx.tab('example.com')
  const j = await tab.fetch(`https://example.com/api/search?q=${encodeURIComponent(q)}`)
  if (!Array.isArray(j.items)) throw new BxError('CHANGED', '搜索接口的返回结构变了', '去修 search')
  if (!j.items.length) throw new BxError('EMPTY', `没有搜到 ${q}`, '换个关键词')
  return j.items.slice(0, limit).map(x => ({ title: x.title, url: x.url }))   // 返回数组，每项带 url
}

/** 可选：有这个函数时 bx read 会优先用它；处理不了的页面返回 null */
export async function read(tab) { … }
```

- 参数类型看默认值（`limit = 20` 是数字，`full = false` 是开关），不用另外声明；全局有 `bx` 和 `BxError`，不用 import。
- 标了 `@login` 的函数要自己认出“没登录”（返回 200 但 JSON 里带错误码、跳到登录页、只给前几条）并抛 `NEED_LOGIN`，框架只认得 401 / 403。
- `@example` 会被 `bx lib test` 真的执行：要写真实、能跑通的参数；需要文件就加 `@test file 文件名 内容`，不能自动跑（发帖、删东西）就加 `@test skip 原因`。`bx lib test` 只有“真坏了”才算失败，要登录 / 被拦 / 例子过期单独列出。
- 函数库里定位元素用 CSS 或 `getByRole(...)`，不要用编号（页面一变编号就变）；自己开的标签在 `finally` 里关掉。
- 动手之前先看看 [OpenCLI](https://github.com/jackwener/opencli) 的 `clis/<站点>/` 有没有现成实现：它的 `page.goto` / `page.evaluate` 对应 `tab.goto` / `tab.eval`。
- 详细写法见仓库里的 `docs/lib.md`。想录下一次操作、自动分析数据来自哪个接口：`bx trace start --goal "…"` … `bx trace stop`，见 `docs/trace.md`。
