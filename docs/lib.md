# 函数库、bx run 和 bx call

这一篇讲第二版的核心：怎么把“在一个网站上摸索出来的门道”存下来，下次直接用。

## 先看全局

一共三样东西，各管一摊：

| 东西 | 是什么 | 扮演的角色 |
|---|---|---|
| **daemon** | 常驻后台的进程 | 管所有要长期存在的东西：浏览器连接、打开的标签、登录状态、网络记录 |
| **`bx run`** | 一次性进程，执行你写的一段 JS | 摸索、拼装：开标签、在页面里跑 JS、调接口、把结果写文件 |
| **函数库 `lib/<域名>.js`** | 按域名存放的普通 JS 文件，导出几个 async 函数 | 存下摸通的门道，给 `bx run`、`bx call`、`bx read` 复用 |

它们怎么配合：`bx run` 和 `bx call` 都在自己的进程里执行 JS，碰到浏览器的事就通过 RPC 去找 daemon。进程跑完就退出，但标签和登录状态都在 daemon 里，所以下次再跑，按编号就能把标签拿回来，什么都没丢。

```
 bx run / bx call / bx read（一次性进程，加载 lib/<域名>.js 在本进程里执行）
          │  RPC
          ▼
 daemon（常驻）：浏览器连接、标签、网络记录、页面操作
```

下面从最底层的“一个标签”讲起，一层层往上搭。

## 1. 最底层：拿到一个标签，在里面做事

`bx run` 里有一个全局对象 `bx`，不用 import。先拿一个标签：

```js
const tab = await bx.open('https://example.com')   // 后台新开一个，不抢焦点
const tab = await bx.tab('t5')                     // 按编号拿回之前开的
const tab = await bx.tab('bilibili.com')           // 复用网址匹配的已打开标签（带着登录状态），没有就后台新开
await bx.cleanup()                                 // 关掉这次运行自己开的标签（用户原来的标签不动）
```

拿到标签以后，最常用的三件事：

```js
await tab.eval(() => document.title)                      // 在页面里跑 JS（函数会被序列化，不能用外面的变量）
await tab.eval(n => [...document.querySelectorAll('h3')].slice(0, n).map(h => h.innerText), 5)  // 参数从后面传
await tab.fetch('https://api.example.com/x?id=1')         // 在页面里发请求，带着这个网站的 cookie，返回 JSON
await tab.read()                                          // 通用阅读，返回 { title, content, … }
await tab.read({ grep: /断货|限购/ })                    // 只要命中的段落：.matches = [{ offset, text, hits }]
```

页面 JS 做不到的事（真实的点击和输入、跳转、截图、看网络请求），`tab` 上都有对应的方法，和命令行一一对应：

```js
await tab.goto(url)              await tab.back()              await tab.reload()
await tab.click("getByRole('button', { name: '提交' })")       // 目标的写法见第 5 节
await tab.fill('#q', '关键词', { submit: true })
await tab.fill({ 'input[name=user]': '张三', "getByLabel('同意协议')": true })  // 一次填多个
await tab.press('Control+A')     await tab.type('文字')        await tab.select('#city', '北京')
await tab.upload('#avatar', 'a.png')                          // 也可以是“点了会弹选文件窗口”的按钮
await tab.click('a.export', { download: true, save: './out' }) // 等下载完成，返回 { download: { file } }
await tab.scroll()               await tab.scroll('e12')       // 返回 { atBottom }
await tab.mouse.click(320, 240)  await tab.keyDown('Shift')    await tab.keyUp('Shift')
await tab.snapshot({ interactive: true })                     // { text }，带编号
await tab.find('加入购物车')                                   // 只返回匹配的那几行
await tab.waitFor({ text: '加载完成' })
await tab.waitFor({ url: /\/issues\/\d+/ })                 // url：子串 / 带 * 的通配 / RegExp（或 '/正则/' 字符串）
await tab.waitResponse('/api/list')                           // 等下一个匹配的接口返回（先调用它，再触发）
await tab.shot({ save: 'a.png' })      await tab.cookies()     await tab.close()
```

## 2. 往上一层：让网站自己发请求，接住返回

有的接口带签名，逆向不出来（比如抖音、小红书）。这时候不自己发请求，而是让页面照常翻页，我们在旁边把每次返回接住：

```js
const tab = await bx.tab('example.com')
const all = []
for await (const res of tab.collect('/api/search', { more: () => tab.scroll() })) {
  all.push(...res.data.items)
  if (all.length >= 100) break
}
```

`collect` 的流程是：等匹配的请求完成 → 把响应的 JSON 交给你 → 调 `more()` 触发下一页 → 再等。连续两次（`idle`）等不到新请求就结束；`more()` 返回 `false` 也结束。它用的是 daemon 里现成的网络记录，不往页面里注入代码，网站察觉不到。

