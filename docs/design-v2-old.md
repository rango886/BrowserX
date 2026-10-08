# BrowserX 第二版设计

> 状态：设计稿，还没开始实现。第 10 节列出了动手前要先验证的几件事。

## 0. 一句话目标

给 AI 开一扇窗：借用户已经登录的浏览器，从海量网页里取回实时、整理好的信息，必要时替用户在网页上做事。

## 1. 从第一性原理出发

### AI 已经会什么

网址、域名、HTML/DOM、JS、`fetch`、JSON、CSS 选择器、正则、Playwright 的写法，还有各大网站的接口大概长什么样。这些在训练数据里出现得太多了，AI 用起来不需要翻译。

**所以设计原则是：能用 AI 已经熟悉的东西，就不发明新概念。** 每多一个新概念（站点、命令、reader、分段、类型、ref……），AI 在“我想做什么”和“系统里该怎么表达”之间就要多翻译一次。这层翻译就是“膜”。

### AI 还缺什么

| 缺什么 | 用什么补 |
|---|---|
| 登录状态 | 借用户的浏览器（插件），或者 bx 自己启动的专用浏览器 |
| 看页面太费 token | `read`：把页面压成精简的 markdown，并说明页面处于什么状态 |
| 每个网站的门道记不住 | 按域名存下来的函数（函数库） |
| 每次现场写代码，结果不稳定 | 存下来的函数带测试 |
| 大批量判断时主模型又慢又贵 | 便宜的判断模型（Jev） |
| 每一步都是一次工具调用，来回太多 | `bx run`：写一段 JS，一次跑完，状态留着 |
| 写操作有风险 | 在入口统一把关，由用户在浏览器里确认 |

### 第一版的问题（为什么要改）

- reader（在页面里执行，按网址匹配）和站点脚本（在 Node 里执行，按命令调用）做的是同一件事，逻辑要写两遍，AI 也不知道该用哪个
- 站点脚本是“命令 + 参数”，命令名是作者自己起的，各个命令之间也不一致
- 想要什么功能，就得往框架里加一个开关，零件没法自由组合，能力的上限低

第二版只留一个概念：**函数**。读、判断、组合、记忆，都是函数。

---

## 2. 全局概况

```
 AI（或者人）
   │  bx 命令：每次执行完就退出
   ▼
 ┌─────────────────────── daemon（常驻后台）───────────────────────┐
 │  ① 浏览器连接：插件 / CDP                                         │
 │  ② 标签登记：编号不随重启改变、归属、标签组、网络记录、拦截规则      │
 │  ③ 虚拟浏览器：给每个内核一个 CDP 端点，里面只有它能看到的标签       │
 │  ④ 内核管理：启动、超时、后台任务、待确认请求、交接                  │
 └───────┬──────────────────────────────────┬──────────────────────┘
         │ RPC + CDP                          │
   ┌─────▼──────┐                       ┌─────▼──────┐
   │ 内核 research│                       │ 内核 pan    │   每个任务一个独立进程
   │  ⑤ JS 运行环境：变量一直保留           │   Playwright 跑在这里
   │  ⑥ 页面工具：page / read / collect / fillForm
   │  ⑦ 判断：judge / keep / rank / pick / follow
   │  ⑧ 函数库：lib(域名).函数()
   └────────────┘                       └────────────┘
```

各部分的分工：

- **① 浏览器连接**负责“进得去”：带着登录状态打开和控制标签
- **② 标签登记**负责“认得清”：哪个标签是谁的，上面发生过什么
- **③ 虚拟浏览器**负责“隔得开”：每个内核只能看到自己的标签，用户其他的标签它碰不到
- **④ 内核管理**负责“管得住”：超时、后台运行、写操作确认、出错交接
- **⑤ 运行环境**负责“组合起来”：用普通 JS 把下面的东西拼起来，变量跨多次调用保留
- **⑥ 页面工具**负责“看得见、动得了”：取数据、读页面、填表、点击
- **⑦ 判断**负责“判断得快”：是不是、选哪个、打几分
- **⑧ 函数库**负责“记得住”：把摸清楚的门道存成函数，下次直接用

### 核心原则：状态按“能活多久”分开放

| 状态 | 放在哪 | 能活多久 |
|---|---|---|
| 浏览器连接、标签编号、标签组、标签归谁 | daemon，编号对应关系写进硬盘 | daemon 重启以后编号不变 |
| 网络记录、控制台、弹窗、拦截规则 | daemon，按标签存 | 标签关掉为止 |
| JS 变量、`page` 对象、函数库的缓存 | 内核 | 内核结束为止 |
| 运行记录、大结果、fetch / Jev 缓存、函数库 | 硬盘 `~/.bx/` | 一直都在 |

**要长期保存的东西用编号存在 daemon 或硬盘上；内核里的对象只是临时的，随时可以按编号找回来。** 内核崩了、被杀掉了，标签和记录都还在，重新取回 `page` 就能接着干。

---

## 3. 底层：浏览器连接（①）

继续沿用现在的两种驱动，`Driver` 接口不变（`src/daemon/types.ts`）：

