---
name: bx-browser
description: 用 bx 命令行控制用户的浏览器（复用登录状态）：看标签、打开网页、读页面内容、点击填表、截图、执行 JS、抓接口、拦截请求，以及运行站点脚本（bili / google / form 等）。需要上网查东西、操作网页、从网站取数据时使用。
---

# bx：控制浏览器

所有命令都是 `bx ...`（如果没有 link，就用 `node <仓库>/bin/bx.js ...`）。daemon 会自动启动。

## 先确认有浏览器

```bash
bx browser list          # 空的话：让用户装插件（extension/ 目录），或执行 bx browser launch
bx tab list              # 看所有标签，* 是当前标签
```

## 查信息（大部分情况用这个就够了）

```bash
bx tab open <url>        # 打开并设为当前标签
bx read                  # 读页面主要内容：正文 / 列表 / 专用 reader，带分段目录
bx read -b               # 只看概要和分段，最省 token
bx read -s comments      # 展开某个分段
bx read --offset 6000    # 内容被截断时接着读
```

输出里 `via` 说明用的是哪种提取方式。如果内容不对（比如只读到导航栏），试试 `--via outline`、`--scroll 3`，或者用 `snapshot`。

## 操作页面

```bash
bx snapshot -i           # 可操作元素 + 编号（ref），操作前先看
bx click e12
bx fill e5 "内容" --submit
bx select e7 北京
bx press Enter           # Control+A、Escape 等组合键也可以
bx scroll                # 返回 atBottom，判断是否到底
bx wait --text 加载完成
```

- 每次操作都会返回 `changes`：`navigated`（跳转了，旧编号作废，要重新 snapshot）、`newTabs`（打开了新标签，用 `bx tab use <id>` 切过去）、`dialogs`（弹窗已自动确认）。
- 报"被挡住"时，先关掉弹层（`press Escape`，或者点关闭按钮）再操作。
- 要让用户看见 / 手动处理（登录、验证码）：`bx tab activate`，然后请用户操作。

## 其它

```bash
bx shot [ref] [--full] [--marks]   # 截图，返回文件路径；--marks 在图上标出编号
bx eval "document.title"           # 执行 JS，支持 await
bx net log --api                   # 页面调了哪些接口（第一次用会开启记录，之后 reload）
bx net show <id>                   # 接口响应（JSON）
bx net route add "*/ads/*" --abort # 拦截请求
bx inject add "..."                # 之后每次打开页面都先执行
```

## 站点脚本（优先用，比手动操作快而且稳）

```bash
bx site list                       # 有哪些
bx <站点> --help                   # 有哪些命令
bx bili search 关键词 --limit 10
bx bili video info BV1xx
bx bili video comments BV1xx --limit 50
bx google search 关键词
bx form fill <url> --file x.csv --submit 提交
```

- 被捕获输出时默认是 JSONL，`-o yaml` / `-o table` 更好读。
- 可以用管道串：`bx bili search 电影 --limit 5 | bx bili video comments - --limit 3`。

## 原则

- 读信息优先用 `read`，要操作时才用 `snapshot`，截图留到最后。
- 不要关闭或跳转用户自己的标签；需要的话自己开新标签（`tab open`）。
- 多个任务并行时，用 `-t <标签id>` 或者环境变量 `BX_TAB` 固定操作对象。