选项：`timeout`（每次等多久，默认 5000ms）、`idle`、`limit`、`full: true`（交出 `{ url, status, json }`）、`past: true`（调用之前已经记录到的也算）。

**先试 `tab.fetch`**：很多看起来有签名的接口，在页面里带着 cookie 直接请求就能用。不行再用 `collect`。

## 3. 再往上一层：`bx run`，把这些拼起来

`bx run` 执行一段 JS（ES 模块）：支持顶层 `await`，可以 `import node:fs` 等，`return` 的值打印出来。

```bash
bx run 'await bx.tabs()'                              # 只有一个表达式时可以不写 return
bx run 'const t = await bx.open("https://example.com"); const r = await t.eval(() => document.title); await t.close(); return r'
bx run -f research/step1.js                           # 从文件读；相对 import 按文件所在目录解析
bx run -f x.js a b                                    # 多出来的参数在 bx.args 里
bx run -t t5 'return (await bx.tab()).url()'          # bx.tab() 默认用 -t 指定的标签
```

- 结果超过 20000 字（`--max` 改）就写到 `~/.bx/out/` 下，只打印摘要和路径，免得刷屏。
- 出错时会指出是你代码的第几行。
- 每次跑完进程就退出：JS 变量丢了就丢了，要留的结果写文件；标签留着，下次 `bx.tab('t5')` 拿回来。

跨好几个网站调研一个问题时的完整做法（分步、并行、只看摘要），见 `skill/browserx/examples/cross-site-research/`。

几种取数据的方式可以在一段代码里混着用：公开接口用普通 `fetch`，要登录的在标签里 `tab.fetch`，已经摸通的网站调函数库。

## 4. 最上层：函数库 `lib/<域名>.js`

在 `bx run` 里试通的代码，原样改成函数，存进函数库，以后就能直接调。

### 写法

就是一个普通的 ES 模块，导出几个 async 函数。全局有 `bx` 和 `BxError`，不用 import：

```js
// ~/.bx/lib/bilibili.com.js

/* 站点笔记（bx lib list bilibili.com 时一起显示）：
 * - 路径里带 /wbi/ 的接口要签名，见 _bili-wbi.js
 * - 评论接口的 oid 要用 aid，不是 bvid，先用 view 接口换一下
 * - 请求太快会返回 -412，翻页之间停 1 秒
 */
import { wbiKey, signQuery } from './_bili-wbi.js'

/** 视频评论，按热度
 *  @example comments('BV1GJ411x7h7', { limit: 20 }) */
export async function comments(bvid, { limit = 20 } = {}) {
  const tab = await bx.tab('bilibili.com')
  const v = await tab.fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
  const j = await tab.fetch(`https://api.bilibili.com/x/v2/reply?type=1&sort=1&oid=${v.data.aid}`)
  return j.data.replies.slice(0, limit).map(r => ({ author: r.member.uname, text: r.content.message }))
}

