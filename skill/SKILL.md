---
name: bx-browser
description: 用 bx 命令行控制用户的浏览器（复用登录状态）：看标签、打开网页、读页面内容、点击填表、截图、执行 JS、抓接口、拦截请求，运行站点脚本（bili / google / form 等），以及把网站操作录制成脚本。需要上网查东西、操作网页、从网站取数据时使用。
---

# bx：控制浏览器

命令都是 `bx ...`（没 link 就用 `node <仓库>/bin/bx.js ...`）。后台 daemon 会自动启动。
所有命令都支持 `-o text|json|yaml|jsonl|csv|table`；需要解析结果时用 `-o json`。

## 1. 连接浏览器

```bash
bx browser list      # 看已连接的浏览器：kind=extension 是插件模式，cdp 是专用浏览器
```

列表为空时，按情况处理：

- **用户的 Chrome 装了 bx 插件**：插件会自动连上，插件图标显示 `on`。daemon 刚启动时可能要等几秒到半分钟，稍后重试 `bx browser list`。这种方式复用用户的登录状态，是首选。
- **没装插件**：请用户在 `chrome://extensions` 开启“开发者模式” → “加载已解压的扩展程序” → 选仓库里的 `extension/` 目录。连多个浏览器时，在插件设置里给每个起名字（如 `work`、`personal`）。
- **不想用 / 用不了用户的浏览器**：`bx browser launch [名字] [--headless]` 启动专用浏览器。它有独立的 profile（`~/.bx/profiles/<名字>`），登录一次以后一直有效；已经在运行的话会直接连上。
- 已经带着 `--remote-debugging-port` 启动的浏览器：`bx browser connect http://127.0.0.1:9222 --name x`。

连着多个浏览器时，`tab open` / `tab list` 用 `--browser <名字>` 指定浏览器。

## 2. 标签

```bash
bx tab list [过滤词]        # 所有浏览器的标签；* 是当前标签，group=bx 的是 AI 开的
bx tab open <url>           # 新开标签并设为当前（插件模式下自动放进 "bx" 标签组）
    --bg                    #   后台打开    --keep  不切换当前标签    --no-group  不放进组
bx tab use t3               # 切换当前标签（之后的页面命令默认作用在它上面）
bx tab activate [t3]        # 在浏览器里把它切到前台，让用户看到
bx tab close [t3 t4]        # 关标签（默认关当前）
bx group list / create t3 t4 --title 资料 --color blue
```

**指定标签**：所有页面命令（read、snapshot、click、eval、net …）都能加 `-t t3`，写在命令前后都可以，比如 `bx -t t3 read`、`bx read -t t3`。也可以设置环境变量 `BX_TAB=t3`，多个任务并行时用它固定各自的标签。

注意：daemon 重启后标签会重新编号，先 `tab list` 再操作。

## 3. 读页面（只想知道页面上有什么时用）

```bash
bx read                  # 主要内容 + 分段目录（默认最多 6000 字）
bx read -b               # 只看概要和分段，最省 token
bx read -s comments      # 展开某一段（分段 id 见输出末尾）
bx read --offset 6000    # 内容被截断时接着读（列表页按项数算）
bx read --limit 50       # 列表页多取几项      --budget 20000  放宽字数上限    --full  不截断
bx read --links          # 正文里保留链接地址
bx read --scroll 3       # 先向下滚 3 屏再读（懒加载的评论、无限滚动的列表）
```

输出里的 **`via`** 说明这次用的是哪种提取方式：

| via | 含义 |
|---|---|
| `reader:<名字>` | 这个网站的专用 reader（按网址匹配，最准）；`bx reader list` 可以看有哪些 |
| `readability` | 按文章识别出的正文 |
| `list` | 识别出重复结构，按列表输出（搜索结果、排行榜、商品列表） |
| `outline` | 以上都不适用时，取页面上看得见的文字 |

内容不对（比如只读到导航栏、或者把列表当成了文章）时，用 `--via readability|list|outline|<reader名>` 手动指定。
输出里出现 💡 提示页面自带 `window.__INITIAL_STATE__` 这类数据时，直接 `bx eval "window.__INITIAL_STATE__.xxx"` 读结构化数据最准。

## 4. 操作页面

