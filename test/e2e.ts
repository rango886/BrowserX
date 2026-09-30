// 端到端测试：本地测试站点 + 无头 Chrome + 真实 CLI
// 运行：npm test
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const ROOT = path.resolve(import.meta.dirname, '..')
const HOME = path.join(ROOT, '.bx-test', 'e2e')
const env = { ...process.env, BX_HOME: HOME, BX_PORT: '9799', BX_FORMAT: '' }
delete (env as any).BX_TAB

function bx(...args: string[]): string {
  return execFileSync(process.execPath, [path.join(ROOT, 'bin/bx.js'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function bxErr(...args: string[]): string {
  try {
    bx(...args)
  } catch (e: any) {
    return String(e.stderr)
  }
  throw new Error(`应该失败：bx ${args.join(' ')}`)
}
const json = (...args: string[]) => JSON.parse(bx(...args, '-o', 'json'))

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  const t = Date.now()
  try {
    await fn()
    passed++
    console.log(`✓ ${name} (${Date.now() - t}ms)`)
  } catch (e: any) {
    console.log(`✗ ${name}\n  ${e.message.split('\n').join('\n  ')}`)
    process.exitCode = 1
  }
}

// 测试站点放在子进程里：execFileSync 会阻塞本进程的事件循环
const child = spawn(process.execPath, [path.join(ROOT, 'test/server.ts'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] })
const U: string = await new Promise(r => child.stdout!.once('data', d => r(String(d).trim())))
const srv = { close: () => child.kill() }
fs.mkdirSync(HOME, { recursive: true })

try {
  await test('启动浏览器', () => {
    const r = json('browser', 'launch', 'e2e', '--headless')
    assert.equal(r.name, 'e2e')
  })

  await test('打开标签并设为当前', () => {
    const r = json('tab', 'open', `${U}/form`)
    assert.equal(r.title, '表单测试')
    const tabs = json('tab', 'list')
    assert.ok(tabs.some((t: any) => t.id === r.id && t.cur === '*'))
  })

  await test('snapshot 给元素编号', () => {
    const s = bx('snapshot', '-i')
    assert.match(s, /textbox "用户名" \[ref=e1\]/)
    assert.match(s, /combobox "城市" \[ref=e3\].*北京 \| 上海/)
    assert.match(s, /button "iframe 按钮" \[ref=e\d+\]/)
  })

  await test('填表 + 下拉 + 勾选 + 日期 + 上传 + 提交', () => {
    assert.equal(json('fill', 'e1', '小明').value, '小明')
    bx('select', 'e3', '上海')
    assert.equal(json('check', 'e4').checked, true)
    assert.equal(json('fill', 'e5', '2000-01-02').value, '2000-01-02')
    bx('upload', 'e6', path.join(ROOT, 'package.json'))
    bx('click', 'e7')
    const out = JSON.parse(json('eval', `document.getElementById('out').textContent`))
    assert.deepEqual([out.user, out.city, out.agree, out.birthday], ['小明', 'sh', 'on', '2000-01-02'])
  })

  await test('弹窗自动处理并报告', () => {
    const r = json('click', 'e9')
    assert.match(r.changes.dialogs[0], /confirm: 确定吗/)
    assert.equal(json('eval', `document.getElementById('c').textContent`), 'yes')
  })

  await test('iframe 里的按钮可以点', () => {
    const ref = bx('snapshot', '-i').match(/button "iframe 按钮" \[ref=(e\d+)\]/)![1]
    bx('click', ref)
    assert.match(bx('snapshot'), /iframe 已点/)
  })

  await test('被遮罩挡住时报错并说明是谁', () => {
    const snap = bx('snapshot', '-i')
    const mask = snap.match(/button "显示遮罩" \[ref=(e\d+)\]/)![1]
    const link = snap.match(/link "去文章页" \[ref=(e\d+)\]/)![1]
    bx('click', mask)
    assert.match(bxErr('click', link), /被别的元素挡住了：div#mask/)
    bx('eval', `document.getElementById('mask').click()`)
  })

  await test('点击打开新标签时报告', () => {
    const ref = bx('snapshot', '-i').match(/link "新标签打开列表" \[ref=(e\d+)\]/)![1]
    const r = json('click', ref)
    assert.equal(r.changes.newTabs[0].url, `${U}/list`)
  })

  await test('跳转后旧编号失效，并提示重新 snapshot', () => {
    const ref = bx('snapshot', '-i').match(/link "去文章页" \[ref=(e\d+)\]/)![1]
    const r = json('click', ref)
    assert.equal(r.changes.navigated, true)
    assert.match(bxErr('click', 'e1'), /bx snapshot/)
  })

  await test('read：文章 + 元信息 + 评论分段', () => {
    const r = json('read')
    assert.equal(r.type, 'article')
    assert.equal(r.meta.author, '张三')
    assert.match(r.content, /第 8 段/)
    assert.ok(r.sections.some((s: any) => s.id === 'comments'))
    assert.ok(r.hints.some((h: string) => h.includes('__INITIAL_STATE__')))
    assert.match(bx('read', '-s', 'comments'), /第 4 条评论/)
  })

  await test('read：列表页识别 + 分页', () => {
    bx('goto', `${U}/list`)
    const r = json('read', '--limit', '5')
    assert.equal(r.type, 'list')
    assert.equal(r.items.length, 5)
    assert.equal(r.items[0].url, `${U}/video/0`)
    assert.deepEqual(r.more, { next: 5, total: 12 })
  })

  await test('项目级 reader 优先', () => {
    const dir = path.join(HOME, 'proj', '.bx', 'readers')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'list.js'),
      `export const meta = { match: '*/list' }\nexport function read() { return { title: 'custom', content: document.querySelectorAll('li').length + ' items' } }\n`,
    )
    const out = execFileSync(process.execPath, [path.join(ROOT, 'bin/bx.js'), 'read', '-o', 'json'], { env, cwd: path.join(HOME, 'proj'), encoding: 'utf8' })
    const r = JSON.parse(out)
    assert.equal(r.via, 'reader:list')
    assert.equal(r.content, '12 items')
  })

  await test('eval：await / 隔离环境', () => {
    bx('goto', `${U}/form`)
    assert.equal(json('eval', `const r = await fetch('/api/user?id=7'); (await r.json()).id`), 7)
    bx('eval', 'window.secret = 1')
    assert.deepEqual(json('eval', '--isolated', '[document.title, typeof window.secret]'), ['表单测试', 'undefined'])
  })

  await test('网络记录 + 响应体', () => {
    bx('net', 'log')
    bx('reload')
    const rows = json('net', 'log', '--api')
    const req = rows.find((r: any) => r.url.includes('/api/user'))
    assert.ok(req)
    const d = json('net', 'show', String(req.id))
    assert.equal(d.json.name, '小明')
  })

  await test('拦截：返回假数据 / 屏蔽', () => {
    bx('console')
    bx('net', 'route', 'add', '*/api/user*', '--fulfill', '{"name":"假数据"}')
    bx('reload')
    const logs = json('console')
    assert.ok(logs.some((l: any) => l.text === 'user 假数据'))
    bx('net', 'route', 'rm')
    bx('net', 'route', 'add', '/api/', '--abort')
    bx('net', 'clear')
    bx('reload')
    assert.ok(json('net', 'log', '--failed').some((r: any) => String(r.status).includes('blocked')))
    bx('net', 'route', 'rm')
  })

  await test('打开页面前注入', () => {
    bx('inject', 'add', 'window.__early = document.body === null')
    bx('reload')
    // 注入脚本在页面自己的脚本之前运行，那时 body 还不存在
    assert.equal(json('eval', 'window.__early'), true)
    assert.equal(json('inject', 'list').length, 1)
    bx('inject', 'rm')
  })

  await test('截图（含编号标注）', () => {
    bx('snapshot')
    const r = json('shot', '--marks', '--save', path.join(HOME, 'shot.png'))
    assert.ok(fs.statSync(r.file).size > 1000)
  })

  await test('站点脚本：CSV 填表 + 管道', () => {
    const csv = path.join(HOME, 'p.csv')
    fs.writeFileSync(csv, 'user,bio,city,agree\n甲,"a, b",北京,是\n乙,x,广州,否\n')
    const out = bx('form', 'fill', `${U}/form`, '--file', csv, '--submit', '提交', '--wait', '200', '--capture', '#out')
    const rows = out.split('\n').map(l => JSON.parse(l))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].ok, true)
    assert.match(rows[0].result, /"bio":"a, b"/)
    assert.match(rows[1].problems[0], /广州/)
  })

  await test('未知命令给出提示', () => {
    assert.match(bxErr('nope'), /bx help/)
  })
} finally {
  try {
    bx('browser', 'disconnect', 'e2e', '--kill')
  } catch {}
  try {
    bx('daemon', 'stop')
  } catch {}
  srv.close()
}
console.log(`\n${passed} passed${process.exitCode ? '，有失败' : ''}`)