/** 有这个函数时，bx read 打开这个域名的网址会优先用它 */
export async function read(tab, { section } = {}) {
  return tab.eval(() => ({ title: document.title, content: document.querySelector('.desc-info')?.innerText }))
}
```

几条约定：

- **参数就是普通参数**，不用另外声明。命令行调用时，位置参数按顺序传，`--limit 20` 这类合成最后一个对象参数。
- **参数类型看默认值**：`limit = 20` 是数字，`full = false` 是开关（`--full`），没有默认值的是字符串。命令行按这个转换类型，帮助信息也从这里生成。
- **函数前面的 `/** */`**：第一行是说明，`@example` 是用法示例，`bx lib list` 会显示出来。
- **文件顶部的注释是站点笔记**：接口在哪、字段什么意思、有什么坑。下次来修或者加函数时先看它。
- **返回数组**（每项一个对象，带上能给下一个命令用的 `url` / `id`），这样 `bx call` 输出 JSONL 能接管道。
- 要在页面里跑的代码用 `tab.eval(fn)`；自己开的标签用完 `tab.close()`（放在 `finally` 里）。
- `read(tab, opts)` 处理不了的页面返回 `null`，`bx read` 会改用通用提取；返回字符串就当正文，返回对象就按 `{ title, content, items, sections }` 显示。`opts` 里有 `section`、`limit`、`mode`。
- 文件名以 `_` 开头的只放共享代码（比如签名算法），不算函数库，用相对路径 import。

### 放哪、怎么找

| 位置 | 优先级 |
|---|---|
| `<项目>/.bx/lib/` | 最高（在这个目录及子目录里执行 bx 时生效） |
| `~/.bx/lib/` | 中 |
| 仓库 `lib/` | 内置，最低 |

`bx.lib('www.bilibili.com')` 先找完整域名，找不到再找上一级 `bilibili.com`。改完立即生效。

### 出错时怎么报

`throw new BxError(code, 说明, 建议)`。下面几种情况统一用这几个 code，AI 看到 code 就知道怎么办，不用读每个函数的实现：

| code | 什么情况 | 该怎么办 |
|---|---|---|
| `NEED_LOGIN` | 没登录，或者登录过期 | 告诉用户去浏览器里登录 |
| `BLOCKED` | 验证码、风控、请求太频繁 | 停一停，或者请用户在浏览器里处理 |
| `EMPTY` | 正常执行了，但没有结果 | 换个关键词或参数 |
| `NOT_FOUND` | 帖子、用户、视频不存在 | 检查参数 |
| `CHANGED` | 接口或页面结构变了，解析不出来 | 去修这个函数 |

其余情况随便起 code，带上说明和建议就行。`tab.fetch` 碰到 401/403 会自动报 `NEED_LOGIN`，429 报 `BLOCKED`，404 报 `NOT_FOUND`。

### 怎么用

```bash
bx lib list                                   # 有哪些函数库、各有哪些函数
bx lib list bilibili.com                      # 站点笔记 + 每个函数的签名、说明、例子、命令行写法
bx call bilibili.com comments BV1xx --limit 20
bx call bilibili.com search 纪录片 --limit 5 | bx call bilibili.com comments - --limit 3
bx read https://www.bilibili.com/video/BV1xx  # 有 read 就用它；输出末尾列出这个网站有哪些函数
```

```js
// bx run 里
const list = await bx.lib('bilibili.com').search('纪录片', { limit: 5 })
```

`bx call` 的管道：第一个参数写 `-` 就从 stdin 一行一条地读，结果输出 JSONL。读进来的是 JSON 记录时，默认取它的 `url` 字段当参数（`--field mid` 指定别的字段，支持 `a.b` 路径）；纯文本就整行当参数。`--concurrency 3` 并发；某条失败只在 stderr 打 `✗`，其余继续，退出码 3。

## 5. 目标元素的写法

所有点击、填写类的操作（命令行和 `tab` 方法都一样）接受四种写法：

```bash
bx click e15                                     # snapshot 编号
bx click "#main button.submit"                   # CSS 选择器，能穿透 open shadow DOM
bx click "getByRole('button', { name: '提交' })" # 和 Playwright 一样的写法，按无障碍树里的角色和名字找
bx fill "getByLabel('邮箱')" a@b.com
bx click "getByText('下一步')"                   # 还有 getByPlaceholder('搜索')
```

- 名字默认是“包含、不分大小写”；`{ exact: true }` 要求完全一样；也可以写正则 `{ name: /^Run/ }`。
- 匹配到多个元素就报错（`AMBIGUOUS`）并列出候选，不随便挑一个；找不到会等 3 秒。
- **函数库里不要用编号**：页面一变编号就变了，用 CSS 或 getBy*。
- 编号失效了会自动重新找：snapshot 时给每个编号记下“角色 + 名字 + 第几个同名元素”，页面局部重绘（React 刷新、弹层重建）后原来的元素没了，就按这三样再找一次，结果里注明“重新定位过”。页面跳转后编号全部作废，要重新 snapshot。

## 6. 一个网站从陌生到熟悉

```
第一次遇到 → bx read <网址> 看一眼
不够用     → bx run 里试：bx.open、tab.eval 看页面数据、bx net log 找接口、tab.fetch 调一下
试通了     → 把这段代码改成函数，存进 ~/.bx/lib/<域名>.js，顶部写上站点笔记
以后       → bx call 或 bx.lib(域名).函数()；bx read 的输出也会提示有这些函数
```

动手摸索一个新网站之前，先看看 [OpenCLI](https://github.com/jackwener/opencli) 的 `clis/<站点>/` 有没有现成的实现（Apache-2.0）。它的 `func(page, kwargs)` 大多只用了 `page.goto` 和 `page.evaluate`，对应 bx 的 `tab.goto` 和 `tab.eval`，接口地址和字段处理可以直接拿来改。

## 内置的函数库

| 文件 | 函数 |
|---|---|
| `lib/bilibili.com.js` | `search` `rank` `me` `video` `comments` `download` `user` `videos` `dynamics` `read`（视频页） |
| `lib/google.com.js` | `search`（进程内排队；被人机验证拦住时重试一次，再自动改用 bing / duckduckgo，`fallback: false` 关掉） |
| `lib/bing.com.js` | `search` |
| `lib/duckduckgo.com.js` | `search` |
| `lib/baidu.com.js` | `search`（中文内容覆盖更全） |
| `lib/youtube.com.js` | `channel` `videos` `video` `search` `read`（频道页 / 视频页） |
| `lib/aistudio.google.com.js` | `ask`（粘贴 prompt、等生成完、取回回复） |
| `lib/reddit.com.js` | `search` `comments` |
| `lib/news.ycombinator.com.js` | `search` `comments` `read`（帖子页） |
