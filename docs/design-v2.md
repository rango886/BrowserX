# BrowserX 第二版设计（精简版）

> 上一稿在 `design-v2-old.md`，这一稿把它砍到只剩骨架。

## 0. 目标

借用户已经登录的浏览器，让 AI 能读网页、取数据、在网页上做事。

## 1. 第一版哪里别扭

第一版有两样东西做的其实是同一件事：

- **reader**：按网址匹配，代码注入到页面里跑，给 `bx read` 用
- **站点脚本**：按“站点 + 命令名”调用，代码在 Node 里跑，给 `bx bili video info` 这种命令用

同一个网站的门道（比如 B 站评论接口怎么调），要么写两遍，要么只能在一边用。AI 也搞不清该写哪个。站点脚本还要声明 `args`、`opts`、`commands` 这一套格式，这是我们发明的，AI 得现学。

## 2. 第二版只改一件事

**把 reader 和站点脚本合并成一个东西：按域名存放的普通 JS 函数。** 再加一个 `bx run`，让 AI 能直接写 JS 把这些函数和页面操作拼起来。

其余部分（daemon、两种驱动、标签、网络记录、页面操作命令）基本不动。

### 为什么不需要“内核”

上一稿给每个任务开一个常驻的 JS 进程，为的是变量能跨多次调用保留。但仔细看，真正“贵”的状态是：

- 浏览器的登录状态
- 打开着的标签、页面停在哪
- 网络记录

这些**本来就存在 daemon 里**。所以 `bx run` 跑完就退出也没关系：下次再跑，按编号拿回标签，网络记录还在，什么都没丢。JS 变量丢了就丢了，要留的结果写文件就行。

这样就不需要：内核进程管理、后台任务、超时转后台、运行记录重放。AI 的工具本身就能跑后台命令，不用 bx 再做一遍。

### 为什么不接 Playwright

接 Playwright 要在 daemon 里伪造一个“只含部分标签的浏览器”，还要让 daemon 和 Playwright 共用一个调试会话、合并请求拦截规则。这是上一稿里最复杂的一块，而且还没验证能不能跑通。

换个角度：AI 最熟的其实不是 Playwright，而是**页面里的 JS**（`document.querySelector`、`fetch`、`innerText`）。现有的 `tab.eval` 已经能直接跑这些。剩下页面 JS 做不到的事（真实的点击和输入、跳转、截图、看网络请求），现有的 `Tab` 类都有了。缺什么补什么，不需要整套 Playwright。

## 3. 整体结构

```
 AI
  │  bx read / bx run / bx call / 现有的各种页面命令
  ▼
 CLI（一次性进程）── 加载 lib/<域名>.js，在本进程里执行 ──┐
  │                                                          │
  │ RPC（和现在一样）                                        │
  ▼                                                          │
 daemon（常驻）：浏览器连接、标签、网络记录、页面操作 ◀──────┘
```

只有两层：

- **daemon**：管所有要长期存在的东西。和现在一样
- **CLI**：每次执行完就退出。`bx run` 和 `bx call` 也是在 CLI 进程里跑 JS，通过 RPC 调 daemon

## 4. 函数库：`lib/<域名>.js`

### 写法

就是一个普通的 ES 模块，导出几个 async 函数。全局有一个 `bx` 对象，不用 import：

```js
// ~/.bx/lib/bilibili.com.js

/* 站点笔记（bx lib show 时一起显示）：
 * - 路径里带 /wbi/ 的接口要签名，见 _bili-wbi.js
 * - 评论接口的 oid 要用 aid，不是 bvid，先用 view 接口换一下
 * - 请求太快会返回 -412，翻页之间停 1 秒
 */

/** 视频评论，按热度
 *  @example comments('BV1GJ411x7h7', { limit: 20 }) */
export async function comments(bvid, { limit = 20 } = {}) {
  const tab = await bx.tab('bilibili.com')          // 复用已打开的 B 站标签，没有就后台开一个
  const v = await tab.fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
  const j = await tab.fetch(`https://api.bilibili.com/x/v2/reply?type=1&sort=1&oid=${v.data.aid}`)
  return j.data.replies.slice(0, limit).map(r => ({ author: r.member.uname, text: r.content.message }))
}

