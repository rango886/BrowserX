# 跨站检索：最佳实践例子

问题：**“SQLite 能不能用作生产环境的后端数据库？Litestream、LiteFS、libSQL 这几个方案现在怎么样？”**

这个目录里的三个脚本是在真实浏览器（插件模式，已登录）里跑通过的。换个问题时，复制到工作目录，改脚本顶部的关键词和列表就能用。

## 整体思路

一次检索分成几步，**每一步是一次 `bx run`**：

| 步骤 | 做什么 | 写进文件 | 返回给 AI 看的 |
|---|---|---|---|
| 1. 广撒网 | 几个站并行搜，规整成同一种结构 | `research/posts.json` | 每个来源成功/失败 + 一行一条的摘要（带序号） |
| 2. 挑着深挖 | AI 按标题挑几条，拉评论 / 正文（文章拆成段落，可按 `KEY` 只留相关段落） | `research/threads.json` | 每条的前几段（或命中的段落） |
| 3. 一手资料 | 项目活跃度（公开接口）+ 官方文档 | `research/sources.json` | 数字和文档开头 |
| 4. 写结论 | AI 汇总，每个说法带来源链接 | — | — |
| 5. 存下来 | 现场写的、以后还会用的代码改成函数 | `~/.bx/lib/<域名>.js` | — |

为什么这样拆：

- **中间结果写文件，返回值只放摘要**。几百条评论如果直接打印出来会撑爆上下文；只看摘要，需要细节时再去读文件。
- **每次 `bx run` 跑完就退出也不怕**。标签和登录状态在 daemon 里，下一步要用的数据在文件里。
- **挑选这一步留给 AI**。各站的搜索结果都会混进跑题的帖子，程序判断不了，AI 看标题就能挑出来。

## 跑一遍

```bash
mkdir -p ~/work/sqlite && cd ~/work/sqlite
cp <skill 目录>/examples/cross-site-research/step*.js .

bx run -f step1.js            # 看输出：哪些来源成功了，每条前面的数字是序号
bx run -f step2.js 0,31,60,80 # 填上挑中的序号（PowerShell 里加引号："0,31,60,80"）
bx run -f step3.js
```

第 1 步的输出长这样：

```
来源：hn 30 条；reddit 30 条；bili 20 条；google 20 条
共 100 条，完整列表：research/posts.json
0 [hn] 260分 77评 2026-07-29 SQLite in Production: Optimizing WAL Mode, Concurrency, and VFS Layers
31 [reddit] 108赞 27评 2026-09-24 SQLite in Production: Why WAL Mode, busy_timeout, and 1-Writer Pools — r/Python
36 [reddit] 1234赞 471评 2026-01-14 Apple Photos as a Symbol of Apple's Decline…   ← 跑题的，别挑
60 [bili] 19921播放 2026-08-16 高性能 SQLite 生产环境优化 …
80 [google] 如何在生产环境中使用SQLite？ — 大家好 - 我正在尝试…
```

有来源失败时，会写成 `reddit 失败 [NEED_LOGIN] …` 这样。其它来源照常出结果；按错误码处理就行（见 SKILL.md 里的错误码表），不用整个重来。

## 脚本里值得照抄的写法

**1. 每个来源都写成两部分：怎么搜 + 怎么规整**（step1.js）

```js
const sources = {
  hn: {
    search: () => bx.lib('news.ycombinator.com').search(Q.en, { days: 365, limit: 30 }),
    norm: p => ({ title: p.title, url: p.url, heat: `${p.points}分 ${p.comments}评`, time: p.time }),
  },
  // reddit / bili / google 同理；没有函数库的网站，用 google 加 site:xxx.com 兜底
}
```

加一个来源只要加一项。后面的去重、写文件、生成摘要都不用改。

**2. 用 `Promise.allSettled` 并行，而不是 `Promise.all`**

用 `Promise.all` 的话，一个站被风控整批就失败了。用 `allSettled`，每个站各自成功或失败，失败原因（错误码 + 说明）也会报出来。

**3. 保留各站自己的相关度顺序**

按评论数排序，会把跑题的热帖排到前面（实测 Reddit 搜 “sqlite production” 时，排第一的是一篇讲 Apple Photos 的帖子）。

**4. 拉详情时限制并发**（step2.js 的 `pool(items, 3, fn)`）

同时最多 3 个。一下子开十几个标签会拖慢浏览器，也容易被网站限流。

**5. 用完关标签：`await bx.cleanup()`**

它只关这次 `bx run` 自己开的标签（包括 `bx.tab('reddit.com')` 没找到、新开的那个），用户原来的标签不动。

**6. 用命令行参数传选择，不用改代码**

`bx run -f step2.js 0,31,60`，脚本里用 `bx.args[0]` 读到这些序号。

**7. 文章按段落拆开，只看和问题相关的段落**（step2.js 顶部的 `KEY`）

评论天然是一条一段，文章却是一整篇。如果把整篇当一段再截到 250 字，只能看到开头，正文里真正有用的信息全丢了。所以：

- 没设 `KEY`：文章按空行拆成段落，和评论一样显示前 12 段。
- 设了 `KEY`（正则，如 `'WAL|并发|concurren'`）：文章用 `bx.read(url, { grep: KEY })`，只取命中的段落（前后各带一段）；评论也按它过滤。输出里会写“共 N 段，命中 M 段”。

想看某篇文章的完整上下文，用 `bx read <网址> --grep KEY` 看命中位置 `〔@数字〕`，再 `--offset 数字` 接着读。

**8. 搜索引擎不用自己控制节奏**

step1.js 里可以放好几路 Google 查询一起并行：`google.com.search` 会自动排队、被人机验证拦住时改用必应 / DuckDuckGo（结果里 `engine` 字段标明来源）。中文问题可以再加一路 `bx.lib('baidu.com').search(Q.zh)`。

**9. 公开接口直接用 Node 的 `fetch`**（step3.js 调 GitHub API）

不用开浏览器标签。只有要登录、要带 cookie 的请求，才用 `tab.fetch`。

## 第 4 步：写结论

在 `research/*.json` 的基础上写，几条规矩：

- **每个说法后面带来源链接**（文件里每条都有 `url`）。
- **分清说法来自哪里**：谁的经验（论坛评论）、谁写的文章、官方文档怎么写的、数据（star 数、最近一次提交）怎么说。
- **矛盾的说法都列出来**。比如有人说“并发写不行”，也有人说“WAL 模式下每秒几千次写没问题”；写清楚各自的前提条件。
- 摘要里看不出结论时，去读 `research/threads.json` 里的完整内容，不要瞎猜。

## 第 5 步：把摸通的部分存下来

这次现场写的代码，如果以后还会用，就改成函数存进函数库。比如在 `bx run` 里摸通了知乎搜索：

```js
// ~/.bx/lib/zhihu.com.js
/* 站点笔记：搜索接口 /api/v4/search_v3，在已登录的知乎标签里 tab.fetch 就能用；
 * paging.next 有时是 api.zhihu.com 的地址，要换成 www.zhihu.com/api/v4 */

/** 搜索回答
 *  @example search('SQLite 生产环境', { limit: 20 }) */
export async function search(q, { limit = 20 } = {}) { /* 现场写的那段代码 */ }
```

下次检索时，在 step1.js 的 `sources` 里加一行 `zhihu` 就行了。`bx read` 打开知乎的网址，输出末尾也会提示有这个函数。