```bash
bx snapshot -i                 # 可操作元素 + 编号（ref）；不加 -i 会连文字一起显示；--max 1000 放宽行数
bx click e12                   # --double 双击  --right 右键  --force 被挡住也点
bx fill e5 "内容" --submit     # 清空后输入，--submit 填完按回车；--append 追加不清空
bx type "文字"                 # 往当前焦点处输入
bx press Enter                 # 也可以 Control+A、Escape、Tab；可以连续写：bx press Control+A Delete
bx select e7 北京              # 原生下拉框（snapshot 里 {options: …} 列出了可选项）
bx check e8 / uncheck e8
bx upload e9 ./a.png           # 文件输入框
bx hover e3 / drag e3 e9
bx scroll [down|up|top|bottom|e12] [--amount 800]   # 返回 atBottom，判断是否到底
bx goto <url> / back / forward / reload
bx wait --text 加载完成        # 还可以用 --gone 文字 / --selector css / --url 片段 / --fn "JS 表达式" / --idle，加 --timeout 毫秒
```

- snapshot 里的 `clickable "xxx"` 是带点击事件的普通元素（div / li），同样可以 `click`。
- 每次操作返回 `changes`：
  - `navigated`：页面跳转了，旧编号作废，要重新 snapshot
  - `newTabs`：打开了新标签，用 `bx tab use <id>` 切过去
  - `dialogs`：弹窗已自动确认；想改成取消用 `bx dialogs --policy dismiss`
- 报“被挡住”时，先关掉弹层（`press Escape`，或者点关闭按钮）再操作。
- 遇到登录、验证码：`bx tab activate` 把标签切到前台，请用户处理完再继续。

## 5. 其它

```bash
bx shot [e12] [--full] [--marks] [--save a.png]   # 截图，返回文件路径；--marks 在图上标出编号
bx eval "document.title"        # 执行 JS，支持 await；--file x.js；--isolated 在页面察觉不到的环境里执行
bx console [--level error]      # 控制台日志（第一次调用时才开始记录）
bx cookies [url]
bx net log [过滤词] [--api] [--failed] [--status 4xx]   # 请求记录（第一次调用时才开始记录，之后要 bx reload）
bx net show <id> [--headers]    # 某个请求的响应（JSON 会自动解析）
bx net wait "api/list"          # 等下一个匹配的请求，返回它的响应
bx net route add "*/ads/*" --abort          # 屏蔽请求；--fulfill '{"a":1}' 或 --fulfill @文件 返回假数据；--header "k: v" 改请求头
bx net route list / rm [id]
bx inject add "代码"            # 这个标签以后每次打开页面，都在页面自己的 JS 之前执行；--file x.js
```

## 6. 站点脚本（有现成的就优先用，又快又稳）

```bash
bx site list                    # 有哪些站点；bx <站点> --help 看命令，bx <站点> <命令> --help 看参数
bx bili search 关键词 --limit 10       bx bili rank 动画
bx bili video info BV1xx               bx bili video comments BV1xx --limit 50
bx bili video download BV1xx --out ./v bx bili user videos <mid>
bx google search 关键词
bx form fields <url>                   bx form fill <url> --file x.csv --submit 提交 --dry-run
```

- 被程序捕获输出时默认是 JSONL，给人看时加 `-o table` 或 `-o yaml`。
- 管道：第一个参数写 `-` 就从上一个命令的输出读，比如 `bx bili search 电影 --limit 5 | bx bili video comments - --limit 3`；`--concurrency 3` 并发处理。

## 7. 把网站操作固化成脚本（没有现成脚本、又要反复做时）

```bash
bx trace start <名字> --goal "要拿什么数据、支持什么参数"
bx reload                       # 页面加载时发的接口也能录到
bx read                         # 拿到数据后一定要 read 一次（报告靠它找数据出处）
# …… 翻页 / 切换分类 / 搜索，每次操作后再 read 一次；可以用 bx trace mark "说明" 做标注 ……
bx trace stop                   # 生成调查报告
bx trace digest <名字>          # 读报告，先看“结论”
bx script new <站点> --from-trace <名字>                 # 生成骨架（附上 TRACE.md）
bx script test <站点> <命令> [参数] --from-trace <名字>   # 验证，不通过就接着改
```

- 报告说有签名：用 `tab.waitResponse` 截获页面自己发的请求，按报告里的操作步骤触发；没有签名：用 `tab.fetch` 直接调。
- 看细节：`bx trace show <名字> <请求号> --path data.list[0]`；在所有响应里搜文字：`bx trace find <名字> "文字"`。
- 也可以让用户演示：`trace start` 之后，请用户在那个标签里手动操作一遍，再 `trace stop`。
- 写法参考：仓库里的 `docs/sites.md`、`docs/trace.md`。

## 原则

- 查信息先用 `read`；要操作时再用 `snapshot`；截图放到最后。
- 不要关闭或跳转用户自己的标签，需要的话自己开新标签。
- 用完自己开的标签（group=bx 的）要记得关掉。