| 驱动 | 用在哪 | 列标签 | attach |
|---|---|---|---|
| 插件（extension） | 用户日常用的浏览器，复用登录状态，首选 | `chrome.tabs.query`，带窗口、标签组、是否激活、是否休眠 | `chrome.debugger.attach`，按标签、用到时才 attach |
| CDP | `bx browser launch` 启动的专用浏览器，或者带调试端口启动的浏览器 | `Target.getTargets` | `Target.attachToTarget`，用到时才 attach |

保留的规矩：

- **用到时才 attach**：只列标签不碰页面；第一次要操作某个标签时才 attach；休眠的标签先唤醒
- **CDP 功能按需开启**：用到哪个开哪个，尽量少开，降低被网站识别的概率
- **一个标签只 attach 一次**：`chrome.debugger` 对同一个标签只允许挂一个调试会话，daemon 自己的代码和 Playwright 共用这一个，由 daemon 负责分发（见第 5 节）

---

## 4. daemon：标签登记（②）

### 标签编号不随重启改变

现在 daemon 一重启，标签就会重新编号。第二版把“短编号 ↔ 浏览器自己的标签 id”的对应关系写进 `~/.bx/tabs.json`，重启后按浏览器的 id 对回去，`t5` 还是 `t5`。插件模式下，浏览器重启后 tabId 会变，这时就按“窗口 + 位置 + 网址”尽量对上，对不上的再分配新编号。

### 标签归谁

每个标签都有一个“主人”：

| 标签来源 | 主人 | 规则 |
|---|---|---|
| 内核用 `open()` 开的 | 这个内核 | 可以随便操作；内核结束时自动关掉，除非打开时加了 `keep` |
| 从内核的标签里弹出来的新标签 | 同一个内核 | 同上 |
| 用户自己的标签 | 用户 | 默认**只读**；要操作必须明确写 `tab('t3', { borrow: true })`，而且不能让它跳转到别的网站 |
| 别的内核的标签 | 那个内核 | 可以读，要操作得先借用 |

这跟第一版 SKILL.md 里“不要跳走用户的标签”是同一条规矩，只是从一条提醒变成了框架强制执行。

### 网络记录

所有 CDP 消息都要经过 daemon，所以 daemon 天然能看到网络请求，按标签记下来（沿用 `session.ts` 的 `NetEntry`）。不管是 `bx net log`、内核里的 `page.net()`，还是 `collect`，用的都是这同一份记录。

---

## 5. daemon：虚拟浏览器（③）

### 为什么需要它

Playwright 的 `connectOverCDP` 一连上浏览器就会接管所有页面：每个页面都 attach、开启一整套 CDP 功能、注入脚本，用户以后新开的标签也会自动被接管。插件模式下用户开着上百个标签，这样做不行：

- 每个标签都会出现“正在调试此浏览器”的提示条，休眠的标签可能被唤醒
- 用户所有的页面都会被碰到，有隐私问题，也更容易被网站识别
- `chrome.debugger` 本来就没有浏览器级的 `Target.*` 命令，Playwright 直接连不上

### 怎么做

daemon 给每个内核开一个 CDP 端点：`ws://127.0.0.1:<端口>/cdp/<内核名>?token=...`。Playwright 连上来以后，以为面对的是一整个浏览器，**其实里面只有这个内核有权看到的标签**：

| Playwright 发来的命令 | daemon 怎么回 |
|---|---|
| `Browser.getVersion` | 返回真实浏览器的版本 |
| `Target.setDiscoverTargets` / `Target.getTargets` | 只返回这个内核拥有或者借来的标签 |
| `Target.setAutoAttach` | 只对这些标签发 `attachedToTarget`；以后内核每拿到一个新标签，就补发一个 |
| `Target.createTarget`（`context.newPage()`） | 在后台开一个新标签，主人是这个内核，默认不放进标签组 |
| `Target.closeTarget` | 只允许关这个内核自己的标签 |
| `Storage.getCookies` 等浏览器级命令 | 插件模式下改用 `chrome.cookies` 来实现 |
| `Target.createBrowserContext` | 插件模式下不支持，返回错误；Playwright 会改用默认的上下文 |
| 页面级命令（带 `sessionId`） | 转发给对应标签的调试会话 |

内核里 `tab('t7')` 这类调用，daemon 会先检查权限，然后往这个内核的虚拟浏览器里“放进”t7，Playwright 就能看到这个页面了。

### 同一个标签，两方共用

一个标签只有一个调试会话，但 daemon 自己（网络记录、`read`、写操作把关）和 Playwright 都要用它：

- **命令**：两边的命令都由 daemon 发出去，按请求编号把回复分给各自
- **事件**：页面上发生的事件会同时发给两边
- **页面初始化**：Playwright 接管一个页面时会开启 Runtime 等功能。这只发生在内核明确拿到的标签上；纯粹读一读的操作（`bx read`、`page.fetch`）可以不经过 Playwright，走 daemon 的轻量通道
- **请求拦截（CDP 的 Fetch 功能）只能有一个主人**：由 daemon 统一管。daemon 开启拦截时，用的是“daemon 自己的规则 + Playwright `route` 的规则”的并集；拦下请求以后，属于 Playwright 规则的交给 Playwright 处理，其余的由 daemon 处理（拦截规则、写操作把关）

