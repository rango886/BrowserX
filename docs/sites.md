# 写站点脚本

站点脚本把一个网站上的常用操作固化成命令：`bx <站点> <命令> [参数] [选项]`。

## 放在哪

- `<项目>/.bx/sites/<名字>/index.js`（或 `<名字>.js`）：项目级，优先级最高
- `~/.bx/sites/<名字>/index.js`：全局
- 仓库 `sites/`：内置（bili、google、form）

同名时项目级覆盖全局，全局覆盖内置。用 `.js` 或 `.ts` 都行，改完立即生效。

## 最小例子

```js
// ~/.bx/sites/hn/index.js
export default {
  name: 'hn',
  description: 'Hacker News',
  home: 'https://news.ycombinator.com',
  domains: ['news.ycombinator.com'],
  commands: {
    top: {
      summary: '首页热门',
      opts: { limit: { type: 'number', default: 10, desc: '条数' } },
      async *run(ctx) {
        const tab = await ctx.open('https://news.ycombinator.com')   // 后台工作标签，命令结束自动关闭
        const rows = await tab.eval(() =>
          [...document.querySelectorAll('.athing')].map(r => ({
            title: r.querySelector('.titleline a').innerText,
            url: r.querySelector('.titleline a').href,
          })),
        )
        yield* rows.slice(0, ctx.opts.limit)
      },
    },
  },
}
```

```bash
bx hn top --limit 5
bx hn top -o csv > hn.csv
```

## 命令的写法

```js
'video comments': {                       // 命令名可以有空格：bx bili video comments
  summary: '一句话说明',
  args: [{ name: 'video', desc: 'BV 号' }], // 位置参数；也可以简写成 ['video', 'extra?', 'rest...']
  key: ['bvid', 'url'],                   // 从管道读入时取哪个字段（默认和第一个参数同名）
  opts: {
    limit: { type: 'number', default: 50, desc: '条数' },
    sort:  { type: 'string', default: 'hot', choices: ['hot', 'time'] },
    raw:   { type: 'boolean', short: 'r' },
  },
  examples: ['bx bili video comments BV1xx --limit 20'],
  async *run(ctx) { ... },                // 可以 yield 多条，也可以 return 一个对象或数组
}
```

`--help`、参数校验、`-o` 输出格式、`-` 管道输入、`--concurrency N` 并发、`--field` 指定字段，都是框架自动提供的。

## ctx

| | |
|---|---|
| `ctx.args` / `ctx.opts` | 解析好的参数和选项 |
| `ctx.input` | 从管道读入时，那一整条记录 |
| `ctx.tab()` | 找一个已打开的本站标签（带着登录状态），没有就后台打开 `home`。**只调接口、不跳转页面时用它** |
| `ctx.open(url)` | 后台新开一个工作标签，命令结束后自动关闭。**需要跳转页面时用它**，不会把用户自己的标签跳走 |
| `ctx.log(...)` | 输出到 stderr（不影响数据） |
| `ctx.sleep(ms)` | 翻页之间歇一下，免得被风控 |
| `ctx.rpc.call(method, params)` | 直接调 daemon 的任意方法 |

## Tab

```js
await tab.fetch(url, init)       // 在页面里用页面的 cookie 发请求，返回 JSON（非 2xx 会抛错）
await tab.fetchText(url)
await tab.eval(fn, ...args)      // fn 会被序列化到页面执行，不能引用外部变量；参数要能 JSON 化
await tab.eval('document.title') // 或者表达式字符串
await tab.goto(url)
await tab.read(opts)             // 和 bx read 一样
await tab.snapshot() / click(ref) / fill(ref, text, { submit }) / press('Enter') / upload(ref, files)
await tab.waitFor({ text, selector, url, fn, timeout })
const data = tab.waitResponse('api/list')   // 先开始等
await tab.goto(url)                         // 再触发
console.log(await data)                     // 拿到接口返回的 JSON
await tab.cookies()
```

## 拿数据的三种方式（按优先级）

1. **在页面里调网站自己的接口**（`tab.fetch`）：自动带登录状态，最快、最稳。需要签名的接口（比如 B 站的 wbi）在 Node 里算好签名，请求照样在页面里发，参考 `sites/bili/wbi.js`。
2. **打开页面，截获它自己发的接口**（`tab.waitResponse`）：参数太复杂、自己构造不出来时用。
3. **从 DOM 上抓**（`tab.eval`）：没有接口时的最后手段，参考 `sites/google/index.js`。

## 输出约定

- 每条记录是一个扁平一点的对象，带上**能被下一个命令用的主键**（`bvid`、`mid`、`url`），这样管道才串得起来。
- 列表类命令用 `async *run` 边拿边 `yield`，JSONL 模式下会一条条流出去，下游不用等。
- 出错直接 `throw new Error('说清楚原因（以及怎么办）')`。从管道读入时，单条失败只会打印到 stderr，不会中断后面的记录，最后以退出码 3 结束。
