# BrowserX — 给 AI 用的浏览器控制工具

项目名叫 **BrowserX**，命令行工具是 `bx`。

一句话：借你已经登录的浏览器，让 AI（或者你自己）能读网页、取数据、在网页上做事；摸通的网站门道存成按域名的函数库，下次一条命令就能调。

```bash
bx read https://www.bilibili.com/video/BV1GJ411x7h7   # 页面讲了什么；末尾列出这个网站有哪些现成函数
bx tab open https://example.com --bg --keep            # 后台开标签，返回编号 t5
bx snapshot -i -t t5                                    # 页面上能点的东西，每个带编号
bx click "getByRole('button', { name: '提交' })" -t t5  # 按编号 / CSS / 角色+名字 点，返回"发生了什么变化"

bx call bilibili.com search 电影解说 --limit 5 | bx call bilibili.com comments - --limit 3

bx run 'const t = await bx.tab("zhihu.com"); return t.fetch("https://www.zhihu.com/api/v4/me")'
```

---

## 整体结构

```
 AI / 你 / 脚本
  │  bx read / bx run / bx call / 各种页面命令（一次性进程）
  ▼
 CLI ── 加载 lib/<域名>.js，在本进程里执行 ──┐
  │ RPC                                       │
  ▼                                           │
 daemon（常驻后台，自动启动）◀────────────────┘
  ├─ 浏览器注册表：每个标签一个短 id（t1 t2 …），跨浏览器唯一
  ├─ 标签会话：元素编号、弹窗、网络记录、拦截规则、注入脚本
  └─ 两种驱动，对上层是同一套接口
       ├─ 插件模式：日常 Chrome 里装 bx 插件 → ws → daemon（复用登录状态、支持标签组）
       └─ CDP 模式：bx 自己启动的专用浏览器（可无头）
```

- **daemon** 管所有要长期存在的东西：浏览器连接、标签、登录状态、网络记录。
- **CLI** 每次执行完就退出。`bx run` 和 `bx call` 也是在 CLI 进程里跑 JS，通过 RPC 调 daemon。所以 `bx run` 跑完退出也没关系：下次按编号拿回标签，网络记录还在。
- **为什么主推插件**：Chrome 136 起，默认用户目录不再接受 `--remote-debugging-port`，想复用日常浏览器的登录状态只能走插件。插件通过 `chrome.debugger` 把 CDP 转发出来，所以页面级能力两种模式一样。

## 安装

需要 Node 22.18+（直接运行 `.ts`），推荐 Node 24。

```bash
npm install
npm link            # 之后就能直接用 bx 命令（或者 node bin/bx.js）
```

**连接日常浏览器（推荐）**：打开 `chrome://extensions` → 开启"开发者模式" → "加载已解压的扩展程序" → 选 `extension/` 目录。想同时连多个浏览器 / 多个 profile，在插件设置里给每个起名字。升级 bx 后记得在扩展页点一下“重新加载”（新版插件多了 `downloads` 权限，用来接住下载）。

**或者用专用浏览器**：

```bash
bx browser launch            # 独立 profile，存在 ~/.bx/profiles/bx，登录一次就一直在
bx browser launch ci --headless
```

## 命令一览

`bx help` 看全部，`bx <命令> --help` 看详情。所有命令都支持 `-t <标签>` 和 `-o text|json|yaml|jsonl|csv|table`。

| 分类 | 命令 |
|---|---|
| 浏览器 | `browser list / launch / connect / disconnect` |
| 标签 | `tab list / open / use / close / activate / current`，标签组 `group list / create / update / ungroup`（插件模式） |
| 看页面 | `read [网址]`、`snapshot`、`find`、`shot`、`eval`、`console`、`dialogs`、`cookies` |
| 操作 | `goto back forward reload click fill type press select check uncheck hover scroll upload drag wait` |
| 按坐标 / 按住键 | `mouse click / move / down / up / wheel / drag`、`key down / up` |
| 函数库 / 脚本 | `run`、`call`、`lib list` |
| 注入 / 网络 | `inject add / list / rm`、`net log / show / wait / clear`、`net route add / list / rm` |
| 录制 | `trace start / mark / add / stop / list / digest / show / find / rm` |
| 其它 | `cdp <method> [json]`（直接发 CDP，逃生通道） |