---

## 6. daemon：内核管理（④）

### 内核是什么

每个任务一个内核，跟 Jupyter 的内核一样，是一个独立的 Node 进程：

- **为什么用独立进程**：AI 写了死循环可以直接杀掉，daemon 不受影响；任务之间也互不影响
- **名字**：`bx -s research ...`，或者设置环境变量 `BX_SESSION=research`；不指定就用 `default`
- **启动**：第一次用到这个名字时自动启动，连上自己的虚拟浏览器端点
- **空闲多久结束**：默认 30 分钟，可以配置。结束时关掉它拥有的标签（`keep` 的除外）

### 一次运行的过程

```
CLI ──代码──▶ daemon ──转给内核──▶ 执行
                                │  console.log、进度 → 实时转回 CLI，走 stderr
                                │  碰到写操作 → 暂停，等待确认
                                ▼
CLI ◀──结果── daemon ◀── 返回值
```

- **结果太大**：完整结果写进 `~/.bx/sessions/<内核>/out/<n>.json`，返回给 AI 的只有摘要（几条记录、什么结构）和文件路径
- **超时**：默认 2 分钟。时间到了会返回“还在运行”和一个任务号，**任务本身不会停**
- **取消**：Ctrl+C 或者 `bx job cancel`，内核里所有 bx 函数都会响应取消信号；卡在同步死循环里的话，就直接重启内核

### 后台任务

AI 调用工具一般都有超时限制，长任务不能跟 CLI 绑在一起：

```bash
bx run --bg 'return await bigResearch()'   # 马上返回任务号 j3
bx job wait j3 --timeout 60                # 等一会儿，还没完就再等
bx job log j3                              # 看进度
bx job cancel j3
```

不加 `--bg` 的话，超时以后也会自动转成后台任务，结果不会白白丢掉。

### 写操作的确认

**什么算写操作**（由 daemon 在入口统一判断，不靠函数作者自觉）：

- 非 GET 的请求：页面里的 `fetch` / `XMLHttpRequest`，以及 `page.fetch` 发出的
- 提交表单
- 点击语义上是“提交 / 发送 / 删除 / 付款 / 确认”的按钮（按无障碍名称和类型判断）
- 函数库里标了 `@write` 的函数

**怎么确认**：

1. 内核执行到写操作就暂停，daemon 记下一条待确认的请求，内容是一份计划：“要向哪个域名做什么”
2. **由用户在浏览器里确认**：插件弹出窗口，可以选“允许 / 拒绝 / 这个任务里同类操作都允许”。不能让 AI 自己确认，否则这道关就没有意义了
3. CLI 这时返回“等待确认”（退出码 4）并带上计划内容，AI 把情况告诉用户，再用 `bx job wait` 等结果
4. 用户可以在配置里提前放行，比如“github.com 上的 issue 评论直接允许”。`--allow-write` 只有在提前放行的范围内才有效
5. 付款这类操作默认禁止，要单独打开

一个流程只需要确认一次计划，不用每次点击都问。`fillForm` 的预览也走这一套。

### 出错交接

函数库里的函数在某一步卡住时，会抛出一个“交接”错误：带着标签编号、卡在第几步、为什么卡住，以及当前页面的状态。内核会把它存进变量 `$handoff`，`page` 也还停在原地，AI 可以接着手动处理（例子见第 13 节）。

遇到验证码、扫码登录、两步验证时，用 `page.askUser('请完成验证码')`：把标签切到前台，等页面状态变了再继续。

---

## 7. 内核：JS 运行环境（⑤）

### 变量一直保留

- 跟 Node 的 REPL、Chrome 控制台一样，顶层的 `const` / `let` / `function` 会自动变成内核的全局变量
- 支持顶层 `await`
- 每次运行的返回值都会自动存成 `$1`、`$2`……；最近一次的结果是 `$_`

### 全局能用的东西

```js
// 页面（⑥）
open(url, opts?)             // 后台开一个新标签，返回 Playwright 的 Page，主人是这个内核
tab(id, { borrow? })         // 按编号取回一个标签的 Page
tabs(filter?)                // 列出可以看到的标签（只有编号、标题、网址，不会 attach）
read(urlOrPage, opts?)       // 通用阅读
fetch                        // 普通的 fetch（不带登录状态，适合公开接口）

// 判断（⑦）
judge  keep  rank  pick  follow

// 函数库（⑧）
lib(domain)                  // 某个域名的函数库

// 工具
sleep(ms)  log(...)  save(name, data)  load(name)   // save / load 存取 ~/.bx/sessions/<内核>/data/
exec(cmd, args)              // 调本机命令行工具，比如 gh、yt-dlp（受配置限制）
```

### 运行记录

每次运行的代码和结果摘要都追加到 `~/.bx/sessions/<内核>/history.jsonl`：

- 人可以回头看 AI 都做了什么
- 内核重启以后，可以用 `bx session replay` 把之前的代码按顺序重放一遍，把变量重建出来（写操作不会重放）
- 一段摸通了的代码，可以从这里直接拿去存成函数

---

## 8. 内核：页面工具（⑥）

### 8.1 Page 就是 Playwright 的 Page

