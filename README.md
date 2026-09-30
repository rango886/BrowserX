# BrowserX — 给 AI 用的浏览器控制工具

项目名叫 **BrowserX**，命令行工具是 `bx`。

一句话：让 AI（或者你自己）用命令行控制**你正在用的浏览器**，复用里面的登录状态；常用的活可以写成站点脚本，像 Linux 命令一样用管道串起来。

```bash
bx tab open https://www.bilibili.com/video/BV1GJ411x7h7
bx read                                   # 页面讲了什么（正文 / 列表 / 专用 reader）
bx snapshot -i                            # 页面上能点的东西，每个带编号
bx click e12                              # 按编号点，返回"发生了什么变化"

bx bili search 电影解说 --limit 20 \
  | bx bili video info - \
  | jq -c 'select(.stat.view > 100000)' \
  | bx bili video download - --out ./videos
```

---

## 整体结构

```
 AI / 你 / 脚本
      │  bx 命令（一次性进程）
      ▼
 bx daemon（常驻后台，自动启动）
  ├─ 浏览器注册表：每个标签一个短 id（t1 t2 …），跨浏览器唯一
  ├─ 标签会话：元素编号、弹窗、网络记录、拦截规则、注入脚本
  └─ 两种驱动，对上层是同一套接口
       ├─ 插件模式：日常 Chrome 里装 bx 插件 → ws → daemon（复用登录状态、支持标签组）
       └─ CDP 模式：bx 自己启动的专用浏览器（可无头）
```

- **为什么主推插件**：Chrome 136 起，默认用户目录不再接受 `--remote-debugging-port`，想复用日常浏览器的登录状态只能走插件。插件通过 `chrome.debugger` 把 CDP 转发出来，所以页面级能力（截图、真实输入、拦截、注入）两种模式完全一样。
- **站点脚本跑在 CLI 进程里**，通过 daemon 操作浏览器：改完立刻生效，一个脚本崩了不影响别的。

## 安装

需要 Node 22.18+（用到了直接运行 `.ts`），推荐 Node 24。

```bash
npm install
npm link            # 之后就能直接用 bx 命令（或者 node bin/bx.js）
```

**连接日常浏览器（推荐）**：打开 `chrome://extensions` → 开启"开发者模式" → "加载已解压的扩展程序" → 选 `extension/` 目录。插件图标上显示 `on` 就是连上了。
想同时连多个浏览器 / 多个 profile，在插件设置里给每个起名字（比如 `work`、`personal`）。

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
| 标签 | `tab list / open / use / close / activate / current` |
| 标签组 | `group list / create / update / ungroup`（插件模式） |
| 看页面 | `read`、`snapshot`、`shot`、`eval`、`console`、`dialogs`、`cookies` |
| 操作 | `goto back forward reload click fill type press select check uncheck hover scroll upload drag wait` |
| 注入 | `inject add / list / rm`（每次打开页面前、在页面自己的 JS 之前执行） |
| 网络 | `net log / show / wait / clear`、`net route add / list / rm`（屏蔽、mock、改请求头） |
| 录制 → 写脚本 | `trace start / mark / add / stop / list / digest / show / find / rm`、`script new / test` |
| 扩展 | `site list`、`reader list`、`cdp <method> [json]`（直接发 CDP，逃生通道） |

### 给 AI 用的几个设计

- **当前标签**：`tab open` / `tab use` 之后，页面命令默认作用在它上面，就像 `cd`。多个 agent 并行时，各自设置 `BX_TAB=t3`。
- **按编号操作**：`snapshot` 给可操作元素编号，`click e3` / `fill e5 文字`。编号一直递增、不复用；页面跳转后旧编号会报错并提示重新 snapshot，不会误点到新页面的元素。
- **操作后返回变化**：URL 变了、页面跳转了、弹了 alert、打开了新标签，都会写在 `changes` 里，不用每次都重新截图。
- **不标准的按钮也能点**：带点击事件的 div / li（鼠标是手型的）在 snapshot 里显示为 `clickable`，同样有编号。
- **自动等待和检查**：点击前会检查元素有没有被遮罩挡住，有的话直接说是谁挡的。
- **报错带下一步**：每个错误都带 `→` 提示，告诉你该执行什么。
- **标签组按需使用**：`tab open` 默认不放进组；`--group <组名或组 id>` 放进指定的组，没有就新建（插件模式）。

## read：快速看页面有什么信息

按下面的顺序提取，用了哪一种会写在 `via` 里：

1. **专用 reader**：按 URL 匹配 `readers/` 目录里的脚本（项目级 `.bx/readers` → 全局 `~/.bx/readers` → 内置）
2. **结构化数据**：meta / JSON-LD，并提示页面自带的 `__NEXT_DATA__`、`__INITIAL_STATE__` 这类数据
3. **正文**（Readability → Markdown）/ **列表**（识别重复结构）/ **大纲**（只取可见文字）