### 给 AI 用的几个设计

- **目标元素四种写法**：snapshot 编号 `e15`、CSS 选择器（穿透 open shadow DOM）、`getByRole('button', { name: '提交' })` / `getByLabel('邮箱')` / `getByText('下一步')`。匹配到多个就报错并列候选，不随便挑。
- **编号失效自动重新找**：snapshot 时记下每个编号的“角色 + 名字 + 第几个”，页面局部重绘后按它再找一次，结果里注明“重新定位过”；页面跳转后旧编号报错并提示重新 snapshot，不会误点。
- **操作后返回变化**：URL 变了、页面跳转了、弹了 alert、打开了新标签（在后台打开，不抢焦点），都会写在 `changes` 里；`--snap` 顺带返回新的 snapshot。
- **不标准的按钮也能点**：带点击事件的 div / li 在 snapshot 里显示为 `clickable`，同样有编号；canvas、地图这类用 `mouse click x y`。
- **表单和文件**：`fill e3=张三 e7=true` 一次填多个；`upload` 的目标可以是“点了会弹选文件窗口”的按钮；`click --download` 等下载完成返回文件路径。
- **自动等待和检查**：点击前检查有没有被遮罩挡住，有的话直接说是谁挡的。
- **报错带下一步**：每个错误都带 code 和 `→` 提示。

## read：快速看页面有什么

```bash
bx read <网址>          # 后台开标签，读完关掉
bx read -t t5 -b        # 读已打开的标签，只看概要和分段
bx read -s comments     # 展开某一段
bx read --offset 6000   # 接着往下读
bx read --via outline   # 手动指定提取方式
```

先看这个域名的函数库里有没有 `read` 函数，有就用它（`via: lib:<域名>`）；没有就通用提取：结构化数据（meta / JSON-LD，并提示 `__NEXT_DATA__` 这类页面数据）→ 正文（Readability → Markdown）/ 列表（识别重复结构）/ 大纲。**输出末尾列出这个网站的函数库有哪些函数**，让 AI 知道还能干什么。

## 函数库：`lib/<域名>.js`

同一个网站的门道（接口怎么调、字段什么意思、有什么坑）存成一个普通的 JS 模块，导出几个 async 函数：

```js
// ~/.bx/lib/bilibili.com.js
/* 站点笔记：评论接口的 oid 要用 aid，不是 bvid …（bx lib list 时显示） */

/** 视频评论，按热度
 *  @example comments('BV1GJ411x7h7', { limit: 20 }) */
export async function comments(bvid, { limit = 20 } = {}) {
  const tab = await bx.tab('bilibili.com')          // 复用已登录的 B 站标签，没有就后台开一个
  const v = await tab.fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
  …
}

/** 有这个函数时，bx read 打开这个域名的网址会优先用它 */
export async function read(tab) { … }
```

- 参数类型看默认值（`limit = 20` 是数字，`full = false` 是开关），帮助信息从签名和注释生成，不用另外声明。
- 查找顺序：`<项目>/.bx/lib/` → `~/.bx/lib/` → 仓库 `lib/`；先找完整域名，再找上一级。
- 出错统一用 `NEED_LOGIN` / `BLOCKED` / `EMPTY` / `NOT_FOUND` / `CHANGED`，AI 看 code 就知道怎么办。

```bash
bx lib list                                   # 有哪些
bx lib list bilibili.com                      # 签名、说明、例子、站点笔记
bx call bilibili.com comments BV1xx --limit 20
bx call bilibili.com rank 知识 --limit 10 | bx call bilibili.com video - -o csv > 知识区.csv
```

内置 30 多个网站（`bx lib list` 看全部，带登录要求标记）：

