# 写 reader

reader 是一小段 JS：按 URL 匹配，打开页面时由 `bx read` 注入到页面里执行，返回你想要的结构化内容。

## 放在哪

| 位置 | 作用范围 | 优先级 |
|---|---|---|
| `<项目>/.bx/readers/` | 在这个项目目录（及子目录）里执行 bx 时生效 | 最高 |
| `~/.bx/readers/` | 全局 | 中 |
| 仓库 `readers/` | 内置 | 最低 |

同一层里有多个匹配时，匹配规则更具体（去掉 `*` 后更长）的优先。子目录随便分，文件名以 `_` 开头的会被忽略。改完立即生效，不用重启。

`bx reader list` 可以看到所有 reader，加载失败的也会列出原因。

## 格式

```js
// ~/.bx/readers/zhihu.com/answer.js
export const meta = {
  match: ['*://www.zhihu.com/question/*/answer/*'], // 通配符 *；也可以只写域名 'zhihu.com'
  name: 'zhihu-answer',        // 可选，默认用文件路径
  description: '知乎回答',
  waitFor: '.RichContent',     // 可选：等这个元素出现再提取
  scroll: 0,                   // 可选：提取前向下滚几屏
}

// 在页面里执行：只能用页面里有的东西（document、window、fetch），
// 不能引用这个文件里的其它变量或 import 的东西
export function read(args) {
  // args: { mode: 'brief'|'default'|'full', offset, limit, budget }
  const el = document.querySelector('.RichContent-inner')
  if (!el) return { fallback: true }        // 返回 fallback 就改用通用提取
  return {
    title: document.title,
    type: 'answer',
    meta: { author: document.querySelector('.AuthorInfo-name')?.innerText },
    content: el.innerText,                  // 主内容：字符串（最好是 markdown）
    // items: [{ title, url, text, ...其它字段 }],  // 或者列表
    sections: [{ id: 'comments', title: '评论' }], // 可以按需展开的分段
    // 其它自定义字段会原样以 yaml 显示
  }
}

// 可选：bx read -s <id> 时调用
export async function section(id, args) {
  if (id === 'comments') {
    const r = await fetch('/api/...', { credentials: 'include' })  // 页面里的 fetch 自带登录状态
    return { title: document.title, section: id, content: '...', range: [0, 10], total: 100 }
  }
  throw new Error(`没有分段 ${id}`)
}
```

## 约定字段

| 字段 | 含义 |
|---|---|
| `title` `type` `meta{author,published,site}` | 头部信息 |
| `content` | 主内容（字符串） |
| `items` | 列表，每项 `{title, url, text, ...}` |
| `sections` | `[{id, title, chars?}]`，提示 AI 还能展开什么 |
| `more` | `{next, total}`，提示还有更多 |
| `fallback: true` | 告诉 bx 这个页面你处理不了，改用通用提取 |

reader 出错时会自动降级到通用提取，并在输出里写一条 ⚠ 警告，所以网站改版不会让 `bx read` 完全失效。

## 小技巧

- 先 `bx read` 看看通用提取的效果；有 💡 提示页面自带 `__INITIAL_STATE__` 这类数据时，直接读它最稳。
- `bx eval "Object.keys(window.__INITIAL_STATE__)"` 可以先看看数据结构。
- 内置的例子：`readers/bilibili.com/video.js`。