`open()` 和 `tab()` 返回的就是 Playwright 的 `Page`，AI 熟悉的写法都能直接用：`getByRole`、`getByLabel`、`getByText`、`locator`、`click`、`fill`、`selectOption`、`setInputFiles`、`waitForResponse`、`route`、`evaluate`、`ariaSnapshot`……

BrowserX 在上面加了几个方法（作为扩展挂上去，不改变 Playwright 原有方法的行为）：

| 方法 | 作用 |
|---|---|
| `page.id` | 标签编号，比如 `t7` |
| `page.fetchJson(url, init?)` | 用这个页面的 cookie 发请求，返回 JSON；非 2xx 时报错，并说明原因 |
| `page.net(filter?)` | 这个标签的网络记录（来自 daemon，不需要提前开启） |
| `page.collect(match, opts)` | 一边操作页面，一边截获它自己发的请求，结果作为数据流返回（见 8.3） |
| `page.state()` | 页面现在是什么状态：正常 / 要登录 / 验证码 / 不存在 / 没加载完 / 刚提交成功 / 校验出错 |
| `page.snapshot()` | 给 AI 看的可操作元素列表，带编号（`e12`），临时探索时用 |
| `page.fillForm(data, opts)` | 整表填写（见 8.4） |
| `page.askUser(message)` | 切到前台，请用户处理，处理完继续 |
| `page.handoff(reason)` | 生成一个交接错误 |

**定位元素的写法**：要存进函数库的代码，一律用语义定位（`getByRole`、`getByLabel`、`getByText`）；`e12` 这种编号重新截一次就变了，只适合临时探索。

### 8.2 read：通用阅读

`read(url | page, opts)` 把页面压成精简的 markdown，给 AI 看：

1. 先判断页面状态（`page.state()`）。不正常的话，直接说明“需要登录 / 页面不存在 / 验证码”，不把它当正文去读
2. 这个域名的函数库里有 `read` 函数，就用它
3. 否则按内容类型选择提取方式：PDF 转成文字；文章用 readability；列表页识别出重复结构；以上都不是，就取页面上看得见的文字
4. **代码块、表格要保留**。像 tab 切换里藏着的代码示例（比如 OpenRouter 文档），也要取出来
5. 输出的末尾附上：
   - 还能展开的部分（比如评论区）
   - 这个域名的函数库里有哪些函数（一行签名和说明）
   - 页面自带的结构化数据，比如 `__INITIAL_STATE__`

参数：`budget`（字数上限）、`offset`（接着读）、`full`（不截断）、`links`（保留链接）、`scroll`（先往下滚几屏）、`via`（指定提取方式）。

### 8.3 collect：操作页面 + 截获返回

接口签名逆向不出来的网站（知乎、抖音、小红书），**签名就让网站自己的 JS 去算**，我们只负责触发动作，再接住返回结果：

```js
const stream = page.collect('/api/v4/search_v3', {
  trigger: 'reload',                       // 第一次怎么触发：reload、一个函数，或者不写（已经发过的也算）
  more: () => page.mouse.wheel(0, 3000),   // 要下一页时做什么
  until: res => res.paging?.is_end,        // 到底了没有
})
for await (const res of stream) { ... }    // 懒加载：要几条，它就翻几次
```

内部处理的细节：先开始监听，再触发动作，不会漏；响应一到就马上取内容；已经见过的请求不重复处理；翻页之间随机停一停；连续几次没有新请求就认为到底了。

拿数据的方式，从“最省事”到“最后手段”：

1. 直接调接口（`page.fetchJson`）
2. 操作页面 + 截获返回（`collect`）
3. 读框架里的数据：`__INITIAL_STATE__`、`__NEXT_DATA__`、`__NUXT__`、Apollo 缓存、React / Vue 组件的 props
4. 从 DOM 里抓：用 `aria-*`、`data-*` 和文字定位，不用自动生成的类名

对调用的人来说，这几种方式写出来的函数签名都一样，以后可以随时换实现。

### 8.4 fillForm：整表填写

```js
const r = await page.fillForm({ 姓名: '张三', 联系电话: '138...', 出生日期: '1990-01-01', 城市: '北京', 附件: './a.pdf', 同意协议: true },
                              { dryRun: true, submit: '提交' })
```

- 按标签文字找到每个字段（找不到完全一样的，就让 Jev 从页面标签里挑最像的；没把握时交给主模型确认）
- 判断控件类型，用对应的方法去填：普通输入框、原生下拉框、自定义下拉框、日期选择器、文件框、勾选框、富文本
- **填完马上读回来检查**
- 返回每个字段填成了什么，哪些没找到，页面上出了哪些校验提示
- `dryRun` 只预览；真正提交时走第 6 节的写操作确认

### 8.5 每次操作都汇报“发生了什么”

页面操作的结果，以及 CLI 里点击、输入的结果，都附带一份变化：页面跳转了、开了新标签、弹出了对话框、出现了新的提示或报错，以及 `page.state()` 的结果。AI 不用截图，也能知道刚才那一下有没有生效。

---

## 9. 内核：判断（⑦）

### 接口

跟 pi 的 `models.classify` 写法保持一致，AI 在两边学到的用法可以通用：