/** 有这个函数时，bx read 打开这个域名的网址会优先用它 */
export async function read(tab) {
  return tab.eval(() => ({ title: document.title, desc: document.querySelector('.desc-info')?.innerText }))
}
```

- 参数就是普通参数，不声明 `args` / `opts`。CLI 调用时：位置参数按顺序传，`--limit 20` 合成最后一个对象参数
- **参数类型看默认值**：`bx lib list` 解析函数签名，`limit = 20` 就是数字，`full = false` 就是开关（`--full`），没有默认值的就是字符串。CLI 按这个转换类型，帮助信息也从这里生成，不用另外声明
- 第一行注释是说明，`@example` 是用法示例，`bx lib list` 会显示出来
- **文件顶部的注释是站点笔记**：接口在哪、字段什么意思、有什么坑。下次来修或者加函数时先看它，不另开目录
- 要在页面里跑的代码，用 `tab.eval(fn)`。以前的 reader 就变成一个 `read` 函数里调一下 `tab.eval`
- 文件名以 `_` 开头的只用来放共享代码，不算函数库

### 放哪、怎么找

| 位置 | 优先级 |
|---|---|
| `<项目>/.bx/lib/` | 最高 |
| `~/.bx/lib/` | 中 |
| 仓库 `lib/` | 内置，最低 |

`bx.lib('www.bilibili.com')` 先找完整域名，找不到再找上一级 `bilibili.com`。

### 出错时怎么报

函数里出错就 `throw new BxError(code, 说明, 建议)`（现有的类，全局可用）。下面几种情况统一用这几个 code，AI 看到 code 就知道怎么处理，不用读每个函数的实现：

| code | 什么情况 | AI 该怎么办 |
|---|---|---|
| `NEED_LOGIN` | 没登录，或者登录过期 | 告诉用户去浏览器里登录 |
| `BLOCKED` | 验证码、风控、请求太频繁 | 停一停，或者请用户在浏览器里处理 |
| `EMPTY` | 正常执行了，但没有结果 | 换个关键词或参数 |
| `NOT_FOUND` | 帖子、用户、视频不存在 | 检查参数 |
| `CHANGED` | 接口或页面结构变了，解析不出来 | 去修这个函数 |

其余情况随便起 code，带上说明和建议就行。

## 5. 全局的 `bx` 对象

`bx run` 的代码和函数库里的函数，用的是同一个 `bx`。它就是现在 `src/sdk/index.ts` 里的东西整理一下：

```js
bx.tab(idOrMatch)     // 按编号（t5）或网址匹配拿到一个标签；匹配不到就后台新开
bx.open(url)          // 后台新开一个标签
bx.tabs(filter?)      // 列出标签
bx.read(urlOrTab)     // 通用阅读，返回 markdown
bx.lib(domain)        // 某个域名的函数库
bx.log(...)  bx.sleep(ms)
```

`Tab` 就是现在的 `Tab` 类：`eval`、`fetch`、`goto`、`click`、`fill`、`press`、`snapshot`、`read`、`waitFor`、`waitResponse`、`shot`、`cookies`、`close`。后面只加一个方法：

```js
// 接口有签名、逆向不出来时（比如抖音、小红书）：让网站自己发请求，我们接住返回
for await (const res of tab.collect('/api/search', { more: () => tab.scroll() })) { ... }
```

它就是在 `net.wait` 外面套一个循环：等请求 → 交出结果 → 触发下一页 → 再等，连续几次没有新请求就结束。用的是 daemon 里现成的 CDP 网络记录，不往页面里注入代码去替换 fetch / XHR，网站察觉不到。

先试 `tab.fetch`：很多看起来有签名的接口，在页面里带着 cookie 直接请求就能用（比如知乎搜索，OpenCLI 就是这么做的）。不行再用 `collect`。

## 6. 命令

新增四个，其余现有命令不变：

```bash
bx read <网址或 -t 编号>               # 有 lib 的 read 就用它，否则通用提取
                                      # 输出末尾列出这个域名有哪些函数，让 AI 知道还能干什么
bx run '<代码>' | -f 文件.js            # 执行 JS，支持顶层 await，return 的值打印出来
                                      # 结果太大就写到 ~/.bx/out/ 下，只打印摘要和路径
                                      # 代码按 ES 模块执行，可以 import node:fs 等
bx call <域名> <函数> [参数...] [--选项 值]
                                      # 比如 bx call bilibili.com comments BV1xx --limit 20
                                      # 第一个参数写 - 就从 stdin 一行一条地读，结果输出 JSONL
                                      # 读进来的是 JSON 记录时，默认取它的 url 字段当参数