```bash
bx read                 # 默认：概要 + 主内容（6000 字以内）
bx read -b              # 只看概要和分段
bx read -s comments     # 展开某一段
bx read --offset 6000   # 接着往下读
bx read --via outline   # 手动指定提取方式
bx read --scroll 3      # 先向下滚 3 屏（懒加载）
```

写 reader 见 [docs/readers.md](docs/readers.md)。

## 站点脚本

```bash
bx site list
bx bili --help
bx bili search 最近有什么电影 --limit 10
bx bili rank 动画 --limit 20
bx bili video info BV1GJ411x7h7
bx bili video comments BV1GJ411x7h7 --limit 50 -o csv > 评论.csv
bx bili video download BV1GJ411x7h7 --quality 1080 --out ./videos
bx bili user videos 486906719 | bx bili video comments - --limit 5
bx bili user dynamics 486906719
bx google search 最近有什么电影
bx form fields https://example.com/apply
bx form fill https://example.com/apply --file 表格.csv --map mapping.yaml --submit 提交
```

**管道约定**：
- 输出到终端时显示表格，被管道接走或被程序调用时输出 JSONL（每行一条 JSON），`-o` 可以强制指定格式。
- 第一个参数写 `-`，就从 stdin 逐行读记录，自动取出对应字段（比如 `bvid`）。每行可以是 JSON 对象、JSON 数组或纯文本；字段对不上时用 `--field <字段名>`。
- `--concurrency N` 并发处理；单条失败只在 stderr 报 `✗`，其余继续，退出码 3。
- 日志和进度走 stderr，不会污染数据。
- 管道里每一段都是独立进程，但背后是同一个 daemon，浏览器连接和登录状态是共享的。

**管道例子**：

```bash
# 搜索 → 每个视频取 3 条热评
bx bili search 电影解说 --limit 5 | bx bili video comments - --limit 3

# 排行榜 → 视频详情 → 存 CSV
bx bili rank 知识 --limit 10 | bx bili video info - -o csv > 知识区.csv

# 排行榜 → UP 主信息（自动取 mid）
bx bili rank 动画 --limit 5 | bx bili user info -

# 搜索 → 详情 → jq 筛高播放 → 并发下载
bx bili search 纪录片 --limit 20 \
  | bx bili video info - \
  | jq -c 'select(.stat.view > 100000)' \
  | bx bili video download - --out ./videos --concurrency 2

# 纯文本输入：一行一个 BV 号 / 一行一个关键词
printf 'BV1GJ411x7h7\nBV1xx411c7mD\n' | bx bili video info -
cat 关键词.txt | bx google search -

# 手动指定字段
bx bili video info BV1GJ411x7h7 | bx bili user videos - --field owner.mid --limit 5
```

写站点脚本见 [docs/sites.md](docs/sites.md)。

## 录制 → 调查报告 → 写脚本

```bash
bx trace start rank --goal "B站排行榜：排名、标题、UP主、播放量，支持切换分区"
bx reload; bx read; bx click e418; bx read      # 或者让用户在浏览器里手动点一遍
bx trace stop                                   # 自动生成调查报告
bx script new mysite --from-trace rank          # 根据报告生成脚本骨架
bx script test mysite list --from-trace rank    # 验证输出，和录制时看到的内容对比
```

报告里有：数据来自哪个接口的哪个字段（数据溯源）、签名 / 翻页 / 时间戳参数、参数来自输入还是前一个接口、每步操作触发了哪些接口、参数怎么随操作变化。详见 [docs/trace.md](docs/trace.md)。

## 目录

```
bin/bx.js               入口
src/cli/                命令解析、输出格式、站点脚本运行器
src/daemon/             daemon：注册表、会话、snapshot、操作、read
src/daemon/drivers/     插件驱动 / CDP 驱动
src/inject/extract.js   注入页面的通用提取器
src/daemon/trace.ts      trace 录制
src/trace/digest.ts      调查报告：去噪、归纳、数据溯源、参数溯源
src/cli/script.ts        script new / script test
src/sdk/                站点脚本用的 ctx / Tab
extension/              浏览器插件（MV3）
sites/                  内置站点脚本：bili、google、form
readers/                内置 reader：B 站视频页
skill/browserx/         给 AI agent 用的 skill（SKILL.md）
test/                   端到端测试（npm test）
```

## 测试

```bash
npm test     # 启动本地测试站点 + 无头 Chrome，跑 24 项端到端测试
```

## 还没做的（按优先级）

- MCP 服务：把内置命令和所有站点脚本自动暴露成 MCP 工具（schema 已经有了）
- `ask-human`：遇到验证码 / 扫码时暂停并通知用户
- 按域名的持久注入目录、密码保险箱（`fill e5 --secret xxx`）、敏感操作确认
- 跨域 iframe（OOPIF）的 snapshot 和点击
- B 站投稿（需要登录账号来开发调试）