```js
judge(state, questions)              // 原始接口：一段 JSON + 几个问题，返回带概率的答案
keep(items, question, threshold=0.7) // 按“是/否”过滤
rank(items, question, levels)        // 打分后排序，每条记录会加上 score
pick(items, question)                // 多选一；超过 255 个选项时先分批打分，再从高分的里面选
follow(url, goal, { maxSteps, sameSite })   // 每一步挑最可能通向目标的链接，沿着走
```

问题的类型：`bool`（是/否，底层接口里叫 `noul`）、`choice`（多选一，最多 255 个选项）、`score`（打分，最多 10 档）。

### 函数内部替 AI 处理掉的事

- **只发需要的东西**：对记录默认只发 `title`、`url`，以及 `text` 的开头一段；对页面只发标题、小节标题、正文开头。总量截断到 32k token 以内。永远不发原始 HTML
- **数字和日期不交给它**：这类比较在代码里做完，再拿结果去问
- **缓存**：按“内容 + 问题”缓存在 `~/.bx/cache/judge/`
- **固定模型版本**：默认用固定版本号，不用会随更新变化的 `latest`，免得阈值悄悄失效
- **有把握就自己做，没把握就交给主模型**：在 `fillForm`、`follow`、`pick` 里，概率低于阈值时停下来，把候选项交给主模型去定

### follow 每一步发什么

```js
{ state: { goal, page: { url, title, headings, summary /* 正文开头 500 字 */ }, path /* 走过的页面 */ },
  questions: {
    found: { type: 'bool', instructions: '当前页面本身就包含目标内容吗？', criteria: {...} },
    next:  { type: 'choice', instructions: '下一步点哪个？',
             criteria: { l1: '「Benchmark」：正文，Benchmark 小节 → /docs/benchmark.md', ..., stop: '都不像，退回上一页' } } } }
```

候选链接在页面里用代码先整理好：只要看得见的链接；记下每个链接在页面的哪个区域、所在小节的标题；去掉已经去过的、本页锚点、登录 / 分享 / 隐私政策这类，以及重复的地址。Jev 只负责决定“往哪走”和“到没到”，最后一页由 `read` 读给主模型。

### 后端和隐私

- 后端可以配置：OpenRouter（`/api/alpha/decisions`）、TypeSafe 直连、本地 llama.cpp，或者不用
- 按域名设置隐私策略：邮箱、网盘、私信这类域名，默认只用本地后端，或者干脆不用
- 每次运行的结果里注明判断了多少次、花了多少钱；配置里可以设置每次运行的费用上限
- **没配后端时自动降级**：能用规则的就用规则（关键词、页面区域），规则不够用，就把候选列表交给主模型

### 不能用它做的事

- 不能当安全关卡：网页上的文字可能故意引导它答错。写操作的把关只靠第 6 节的硬规则
- 不能用来提取内容：它只做判断，不生成文字

---

## 10. 内核：函数库（⑧）

### 位置和加载

| 位置 | 作用范围 | 优先级 |
|---|---|---|
| `<项目>/.bx/lib/<域名>.js` | 在这个项目目录里执行时生效 | 最高 |
| `~/.bx/lib/<域名>.js` | 全局 | 中 |
| 仓库里的 `lib/<域名>.js` | 内置 | 最低 |

`lib('bilibili.com')` 会按优先级找到对应的文件，并按文件修改时间自动重新加载。查找时会先试完整的域名，再试上一级域名：`www.bilibili.com` 找不到，就找 `bilibili.com`。

### 写法

```js
// ~/.bx/lib/bilibili.com.js
import { wbiSign } from './_bili-wbi.js'          // 下划线开头的文件不会被当成函数库，只用来共享代码

/** 视频评论，按热度
 *  @example comments('https://www.bilibili.com/video/BV1GJ411x7h7', { limit: 20 }) */
export async function comments(url, { limit = 20, sort = 'hot' } = {}, ctx) { ... }

/** 打开这个域名的网址时，read() 会优先用它 */
export async function read(url, opts, ctx) { ... }

/** 下载视频  @write */
export async function download(url, { out = '.' } = {}, ctx) { ... }
```

- **参数**：最后一个参数是 `ctx`，由框架自动传入，里面有 `open`、`tab`、`fetch`、`judge`、`exec`、`log`、`signal`（取消信号）等。函数本身不依赖全局变量，方便测试
- **注释里的标记**：
  - `@example`：测试用例，同时也是给 AI 看的用法示例
  - `@write`：标记会改动数据的函数，执行前要确认
  - `@public`：表示不需要登录、不需要浏览器（比如 HN 的公开接口）
- **返回的记录**：尽量带上 `url`、`title`、`author`、`time`（ISO 格式）、`text`，其余字段随意。这只是习惯，不强制，但跨站合并时会很省事
- **数据来源随便选**：浏览器标签、直接 HTTP 请求、本机命令行工具（`gh`、`yt-dlp`）

### 测试和维护