bx lib list [域名]                     # 有哪些函数：签名 + 说明 + @example
```

删掉的：`bx reader list`、`bx site list`、`bx <站点> <命令>`、`bx script new / test`（都被 `lib` 和 `call` 替代）。`trace` 先保留不动，以后看还有没有用。

## 7. 一个网站从陌生到熟悉

```
第一次遇到 → bx read 看一眼
不够用     → bx run 里试：bx.open、tab.eval 看页面数据、bx net log 找接口、tab.fetch 调一下
试通了     → 把这段代码改成函数，存进 ~/.bx/lib/<域名>.js
以后       → bx call 或 bx.lib(域名).函数()；bx read 的输出也会提示有这个函数
```

动手摸索一个新网站之前，先看看 [OpenCLI](https://github.com/jackwener/opencli) 的 `clis/<站点>/` 有没有现成的实现（Apache-2.0，181 个站点）。它的 `func(page, kwargs)` 大多只用了 `page.goto` 和 `page.evaluate`，接口地址和字段处理可以直接拿来改成 bx 的函数。

## 8. 页面操作要补的能力

对照了 playwright-cli 和 chrome-devtools（chrome-devtools-mcp 自带的 CLI）以后，挑出来的能多搞定一类页面的东西。都是在现有的 `actions.ts` / `snapshot.ts` 上加功能，不改架构。CLI 命令和 `Tab` 的方法一一对应，下面只写 CLI 的形式。

### 8.1 先验证再做

这两条在插件模式下能不能做，要先实测。

**跨域 iframe**

现在 snapshot 只展开同源的 iframe，跨域的直接跳过。但支付表单、第三方登录、验证码、嵌入的编辑器都在跨域 iframe 里。chrome-devtools 的 snapshot 是会展开它们的。

做法：用 `Target.setAutoAttach` 拿到每个跨域 iframe 的子 session。snapshot 把它们拼进同一棵树，编号照常分配；点击、填写时按编号找到对应的子 session 去执行。

要验证：插件模式下 `chrome.debugger` 能不能往子 session 发命令，Vivaldi 上行不行。

**后台标签不被降速**

bx 默认在后台开标签，但浏览器会让后台标签的定时器变慢、`requestAnimationFrame` 暂停，靠“滚进可视区域”触发的懒加载可能不动。结果就是标签切到前台能成功，放在后台就卡住。

做法：attach 时打开 `Emulation.setFocusEmulationEnabled`，必要时用 `Page.setWebLifecycleState` 防止标签被冻结。

要验证：在 B 站评论、知乎这类懒加载的页面上，对比打开前后的效果。

### 8.2 元素定位

现在只认 snapshot 编号，而且必须先 snapshot。函数库里的代码不能依赖编号，因为页面一变编号就变了。

```bash
bx click e15                                   # snapshot 编号（不变）
bx click "#main button.submit"                 # CSS 选择器，要能穿透 open shadow DOM
bx click "getByRole('button', { name: '提交' })" # 和 Playwright 一样的写法
bx fill "getByLabel('邮箱')" a@b.com
bx click "getByText('下一步')"
bx find "加入购物车"                            # 在 snapshot 里搜，返回匹配的那几行和编号，不用看整页
```

- `getByRole` / `getByLabel` / `getByText` 按无障碍树里的角色和名字去匹配。snapshot 本来就是从无障碍树生成的，不需要接 Playwright
- 匹配到多个元素就报错，并列出候选，不随便挑一个
- **编号失效了自动重新找**：snapshot 时给每个编号记下“角色 + 名字 + 是第几个同名元素”。页面重新渲染后（React 组件刷新、弹层重建）原来的元素没了，就按这三样在新的无障碍树里再找一次，找到唯一一个就照常操作，并在结果里注明“重新定位过”。不用每次操作前都重新 snapshot（做法参考 OpenCLI 的 `docs/design/browser-agent-runtime.md`，它分析了 agent-browser 的源码）
- `bx eval` 也接受目标：`bx eval "el => el.href" e5`

### 8.3 按坐标操作

给 snapshot 里看不到元素的页面兜底，比如 canvas、地图、在线文档画布、滑块：

```bash
bx shot --marks                    # 现有：截图并标出编号
bx mouse click 320 240 [--right] [--double]
bx mouse drag 100 200 400 200      # 中间按多步移动
bx mouse move 320 240 | down | up | wheel 0 300
bx key down Shift | key up Shift   # 按住不放
```

### 8.4 表单和文件

```bash
bx fill e3=张三 e5=138... e7=true    # 一次填多个：文本框填字，勾选框填 true/false，下拉框填选项
bx upload e9 a.pdf                   # e9 可以是文件框，也可以是“点了会弹选文件窗口”的按钮
bx click e5 --download [--save 目录] # 等下载完成，返回文件路径
```

- 一次填多个：只是把多次 fill 合成一次调用，不做按标签名找字段那套。每个字段填完读回来，返回实际的值
- upload 给的是按钮时：先打开 `Page.setInterceptFileChooserDialog`，点击，截住选文件的窗口，再把文件交给它
- 下载：插件模式用 `chrome.downloads`，CDP 模式用 `Browser.setDownloadBehavior`

### 8.5 操作结果

- **开了新标签要汇报**：点击引起的 `target=_blank` / `window.open`，在结果里写明“开了新标签 t9”。新标签在后台打开，不抢焦点
- **`--snap`**：操作完顺带返回新的 snapshot（只含可操作元素），省掉一次调用

### 8.6 小补充

- `bx click e15 --middle`，`--modifiers Shift,Control`（Ctrl+点击开新标签、Shift+点击多选）
- `bx type "..." --submit`

## 9. 实施顺序

1. `bx run` + 全局 `bx` 对象（把 `src/sdk/index.ts` 的 `makeCtx` 改成 `bx`）
2. 函数库加载 + `bx call` + `bx lib list`
3. `bx read` 接上 lib 的 `read`，末尾附上函数列表
4. 把 `sites/*` 和 `readers/*` 迁移成 `lib/<域名>.js`，删掉旧命令，更新 SKILL.md
5. `tab.collect`
6. 页面操作：先验证 8.1 的两条；然后做 8.2 元素定位、8.3 按坐标操作；最后做 8.4 到 8.6

## 10. 先不做（有需要再说）

- 写操作确认、标签归属和借用、按域名的隐私策略
- 每个任务一个常驻内核、后台任务、运行记录重放
- Playwright 接入、虚拟浏览器端点
- 判断模型（judge / keep / rank / follow）。真要用时，就是函数库里一个调接口的普通函数
- fillForm：等真要用了，写成函数库里的一个普通函数
- 标签编号跨重启不变
- 页面操作里用得少的：只处理眼前这一个原生弹窗（现在是统一自动处理）、HTML5 原生拖放和从页面外拖文件进来（`drop`）、手机模式和地理位置模拟、改窗口大小
- 开发者调试类：性能分析、Lighthouse、内存快照、录视频、断网和限速

## 附：例子 —— 跨站调查一个技术问题

问题：**“SQLite 能不能用作生产环境的后端数据库？Litestream、LiteFS、libSQL 这几个方案现在怎么样？”**

要看的地方：

- Hacker News：英文圈的讨论，有公开接口
- Reddit：函数库里已经有 `reddit.com.js`
- 知乎：中文圈的经验；要登录，在已登录的标签里请求接口
- GitHub：各项目还活不活跃
- 官方文档：具体限制写在哪

整个过程分四步。每一步是一次 `bx run`，中间结果写进文件，下一步接着读。知乎标签开着、登录状态在 daemon 里，所以 `bx run` 每次跑完退出也不会丢东西。

### 第 1 步：三个站并行搜一遍，只返回摘要

```js
// research/step1.js —— bx run -f research/step1.js
import fs from 'node:fs'

const yearAgo = Math.floor(Date.now() / 1000) - 365 * 86400

// HN：公开接口，不用浏览器，直接用普通 fetch
async function hn(q) {
  const u = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${yearAgo}&hitsPerPage=50`
  const { hits } = await (await fetch(u)).json()
  return hits.map(h => ({ site: 'hn', id: h.objectID, title: h.title, url: `https://news.ycombinator.com/item?id=${h.objectID}`,
                          comments: h.num_comments, time: h.created_at }))
}

// 知乎：在已登录的知乎标签里直接请求搜索接口，按 paging.next 翻页
// （如果将来要签名了，就换成 tab.collect，让页面自己发请求）
async function zhihu(q) {
  const tab = await bx.tab('zhihu.com')   // 复用已登录的知乎标签，没有就后台开一个
  const out = []
  let url = `https://www.zhihu.com/api/v4/search_v3?q=${encodeURIComponent(q)}&t=general&offset=0&limit=20`
  while (url && out.length < 40) {
    const j = await tab.fetch(url)
    for (const { object: o } of j.data) {
      if (o?.type === 'answer') out.push({ site: 'zhihu', title: o.question?.name?.replace(/<[^>]+>/g, ''),
        url: `https://www.zhihu.com/question/${o.question.id}/answer/${o.id}`, comments: o.comment_count })
    }
    url = j.paging?.is_end ? null : j.paging?.next   // next 有时是 api.zhihu.com 的地址，实际写时要换成 www.zhihu.com/api/v4
  }
  return out
}

const [a, b, c] = await Promise.all([
  hn('sqlite production'),
  bx.lib('reddit.com').search('sqlite production', { time: 'year', limit: 50 }),
  zhihu('SQLite 生产环境'),
])
const posts = [...a, ...b, ...c]
fs.mkdirSync('research', { recursive: true })
fs.writeFileSync('research/posts.json', JSON.stringify(posts, null, 1))

// 只给 AI 看一行一条的摘要，按评论数排序
return posts.sort((x, y) => (y.comments ?? 0) - (x.comments ?? 0)).slice(0, 40)
  .map((p, i) => `${i} [${p.site}] ${p.comments ?? '-'}评 ${p.title}`)
```

（知乎接口的写法参考了 OpenCLI 的 `clis/zhihu/search.js`，字段名以实际返回为准。）

AI 看完这 40 行，挑出真正在讲生产环境经验的，比如 0、2、5、7、11、16 号。

### 第 2 步：把挑中的帖子的评论拉下来

```js
// research/step2.js
import fs from 'node:fs'
const posts = JSON.parse(fs.readFileSync('research/posts.json', 'utf8'))
const picked = [0, 2, 5, 7, 11, 16].map(i => posts[i])   // AI 改这一行就行

async function comments(p) {
  if (p.site === 'hn') {
    const item = await (await fetch(`https://hn.algolia.com/api/v1/items/${p.id}`)).json()
    const flat = n => [n, ...(n.children ?? []).flatMap(flat)]
    return flat(item).filter(c => c.text).map(c => c.text.replace(/<[^>]+>/g, ' ')).slice(0, 80)
  }
  if (p.site === 'reddit') return (await bx.lib('reddit.com').comments(p.url, { limit: 80 })).map(c => c.text)
  return [(await bx.read(p.url, { budget: 4000 })).content]   // 知乎回答：直接读正文
}

const threads = await Promise.all(picked.map(async p => ({ title: p.title, url: p.url, comments: await comments(p) })))
fs.writeFileSync('research/threads.json', JSON.stringify(threads, null, 1))
// 每条评论只截前 300 字给 AI，完整内容在文件里
return threads.map(t => ({ title: t.title, url: t.url, comments: t.comments.map(c => c.slice(0, 300)) }))
```

结果比较大时，bx 会自动写到 `~/.bx/out/` 并只打印摘要，AI 再按需打开文件读。

### 第 3 步：看项目状态和官方文档

```bash
bx run '
const repos = ["benbjohnson/litestream", "superfly/litefs", "tursodatabase/libsql"]
return Promise.all(repos.map(async r => {
  const j = await (await fetch("https://api.github.com/repos/" + r)).json()
  return { repo: r, stars: j.stargazers_count, issues: j.open_issues_count, pushed: j.pushed_at, archived: j.archived }
}))'

bx read https://fly.io/docs/litefs/        # 读文档，看限制条件怎么写的
```

到这一步，AI 手里有：几百条讨论里挑出来的几十条经验、三个项目的活跃度、官方写明的限制，可以写结论了。主模型从头到尾没看过任何一个原始网页。

### 第 4 步：把摸通的部分存下来

HN 的搜索和评论这次是现场写的，以后还会用，就存进函数库：

```js
// ~/.bx/lib/news.ycombinator.com.js

/** 搜索帖子（Algolia 公开接口）
 *  @example search('sqlite production', { days: 365 }) */
export async function search(q, { days = 365, limit = 50 } = {}) { /* 第 1 步里的 hn() */ }

/** 帖子的全部评论，拍平成列表
 *  @example comments('https://news.ycombinator.com/item?id=12345') */
export async function comments(url, { limit = 200 } = {}) { /* 第 2 步里的那段 */ }
```

知乎搜索也一样，存成 `www.zhihu.com.js` 里的 `search()`。下次调查别的问题，第 1 步就缩成了：

```bash
bx call news.ycombinator.com search "bun in production" --days 180 -o jsonl \
  | bx call news.ycombinator.com comments - --limit 50
```

### 这个例子说明了什么

- **每次 `bx run` 跑完就退出也不影响**：标签和登录状态在 daemon 里，中间结果在文件里
- **几种取数据的方式在一段代码里混着用**：公开接口用普通 `fetch`，已经摸通的网站调函数库，要登录的在标签里 `tab.fetch`（真有签名的再换 `collect`）
- **主模型只看摘要**：搜索结果一行一条，评论截断，完整数据都在文件里，需要时再打开
- **现场写的代码直接变成函数**：第 1、2 步里的函数原样搬进 `lib/`，不用改写法
