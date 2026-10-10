// 第 3 步：一手资料——项目活跃度（公开接口，Node 自带的 fetch 就行）+ 官方文档里写明的限制
// 用法：bx run -f step3.js
import fs from 'node:fs'

const repos = ['benbjohnson/litestream', 'superfly/litefs', 'tursodatabase/libsql'] // ← 按问题改
const docs = ['https://litestream.io/', 'https://fly.io/docs/litefs/']

const gh = await Promise.all(repos.map(async r => {
  const j = await (await fetch('https://api.github.com/repos/' + r)).json()
  return { repo: r, stars: j.stargazers_count, issues: j.open_issues_count, pushed: j.pushed_at?.slice(0, 10), archived: j.archived }
}))
// 文档逐个读：失败的记下来，接着读下一个
const pages = []
for (const u of docs) pages.push(await bx.read(u, { budget: 4000 }).then(r => ({ url: u, title: r.title, content: r.content }), e => ({ url: u, error: e.message })))
fs.writeFileSync('research/sources.json', JSON.stringify({ gh, pages }, null, 1))
return { gh, pages: pages.map(p => ({ url: p.url, title: p.title, error: p.error, head: p.content?.slice(0, 500) })) }