- `bx lib test [域名]`：把 `@example` 全部跑一遍，检查有没有报错、返回的结构对不对；配了 Jev 的话，再问一句“这看起来像正常的结果吗？”，发现那种不报错、但返回垃圾数据的情况
- 测试时会把真实的响应录下来，存进 `~/.bx/cache/fixtures/`，之后可以离线回放，测试解析逻辑
- 坏了就回到 REPL 去修：看看接口变成了什么样，改完存回去。函数本来多半就是 AI 写的，修起来也最顺手

### 一个网站从陌生到熟悉

```
第一次遇到 → bx read 看一眼
不够用     → bx run 里探索：open、page.net 找接口、page.fetchJson 试一下、collect 截获返回
试通了     → 存成 lib/<域名>.js 里的函数，带上 @example
以后       → lib(域名).函数(...)；read 的输出也会提示这个域名有哪些函数
坏了       → bx lib test 报出来 → 回到 REPL 修好 → 存回去
```

---

## 11. CLI 新设计

### 原则

1. **所有命令都在内核里执行**：`bx read`、`bx click` 这些都是“在内核里执行一句代码”的简写，跟 `bx run` 用的是同一份状态
2. **顶层命令少而稳定**：日常只需要 `read`、`run`、`call`，其他都是辅助命令
3. **元素定位直接用 Playwright 的选择器写法**：`e12`（snapshot 里的编号）、`role=button[name="提交"]`、`text=下一步`、`label=邮箱`，或者 CSS
4. **数据走 stdout，日志和进度走 stderr**；有交互终端时输出给人看的格式，被程序调用时输出 JSON

### 全局选项（写在命令前后都可以）

| 选项 | 作用 |
|---|---|
| `-s, --session <名字>` | 用哪个内核，默认 `default`；也可以设置环境变量 `BX_SESSION` |
| `-t, --tab <编号>` | 页面命令作用在哪个标签上；也可以设置环境变量 `BX_TAB` |
| `-b, --browser <名字>` | 连着多个浏览器时选一个 |
| `-o, --output <格式>` | `text` / `json` / `yaml` / `jsonl` / `csv` / `table` |
| `--timeout <秒>` | 超过这个时间就转成后台任务 |

### 命令一览

**读和执行（日常主要用这三个）**

```bash
bx read [网址]               # 读网址；不写网址就读 -t 指定的标签
     [--budget N] [--offset N] [--full] [--links] [--scroll N] [--via 方式] [--brief]
bx run [代码 | -f 文件 | -]  # 在内核里执行 JS
     [--bg]                  # 放到后台跑，马上返回任务号
     [--allow-write]         # 只在用户提前放行的范围内有效
bx call <域名> <函数> [参数...] [--选项 值...]
     # 调用函数库里的函数，比如 bx call bilibili.com comments BV1xx --limit 20
     # 第一个参数写 - 表示从 stdin 读：每行一条 JSON 或文本，每条调用一次，结果是 JSONL
     # [--concurrency N] 并发数   [--field 字段] 从输入记录里取哪个字段当参数（默认取 url）
```

**任务和内核**

```bash
bx job list | wait <id> [--timeout 秒] | log <id> | result <id> | cancel <id>
bx session list                      # 有哪些内核：名字、状态、拥有的标签、空闲了多久
bx session history [名字] [--last N] # 运行记录
bx session reset [名字]              # 重启内核：变量清空，标签保留
bx session replay [名字]             # 重放运行记录，把变量重建出来（写操作不重放）
bx session close [名字]              # 结束内核，关掉它拥有的标签
```

**浏览器、标签和标签组**

```bash
bx browser list | launch [名字] [--headless] | connect <cdp地址> --name x | disconnect <名字>
bx tab list [过滤词]                 # 所有标签：编号、主人、标题、网址；不会 attach
bx tab open <网址> [--keep] [--front] [--group 组]   # 默认在后台开，主人是当前内核
bx tab close [编号...] | activate [编号] | borrow <编号> | release <编号>
bx group list | create <编号...> --title x --color blue | ungroup <编号...>
```

**页面操作（都会返回变化和页面状态）**

```bash
bx snapshot [-i] [--max N]          # 可操作元素 + 编号
bx click <目标> [--double] [--right] [--force]
bx fill <目标> <文字> [--submit] [--append]
bx type <文字> | press <按键...> | hover <目标> | drag <从> <到>
bx select <目标> <选项...> | check <目标> | uncheck <目标> | upload <目标> <文件...>
bx fill-form --data <JSON 或 @文件> [--submit 按钮文字] [--dry-run]
bx scroll [down|up|top|bottom|<目标>] [--amount N]
bx goto <网址> | back | forward | reload
bx wait [--text x] [--gone x] [--selector x] [--url x] [--fn 表达式] [--idle] [--timeout 毫秒]
bx state                            # 页面现在处于什么状态
bx shot [<目标>] [--full] [--marks] [--save 文件]
bx eval <表达式> [--file x.js] [--isolated]
```

**网络和调试**

```bash
bx net log [过滤词] [--api] [--failed] [--status 4xx]
bx net show <id> [--headers] [--path data.list[0]]
bx net wait <匹配> [--timeout 毫秒]
bx route add <匹配> --abort | --fulfill <JSON 或 @文件> | --header "k: v"
bx route list | rm [id]
bx cookies [网址] | console [--level error] | dialogs [--policy accept|dismiss]
bx inject add <代码> [--file x.js] | list | rm <id>
```

