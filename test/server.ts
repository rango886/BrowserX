import http from 'node:http'

// 本地测试站点：覆盖表单、弹窗、遮罩、新标签、iframe、列表、文章+评论、接口
const pages: Record<string, string> = {
  '/form': `<!doctype html><html><head><title>表单测试</title></head><body>
    <h1>注册</h1>
    <form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = JSON.stringify(Object.fromEntries(new FormData(this)))">
      <label>用户名 <input name="user" /></label>
      <label>简介 <textarea name="bio"></textarea></label>
      <label>城市 <select name="city"><option value="">请选择</option><option value="bj">北京</option><option value="sh">上海</option></select></label>
      <label><input type="checkbox" name="agree" /> 同意协议</label>
      <label>生日 <input type="date" name="birthday" /></label>
      <label>头像 <input type="file" name="avatar" /></label>
      <button type="submit">提交</button>
    </form>
    <pre id="out"></pre>
    <button onclick="alert('你好')">弹窗</button>
    <button onclick="document.getElementById('c').textContent = confirm('确定吗') ? 'yes' : 'no'">确认框</button><span id="c"></span>
    <a href="/list" target="_blank">新标签打开列表</a>
    <a href="/article">去文章页</a>
    <div id="mask" style="position:fixed;inset:0;background:rgba(0,0,0,.3);display:none" onclick="this.style.display='none'"></div>
    <button onclick="document.getElementById('mask').style.display='block'">显示遮罩</button>
    <iframe src="/frame" style="width:300px;height:80px"></iframe>
    <script>fetch('/api/user?id=1').then(r => r.json()).then(j => console.log('user', j.name))</script>
  </body></html>`,
  '/frame': `<!doctype html><html><body><button onclick="this.textContent='iframe 已点'">iframe 按钮</button></body></html>`,
  '/list': `<!doctype html><html><head><title>搜索结果</title></head><body>
    <nav><a href="/">首页</a> <a href="/form">表单</a> <a href="/article">文章</a> <a href="/x">其他</a></nav>
    <main><h1>“电影” 的搜索结果</h1><ul class="results">
    ${Array.from({ length: 12 }, (_, i) => `<li class="item"><a href="/video/${i}"><h3>电影 ${i} 号：一个很长的标题</h3></a><span>播放 ${1000 * i}</span> <span>UP 主 ${i}</span></li>`).join('')}
    </ul></main><footer>版权所有</footer></body></html>`,
  '/article': `<!doctype html><html><head><title>如何设计浏览器 agent</title>
    <meta name="author" content="张三"><meta property="article:published_time" content="2025-03-01">
    <script type="application/ld+json">{"@type":"BlogPosting","headline":"如何设计浏览器 agent"}</script>
    <script>window.__INITIAL_STATE__ = { post: { id: 42, likes: 7 } }</script></head><body>
    <header><nav><a href="/">首页</a><a href="/list">列表</a></nav></header>
    <article><h1>如何设计浏览器 agent</h1>
    ${Array.from({ length: 8 }, (_, i) => `<p>第 ${i + 1} 段：给 AI 用的浏览器工具，要心智负担低、符合直觉。用编号定位元素，每次操作后返回变化摘要，这样 AI 不需要反复截图。输出要控制 token 预算，长内容分段按需展开。</p>`).join('')}
    <h2>小结</h2><p>分层设计：驱动层、会话层、操作层、脚本层。</p></article>
    <section id="comments"><h2>评论</h2>
    ${Array.from({ length: 5 }, (_, i) => `<div class="comment"><b>用户${i}</b>：写得好，第 ${i} 条评论</div>`).join('')}
    </section></body></html>`,
  '/': `<!doctype html><title>首页</title><a href="/form">表单</a>`,
}

export function startServer(port = 0): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x')
    if (u.pathname.startsWith('/api/user')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: Number(u.searchParams.get('id')), name: '小明', cookie: req.headers.cookie || '' }))
    }
    const html = pages[u.pathname]
    if (!html) {
      res.writeHead(404)
      return res.end('not found')
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sid=abc123; Path=/' })
    res.end(html)
  })
  return new Promise(r =>
    server.listen(port, '127.0.0.1', () => {
      const a = server.address() as any
      r({ url: `http://127.0.0.1:${a.port}`, close: () => server.close() })
    }),
  )
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  startServer(Number(process.argv[2] || 8765)).then(s => console.log(s.url))
}