- 搜索引擎：`google.com`（含新闻、联想词、热搜）、`bing.com`、`duckduckgo.com`、`baidu.com`（含热搜）
- 技术社区：`news.ycombinator.com`、`reddit.com`、`github.com`、`stackoverflow.com`、`v2ex.com`、`linux.do`、`medium.com`、`x.com`
- 视频：`youtube.com`（含评论、字幕）、`bilibili.com`（含字幕、AI 总结、下载）、`douyin.com`
- 中文资讯 / 社交：`weibo.com`、`zhihu.com`、`xiaohongshu.com`、`toutiao.com`、`weixin.qq.com`、`36kr.com`
- 外文新闻：`reuters.com`、`bloomberg.com`
- 金融：`xueqiu.com`、`eastmoney.com`、`sina.com.cn`、`10jqka.com.cn`、`tdx.com.cn`、`finance.yahoo.com`、`barchart.com`
- AI：`aistudio.google.com`

## bx run：直接写 JS 把这些拼起来

```bash
bx run 'await bx.tabs()'
bx run -f research/step1.js
```

代码按 ES 模块执行：顶层 `await`、`import node:fs`，`return` 的值打印出来；结果太大就写到 `~/.bx/out/` 只打印摘要和路径。全局 `bx`：

```js
bx.tab('t5') / bx.tab('zhihu.com')    bx.open(url)    bx.tabs()    bx.read(url)    bx.lib('reddit.com').search('x')
tab.eval(fn) tab.fetch(url) tab.click(目标) tab.fill(目标, 文字) tab.snapshot() tab.waitResponse(...) …
for await (const res of tab.collect('/api/search', { more: () => tab.scroll() })) { … }   // 有签名的接口：让网站自己发请求，接住返回
```

一个网站从陌生到熟悉：`bx read` 看一眼 → `bx run` 里试（`tab.eval` 看页面数据、`bx net log` 找接口、`tab.fetch` 调一下）→ 试通了改成函数存进 `~/.bx/lib/<域名>.js` → 以后 `bx call` 或 `bx.lib()`。

详见 [docs/lib.md](docs/lib.md)。设计思路见 [docs/design-v2.md](docs/design-v2.md)。

## 录制 → 调查报告

```bash
bx trace start rank --goal "B站排行榜：排名、标题、UP主、播放量，支持切换分区"
bx reload; bx read; bx click e418; bx read      # 或者让用户在浏览器里手动点一遍
bx trace stop                                   # 自动生成调查报告
```

报告里有：数据来自哪个接口的哪个字段、签名 / 翻页 / 时间戳参数、参数来自输入还是前一个接口、每步操作触发了哪些接口。详见 [docs/trace.md](docs/trace.md)。

## 目录

```
bin/bx.js               入口
src/cli/                命令解析、输出格式、bx run（run.ts）、bx call / lib list（call.ts）
src/sdk/                全局 bx 对象和 Tab 类（index.ts）、函数库加载和签名解析（lib.ts）
src/daemon/             daemon：注册表、会话、snapshot、元素定位（locate.ts）、操作、read
src/daemon/drivers/     插件驱动 / CDP 驱动
src/inject/extract.js   注入页面的通用提取器
src/daemon/trace.ts     trace 录制
src/trace/digest.ts     调查报告：去噪、归纳、数据溯源、参数溯源
extension/              浏览器插件（MV3）
lib/                    内置函数库（_ 开头的是共享代码）
skill/browserx/         给 AI agent 用的 skill（SKILL.md）
test/                   端到端测试（npm test）
```

## 测试

```bash
npm test     # 启动本地测试站点 + 无头 Chrome，跑端到端测试
```

## 还没做的

- 跨域 iframe（OOPIF）的 snapshot 和点击：要先实测插件模式下 `chrome.debugger` 能不能往子 session 发命令（Vivaldi 上也要试）
- 后台标签防降速：现在 bx 后台开的标签会打开 `Emulation.setFocusEmulationEnabled`（`BX_NO_FOCUS_EMULATION=1` 关掉）；在 B 站评论、知乎这类懒加载页面上的效果还要实测，必要时再加 `Page.setWebLifecycleState`
- 写操作确认、标签归属和借用、按域名的隐私策略；标签编号跨重启不变