**判断（主要在 `bx run` 里用，CLI 命令用于调试问题怎么写）**

```bash
bx judge --state <JSON 或 @文件> --bool "问题" | --choice "问题" a=说明 b=说明 | --score "问题" 低 中 高
```

**函数库**

```bash
bx lib list [域名]                  # 有哪些域名、哪些函数（签名 + 第一行说明）
bx lib show <域名> [函数]           # 函数的完整说明和 @example
bx lib new <域名>                   # 生成骨架文件，路径默认是 ~/.bx/lib/
bx lib test [域名] [函数] [--live] [--replay]
bx lib path <域名>                  # 文件在哪
```

**录用户演示**

```bash
bx record start [名字] [-t 编号]    # 请用户在这个标签里手动操作一遍
bx record stop                      # 生成报告：用户做了哪些操作、页面发了哪些请求、数据从哪个请求来
bx record show <名字>
```

（第一版的 trace 留下的就是这个用途。AI 自己探索时，用 REPL 加 `net` 更直接。）

**写操作确认、配置、daemon**

```bash
bx approvals                        # 待确认的写操作（给人在终端里看）
bx approvals allow <id> | deny <id> # 只能在交互终端里执行，并且要人按一次键确认
bx config get [键] | set <键> <值>  # 比如 judge.backend、judge.model、allow.<域名>
bx daemon start | stop | status | log
```

### 删掉或合并的命令

| 第一版 | 第二版 |
|---|---|
| `bx reader list`，`readers/` 目录 | 函数库里的 `read` 函数，`bx lib list` |
| `bx site list`，`bx <站点> <命令>` | `bx call <域名> <函数>`，`bx lib list` |
| `bx script new / test` | `bx lib new / test` |
| `bx trace start / stop / digest / show / find` | AI 自己探索用 `bx run` + `bx net`；录用户演示用 `bx record` |
| `bx tab use`（“当前标签”） | 去掉。总是用 `-t`，或者内核里的 `page` 变量，避免多个任务互相干扰 |
| `bx form fields / fill` | `bx fill-form` / `page.fillForm()` |

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 出错（输出里有错误码、原因和处理建议） |
| 2 | 用法错误 |
| 3 | 部分成功（批量处理时有几条失败了） |
| 4 | 在等用户确认写操作 |
| 5 | 半路交接：页面停在原地，详情在 `$handoff` 里 |
| 6 | 超时，已经转成后台任务，输出里有任务号 |

### 给 AI 的使用说明（新 SKILL.md 的核心）

```
1. 看网页：bx read <网址>。输出末尾会告诉你还能展开什么、这个域名有哪些函数
2. 稍微复杂一点的事，写一段 JS，用 bx run 一次跑完。变量会保留，下次接着用
   - 页面就是 Playwright 的 Page；定位元素用 getByRole / getByLabel / getByText
   - 大批量的筛选、排序，先用 keep / rank 粗筛，再自己读
3. 某个网站摸通了，就存进 ~/.bx/lib/<域名>.js，带上 @example，以后用 lib(域名).函数()
4. 退出码 4：告诉用户去浏览器里确认；退出码 5：页面在 $handoff.page，接着处理；退出码 6：bx job wait
5. 同时做几件事时，每件事用一个 -s 名字
```

---

## 12. 硬盘上的布局

```
~/.bx/
  daemon.json                 daemon 的端口、token、pid
  daemon.log
  tabs.json                   标签编号的对应关系
  config.yaml                 后端、key、提前放行的规则、隐私策略、费用上限
  profiles/<名字>/            专用浏览器的用户资料
  sessions/<内核>/
    history.jsonl             每次运行的代码和结果摘要
    out/<n>.json              大结果
    data/                     save() / load() 存的东西
    jobs/<id>.json            后台任务的状态和结果
  lib/<域名>.js               函数库（全局）
  cache/
    fetch/                    fetch 缓存
    judge/                    Jev 缓存
    fixtures/<域名>/          录下来的响应，用于离线测试
  records/<名字>/             录下来的用户演示
```

---

## 13. 例子

### 13.1 跨站调研：Rust 异步运行时的现状

```bash
bx -s rust run '
const q = "rust async runtime"
const yearAgo = Date.now() - 365 * 864e5
const [hn, reddit, zhihu] = await Promise.all([
  lib("news.ycombinator.com").search(q, { since: "1y", limit: 100 }),
  lib("reddit.com").search(q, { sub: "rust", since: "1y", limit: 100 }),
  read("https://www.zhihu.com/search?q=" + encodeURIComponent("rust 异步运行时")),
])
posts = [...hn, ...reddit, ...(zhihu.items ?? [])].filter(p => !p.time || new Date(p.time) > yearAgo)
posts = await keep(posts, "是在讨论 Rust 异步运行时本身（设计、性能、选型、维护状况）吗？", 0.6)
posts = await rank(posts, "对“该选哪个运行时”有多大参考价值？", ["几乎没有", "有一点", "有具体经验或数据"])
health = await Promise.all(["tokio-rs/tokio", "smol-rs/smol", "DataDog/glommio", "bytedance/monoio"]
  .map(r => lib("github.com").repo(r)))
return { total: posts.length, top: posts.slice(0, 20), health }
'

bx -s rust run '
threads = await Promise.all(posts.slice(0, 8).map(async p => ({ ...p,
  comments: await keep(await lib(new URL(p.url).hostname).comments(p.url, { limit: 200 }),
                       "这条评论讲了具体的使用经验、踩坑或者数据吗？", 0.7) })))
return threads.map(t => ({ title: t.title, url: t.url, comments: t.comments.slice(0, 15) }))
'

bx -s rust run 'return Promise.all(["https://github.com/bytedance/monoio", "https://github.com/DataDog/glommio"]
  .map(u => follow(u, "找到官方给出的性能测试结果", { maxSteps: 6 })))'
```

三次 `run`，每次都依赖上一次留下的变量。主模型只看筛剩下的 20 条帖子、几十条评论和两三页 benchmark。

### 13.2 接口有签名的网站：存一个知乎搜索函数

```bash
bx -s zh run 'p = await open("https://www.zhihu.com/search?type=content&q=rust"); return p.net({ api: true })'
bx -s zh run 'return pick(p.net({ api: true }).map(r => ({ id: r.id, url: r.url, preview: r.preview })), "哪个请求的返回里包含搜索结果列表？")'
bx -s zh run 'return (await p.collect("/api/v4/search_v3", { trigger: "reload" }).take(1))[0].data.slice(0, 2)'
# 结构看明白了，把代码写进 ~/.bx/lib/www.zhihu.com.js 的 search()，带上 @example
bx lib test www.zhihu.com search
```

### 13.3 强交互：网盘里归档文件，中途交接

```bash
bx -s pan run '
const page = await open("https://pan.example.com/disk/home")
const files = await lib("pan.example.com").list("/下载")
const pdfs = await keep(files.filter(f => new Date(f.time) < Date.now() - 180 * 864e5), "这是论文或技术文档吗？", 0.7)
for (const f of pdfs) {
  await page.getByText(f.name).click({ button: "right" })
  await page.getByRole("menuitem", { name: "移动到" }).click()
  await page.getByRole("treeitem", { name: "资料/论文" }).click()
  await page.getByRole("button", { name: "确定" }).click()        // 写操作：第一次会请用户在浏览器里确认
  const s = await page.state()
  if (s.kind !== "success") throw page.handoff(`移动 ${f.name} 时卡住：${s.message}`)
}
return { moved: pdfs.length }
'
# 退出码 4 → 用户在浏览器里点“这个任务里都允许” → bx -s pan job wait j1
# 退出码 5 → 卡住了，接着处理：
bx -s pan run 'return $handoff.page.ariaSnapshot()'
bx -s pan run 'await $handoff.page.getByRole("button", { name: "确认移动" }).click()'
```

---

## 14. 动手前要先验证的事

| 要验证什么 | 怎么验证 | 不行的话怎么办 |
|---|---|---|
| Playwright 能不能连上虚拟浏览器端点，并且正常操作插件模式下的标签 | 写一个最小的转发层：先把 Playwright 发来的所有命令记录下来，再逐个模拟；然后跑 `getByRole().click()`、`waitForResponse`、`route` | 自己写驱动，只照着 Playwright 的 API 实现常用的那部分 |
| daemon 和 Playwright 共用一个调试会话会不会冲突 | 同一个标签上，一边 `read`、记网络，一边让 Playwright 操作 | 有 Playwright 在用的标签，daemon 只被动地听事件 |
| 请求拦截的规则合并 | Playwright `route` 和 daemon 拦截规则同时生效 | 第二版先不支持 Playwright 的 `route`，统一用 `bx route` |
| Playwright 开启的 Runtime 等功能，在风控严格的网站上会不会被发现 | 在知乎、小红书、淘宝上试 | 这些网站只用 daemon 的轻量通道（`collect`、`fetchJson`），不经过 Playwright |
| 插件模式下浏览器重启后，标签编号还能不能对上 | 重启浏览器，看 `tabs.json` 能对上多少 | 对不上的分配新编号，并在 `tab list` 里标出来 |
| 写操作的判断够不够准 | 在几个常见的表单、网盘、邮箱页面上看误报和漏报 | 判断不了的一律当写操作，宁可多确认 |

---

## 15. 实施顺序

1. **内核 + `bx run` + 变量保留 + 标签编号不变**。这一步先不用 Playwright，内核直接调用 daemon 现有的方法（`main.ts` 里那 60 来个）
2. **虚拟浏览器端点 + Playwright 接入**（先做第 14 节的验证）
3. **函数库**：加载、`bx call`、`bx lib list / test`；把 `sites/bili` 和 `readers/bilibili.com` 合并成 `lib/bilibili.com.js`
4. **`read` 改造**：页面状态、保留代码块、末尾附上函数提示
5. **`collect`、`fillForm`、`state`、交接**
6. **写操作确认**：daemon 判断 + 插件弹窗 + 提前放行的配置
7. **判断**：`judge / keep / rank / pick`，然后是 `follow`
8. **后台任务、`session replay`、`record`**，删掉第一版的旧命令，重写 SKILL.md
