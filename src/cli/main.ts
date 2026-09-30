import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { RpcClient, readDaemonInfo } from '../common/rpc.ts'
import { BX_HOME, REPO_ROOT } from '../common/paths.ts'
import { BxError, sleep } from '../common/util.ts'
import { render, type Format } from './output.ts'
import { listSites, loadSite, runSite, siteHelp } from './sites.ts'
import { traceDirOf, scriptNew, scriptTest } from './script.ts'
import { digestTrace, showRequest, findInTrace } from '../trace/digest.ts'

type Opt = { type: 'string' | 'boolean'; short?: string; desc?: string; multiple?: boolean }
interface Cmd {
  args?: string // 用法里的参数说明
  summary: string
  opts?: Record<string, Opt>
  kind?: string // 渲染方式
  run: (pos: string[], o: any, rpc: () => Promise<RpcClient>) => Promise<any>
}

const tabOpt: Record<string, Opt> = {}
const num = (v: any) => (v === undefined ? undefined : Number(v))
const call = (method: string, params: any = {}) => async (_: string[], o: any, rpc: () => Promise<RpcClient>) => (await rpc()).call(method, { tab: o.tab, ...params })

function readCode(pos: string[], o: any): string {
  if (o.file) return fs.readFileSync(o.file, 'utf8')
  if (pos[0] === '-' || (!pos.length && !process.stdin.isTTY)) return fs.readFileSync(0, 'utf8')
  if (!pos.length) throw new BxError('BAD_ARGS', '缺少要执行的代码', '例：bx eval "document.title"，或 --file x.js，或从 stdin 传')
  return pos.join(' ')
}

const COMMANDS: Record<string, Cmd> = {
  // ---------------- daemon ----------------
  'daemon start': {
    summary: '启动后台 daemon（其它命令会自动启动它，一般不用手动）',
    run: async () => {
      const c = await RpcClient.connect()
      const s = await c.call('daemon.status')
      c.close()
      return s
    },
  },
  'daemon stop': {
    summary: '停止 daemon',
    run: async () => {
      if (!readDaemonInfo()) return { ok: true, note: 'daemon 没在运行' }
      const c = await RpcClient.connect({ autostart: false }).catch(() => null)
      if (!c) return { ok: true, note: 'daemon 没在运行' }
      await c.call('daemon.stop').catch(() => {})
      c.close()
      return { ok: true }
    },
  },
  'daemon restart': {
    summary: '重启 daemon（改了 daemon 代码后用）',
    run: async () => {
      const c = await RpcClient.connect({ autostart: false }).catch(() => null)
      if (c) {
        await c.call('daemon.stop').catch(() => {})
        c.close()
        await sleep(500)
      }
      const c2 = await RpcClient.connect()
      const s = await c2.call('daemon.status')
      c2.close()
      return s
    },
  },
  'daemon status': { summary: '查看 daemon 状态', run: async (_, __, rpc) => (await rpc()).call('daemon.status') },
  'daemon log': {
    summary: '查看 daemon 日志最后几行',
    opts: { lines: { type: 'string', short: 'n' } },
    run: async (_, o) => fs.readFileSync(path.join(BX_HOME, 'daemon.log'), 'utf8').split('\n').slice(-(Number(o.lines) || 40)).join('\n'),
  },

  // ---------------- 浏览器 ----------------
  'browser list': { summary: '已连接的浏览器', run: async (_, __, rpc) => (await rpc()).call('browser.list') },
  'browser launch': {
    args: '[name]',
    summary: '启动一个专用浏览器（独立 profile，登录一次后会一直保留）',
    opts: { headless: { type: 'boolean', desc: '无头模式' }, exe: { type: 'string', desc: '浏览器路径' }, port: { type: 'string' } },
    run: async (p, o, rpc) => (await rpc()).call('browser.launch', { name: p[0] || 'bx', headless: o.headless, executable: o.exe, port: num(o.port) }),
  },
  'browser connect': {
    args: '<cdp-url>',
    summary: '连接一个带 --remote-debugging-port 的浏览器，例：http://127.0.0.1:9222',
    opts: { name: { type: 'string' } },
    run: async (p, o, rpc) => (await rpc()).call('browser.connect', { cdp: p[0], name: o.name }),
  },
  'browser disconnect': {
    args: '[name]',
    summary: '断开浏览器（--kill 同时关闭它，仅 CDP 模式）',
    opts: { kill: { type: 'boolean' } },
    run: async (p, o, rpc) => (await rpc()).call('browser.disconnect', { name: p[0], kill: o.kill }),
  },

  // ---------------- 标签 ----------------
  'tab list': {
    args: '[filter]',
    summary: '列出所有浏览器的标签页（* 是当前标签）',
    opts: { browser: { type: 'string' } },
    run: async (p, o, rpc) => (await rpc()).call('tab.list', { filter: p[0], browser: o.browser }),
  },
  'tab open': {
    args: '[url]',
    summary: '打开新标签并设为当前标签（插件模式下会放进 "bx" 标签组）',
    opts: {
      browser: { type: 'string' },
      bg: { type: 'boolean', desc: '后台打开' },
      group: { type: 'string', desc: '放进哪个标签组（默认 bx）' },
      'no-group': { type: 'boolean', desc: '不放进标签组' },
      keep: { type: 'boolean', desc: '不切换当前标签' },
    },
    run: async (p, o, rpc) => (await rpc()).call('tab.open', { url: p[0], browser: o.browser, background: o.bg, group: o['no-group'] ? false : o.group, keep: o.keep }),
  },
  'tab close': { args: '[ids...]', summary: '关闭标签（默认当前）', run: async (p, o, rpc) => (await rpc()).call('tab.close', { ids: p.length ? p : o.tab ? [o.tab] : [] }) },
  'tab use': { args: '<id>', summary: '设为当前标签（之后的页面命令都作用在它上面）', run: async (p, _, rpc) => (await rpc()).call('tab.use', { id: p[0] }) },
  'tab activate': { args: '[id]', summary: '在浏览器里切到这个标签（让用户看到）', run: async (p, o, rpc) => (await rpc()).call('tab.activate', { id: p[0] || o.tab }) },
  'tab current': { summary: '当前标签', run: async (_, __, rpc) => (await rpc()).call('tab.current') },

  // ---------------- 标签组 ----------------
  'group list': { summary: '标签组列表', run: async (_, __, rpc) => (await rpc()).call('group.list') },
  'group create': {
    args: '[tabs...]',
    summary: '把标签放进新组',
    opts: { title: { type: 'string' }, color: { type: 'string', desc: 'grey blue red yellow green pink purple cyan orange' } },
    run: async (p, o, rpc) => (await rpc()).call('group.create', { tabs: p, title: o.title, color: o.color }),
  },
  'group update': {
    args: '<groupId>',
    summary: '改组名 / 颜色 / 折叠',
    opts: { title: { type: 'string' }, color: { type: 'string' }, collapse: { type: 'boolean' }, expand: { type: 'boolean' }, browser: { type: 'string' } },
    run: async (p, o, rpc) => (await rpc()).call('group.update', { id: p[0], browser: o.browser, title: o.title, color: o.color, collapsed: o.collapse ? true : o.expand ? false : undefined }),
  },
  'group ungroup': { args: '[tabs...]', summary: '把标签移出组', run: async (p, _, rpc) => (await rpc()).call('group.ungroup', { tabs: p }) },

  // ---------------- 导航 ----------------
  goto: { args: '<url>', summary: '当前标签打开网址', run: async (p, o, rpc) => (await rpc()).call('page.goto', { tab: o.tab, url: p[0] }) },
  back: { summary: '后退', run: call('page.back') },
  forward: { summary: '前进', run: call('page.forward') },
  reload: { summary: '刷新', run: call('page.reload') },

  // ---------------- 观察 ----------------
  snapshot: {
    summary: '页面结构 + 可操作元素编号（ref），操作前先看这个',
    opts: { interactive: { type: 'boolean', short: 'i', desc: '只看可操作元素和标题' }, max: { type: 'string', desc: '最多行数（默认 600）' } },
    run: async (_, o, rpc) => (await rpc()).call('page.snapshot', { tab: o.tab, interactive: o.interactive, max: num(o.max) }),
  },
  read: {
    summary: '读页面主要内容（正文 / 列表 / 大纲），只想知道页面有什么信息时用它',
    kind: 'read',
    opts: {
      brief: { type: 'boolean', short: 'b', desc: '只看概要和分段' },
      full: { type: 'boolean', desc: '不截断' },
      section: { type: 'string', short: 's', desc: '读某一段，如 comments' },
      offset: { type: 'string', desc: '从第几个字符 / 第几项开始' },
      limit: { type: 'string', desc: '列表项数' },
      budget: { type: 'string', desc: '内容字数上限（默认 6000）' },
      via: { type: 'string', desc: '指定提取方式：reader 名 | readability | list | outline' },
      links: { type: 'boolean', desc: '正文里保留链接地址' },
      scroll: { type: 'string', desc: '读之前向下滚动几屏（懒加载内容）' },
    },
    run: async (_, o, rpc) =>
      (await rpc()).call('page.read', {
        tab: o.tab,
        mode: o.brief ? 'brief' : o.full ? 'full' : 'default',
        section: o.section,
        offset: num(o.offset),
        limit: num(o.limit),
        budget: num(o.budget),
        via: o.via,
        links: o.links,
        scroll: num(o.scroll),
        cwd: process.cwd(),
      }),
  },
  shot: {
    args: '[ref]',
    summary: '截图，返回图片路径（给 ref 就只截那个元素）',
    opts: { full: { type: 'boolean', desc: '整页' }, marks: { type: 'boolean', short: 'm', desc: '在图上标出 ref 编号' }, save: { type: 'string', desc: '保存路径' } },
    run: async (p, o, rpc) => (await rpc()).call('page.shot', { tab: o.tab, ref: p[0], full: o.full, marks: o.marks, out: o.save }),
  },
  eval: {
    args: '<code>',
    summary: '在页面里执行 JS（支持 await），返回结果',
    opts: { file: { type: 'string', short: 'f' }, isolated: { type: 'boolean', desc: '在隔离环境执行（插件模式，不被页面察觉）' } },
    run: async (p, o, rpc) => {
      const r = await (await rpc()).call('page.eval', { tab: o.tab, code: readCode(p, o), world: o.isolated ? 'isolated' : undefined })
      return r.value
    },
  },
  console: {
    summary: '页面控制台日志',
    opts: { level: { type: 'string', desc: 'log|warn|error' }, clear: { type: 'boolean' }, limit: { type: 'string' } },
    run: async (_, o, rpc) => (await rpc()).call('page.console', { tab: o.tab, level: o.level, clear: o.clear, limit: num(o.limit) }),
  },
  dialogs: {
    summary: '最近的弹窗（alert/confirm），--policy accept|dismiss 设置自动处理方式',
    opts: { policy: { type: 'string' } },
    run: async (_, o, rpc) => (await rpc()).call('page.dialogs', { tab: o.tab, policy: o.policy }),
  },
  cookies: { args: '[url]', summary: '当前页面（或指定 URL）的 cookie', run: async (p, o, rpc) => (await rpc()).call('cookies.get', { tab: o.tab, url: p[0] }) },

  // ---------------- 交互 ----------------
  click: {
    args: '<ref>',
    summary: '点击元素',
    opts: { double: { type: 'boolean' }, right: { type: 'boolean' }, force: { type: 'boolean', desc: '被挡住也点' } },
    run: async (p, o, rpc) => (await rpc()).call('page.click', { tab: o.tab, ref: p[0], double: o.double, right: o.right, force: o.force }),
  },
  hover: { args: '<ref>', summary: '鼠标悬停', run: async (p, o, rpc) => (await rpc()).call('page.hover', { tab: o.tab, ref: p[0] }) },
  fill: {
    args: '<ref> <text>',
    summary: '清空输入框再填入文字（--submit 填完按回车）',
    opts: { append: { type: 'boolean', desc: '不清空，追加' }, submit: { type: 'boolean' } },
    run: async (p, o, rpc) => (await rpc()).call('page.fill', { tab: o.tab, ref: p[0], text: p.slice(1).join(' '), append: o.append, submit: o.submit }),
  },
  type: { args: '<text>', summary: '往当前焦点处输入文字', run: async (p, o, rpc) => (await rpc()).call('page.type', { tab: o.tab, text: p.join(' ') }) },
  press: { args: '<keys...>', summary: '按键，如 Enter / Control+A / Escape', run: async (p, o, rpc) => (await rpc()).call('page.press', { tab: o.tab, keys: p }) },
  select: { args: '<ref> <values...>', summary: '下拉框选择（按值或文字）', run: async (p, o, rpc) => (await rpc()).call('page.select', { tab: o.tab, ref: p[0], values: p.slice(1) }) },
  check: { args: '<ref>', summary: '勾选', run: async (p, o, rpc) => (await rpc()).call('page.check', { tab: o.tab, ref: p[0], value: true }) },
  uncheck: { args: '<ref>', summary: '取消勾选', run: async (p, o, rpc) => (await rpc()).call('page.check', { tab: o.tab, ref: p[0], value: false }) },
  upload: { args: '<ref> <files...>', summary: '给文件输入框设置文件', run: async (p, o, rpc) => (await rpc()).call('page.upload', { tab: o.tab, ref: p[0], files: p.slice(1) }) },
  drag: { args: '<from> <to>', summary: '拖拽', run: async (p, o, rpc) => (await rpc()).call('page.drag', { tab: o.tab, from: p[0], to: p[1] }) },
  scroll: {
    args: '[down|up|top|bottom|<ref>]',
    summary: '滚动（默认向下一屏），返回滚动位置和是否到底',
    opts: { amount: { type: 'string', desc: '像素' } },
    run: async (p, o, rpc) => {
      const a = p[0] || 'down'
      const isRef = /^@?e\d+$/.test(a)
      return (await rpc()).call('page.scroll', { tab: o.tab, ref: isRef ? a : undefined, dir: isRef ? undefined : a, amount: num(o.amount) })
    },
  },
  wait: {
    summary: '等待条件满足：--text 出现文字 / --gone 文字消失 / --selector / --url / --fn JS 表达式 / --idle 网络空闲',
    opts: {
      text: { type: 'string' }, gone: { type: 'string' }, selector: { type: 'string' }, url: { type: 'string' },
      fn: { type: 'string' }, idle: { type: 'boolean' }, timeout: { type: 'string', desc: '毫秒，默认 15000' },
    },
    run: async (_, o, rpc) => (await rpc()).call('page.wait', { tab: o.tab, text: o.text, gone: o.gone, selector: o.selector, url: o.url, fn: o.fn, idle: o.idle, timeout: num(o.timeout) }),
  },

  // ---------------- 注入 ----------------
  'inject add': {
    args: '<code>',
    summary: '注入脚本：这个标签之后每次打开页面，都在页面自己的 JS 之前执行',
    opts: { file: { type: 'string', short: 'f' }, 'no-now': { type: 'boolean', desc: '不在当前页面立即执行' } },
    run: async (p, o, rpc) => (await rpc()).call('inject.add', { tab: o.tab, source: readCode(p, o), label: o.file, now: !o['no-now'] }),
  },
  'inject list': { summary: '已注入的脚本', run: call('inject.list') },
  'inject rm': { args: '[id]', summary: '移除注入脚本（不给 id 就全部移除）', run: async (p, o, rpc) => (await rpc()).call('inject.rm', { tab: o.tab, id: p[0] }) },

  // ---------------- 网络 ----------------
  'net log': {
    args: '[filter]',
    summary: '网络请求记录（第一次用时开启记录）',
    opts: { type: { type: 'string', desc: 'xhr,fetch,document,script…' }, status: { type: 'string', desc: '如 4xx / 200' }, failed: { type: 'boolean' }, limit: { type: 'string' }, api: { type: 'boolean', desc: '只看 xhr/fetch' } },
    run: async (p, o, rpc) => (await rpc()).call('net.log', { tab: o.tab, filter: p[0], type: o.api ? 'xhr,fetch' : o.type, status: o.status, failed: o.failed, limit: num(o.limit) }),
  },
  'net show': {
    args: '<id>',
    summary: '请求详情和响应体',
    opts: { 'no-body': { type: 'boolean' }, headers: { type: 'boolean', desc: '显示请求头 / 响应头' }, max: { type: 'string' } },
    run: async (p, o, rpc) => (await rpc()).call('net.show', { tab: o.tab, id: p[0], body: !o['no-body'], headers: o.headers, max: num(o.max) }),
  },
  'net wait': {
    args: '<pattern>',
    summary: '等下一个 URL 匹配的请求完成，返回响应（pattern 支持 * 通配或子串）',
    opts: { timeout: { type: 'string' } },
    run: async (p, o, rpc) => (await rpc()).call('net.wait', { tab: o.tab, match: p[0], timeout: num(o.timeout) }),
  },
  'net clear': { summary: '清空请求记录', run: call('net.clear') },
  'net route add': {
    args: '<pattern>',
    summary: '拦截请求：--abort 屏蔽 / --fulfill <内容|@文件> 返回假数据 / --header k:v 改请求头',
    opts: {
      abort: { type: 'boolean' },
      fulfill: { type: 'string' },
      status: { type: 'string' },
      'content-type': { type: 'string' },
      header: { type: 'string', multiple: true },
    },
    run: async (p, o, rpc) => {
      const headers = o.header ? Object.fromEntries(o.header.map((h: string) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()])) : undefined
      let body = o.fulfill
      if (body?.startsWith('@')) body = fs.readFileSync(body.slice(1), 'utf8')
      const action = o.abort ? 'abort' : body !== undefined ? 'fulfill' : 'continue'
      if (action === 'continue' && !headers) throw new BxError('BAD_ARGS', '需要 --abort / --fulfill / --header 之一')
      return (await rpc()).call('net.route.add', { tab: o.tab, pattern: p[0], action, status: num(o.status), body, contentType: o['content-type'], headers })
    },
  },
  'net route list': { summary: '拦截规则列表', run: call('net.route.list') },
  'net route rm': { args: '[id]', summary: '删除拦截规则（不给 id 删全部）', run: async (p, o, rpc) => (await rpc()).call('net.route.rm', { tab: o.tab, id: p[0] }) },

  // ---------------- 扩展 ----------------
  'site list': {
    summary: '可用的站点脚本',
    run: async () => {
      const out: any[] = []
      for (const s of listSites()) {
        const spec = await loadSite(s.name).catch(e => ({ description: `(加载失败：${e.message})`, commands: {} }) as any)
        out.push({ name: s.name, scope: s.scope, commands: Object.keys(spec.commands).join(', '), description: spec.description })
      }
      return out
    },
  },
  'reader list': { summary: '可用的 reader（按域名匹配的内容提取脚本）', run: async (_, __, rpc) => (await rpc()).call('reader.list', { cwd: process.cwd() }) },
  cdp: {
    args: '<method> [json]',
    summary: '直接发 CDP 命令（逃生通道）',
    run: async (p, o, rpc) => (await rpc()).call('cdp.send', { tab: o.tab, method: p[0], params: p[1] ? JSON.parse(p[1]) : {} }),
  },

  // ---------------- trace ----------------
  'trace start': {
    args: '[name]',
    summary: '开始录制：操作、手动操作、接口请求、看到的内容都会记下来',
    opts: { goal: { type: 'string', short: 'g', desc: '这次要做什么（写进报告，很重要）' }, 'no-tab': { type: 'boolean', desc: '先不录当前标签' } },
    run: async (p, o, rpc) => (await rpc()).call('trace.start', { name: p[0], goal: o.goal, tab: o.tab, noTab: o['no-tab'] }),
  },
  'trace stop': { summary: '停止录制，生成调查报告', run: async (_, __, rpc) => (await rpc()).call('trace.stop') },
  'trace status': { summary: '当前录制状态', run: async (_, __, rpc) => (await rpc()).call('trace.status') },
  'trace mark': { args: '<note>', summary: '在时间线上标注一步（比如"现在翻到第二页"）', run: async (p, o, rpc) => (await rpc()).call('trace.mark', { note: p.join(' '), tab: o.tab }) },
  'trace add': { args: '[tab]', summary: '把一个标签加进录制（用户自己打开的标签）', run: async (p, o, rpc) => (await rpc()).call('trace.add', { tab: p[0] || o.tab }) },
  'trace list': { summary: '已有的录制', run: async (_, __, rpc) => (await rpc()).call('trace.list') },
  'trace rm': { args: '<name>', summary: '删除录制', run: async (p, _, rpc) => (await rpc()).call('trace.rm', { name: p[0] }) },
  'trace digest': {
    args: '<name>',
    summary: '（重新）生成并显示调查报告',
    run: async p => {
      if (!p[0]) throw new BxError('BAD_ARGS', '需要 trace 名字', '`bx trace list`')
      return digestTrace(traceDirOf(p[0])).text
    },
  },
  'trace show': {
    args: '<name> <请求号>',
    summary: '看录制里某个请求的完整响应',
    opts: { path: { type: 'string', desc: '只看 JSON 里的一部分，如 data.replies[0]' }, max: { type: 'string' } },
    run: async (p, o) => showRequest(traceDirOf(p[0]), Number(String(p[1]).replace('#', '')), o.path, num(o.max)),
  },
  'trace find': {
    args: '<name> <text>',
    summary: '在录制的所有响应 / 请求里搜一段文字',
    run: async p => findInTrace(traceDirOf(p[0]), p.slice(1).join(' ')),
  },
  'script new': {
    args: '<site>',
    summary: '生成站点脚本骨架（--from-trace 根据录制生成，并附上调查报告）',
    opts: { 'from-trace': { type: 'string' }, project: { type: 'boolean', desc: '放在项目的 .bx/sites（默认 ~/.bx/sites）' } },
    run: async (p, o) => scriptNew(p[0], { fromTrace: o['from-trace'], project: o.project }),
  },
  'script test': {
    args: '<site> <命令...> [参数]',
    summary: '跑一遍站点命令并检查输出；--from-trace 和录制时看到的内容对比；--min 最少条数',
    run: async () => null, // 在 main() 里特殊处理（参数要原样传给站点命令）
  },
}

const GROUPS: [string, string[]][] = [
  ['浏览器', ['browser list', 'browser launch', 'browser connect', 'browser disconnect']],
  ['标签', ['tab list', 'tab open', 'tab use', 'tab close', 'tab activate', 'tab current']],
  ['标签组', ['group list', 'group create', 'group update', 'group ungroup']],
  ['看页面', ['read', 'snapshot', 'shot', 'eval', 'console', 'dialogs', 'cookies']],
  ['操作页面', ['goto', 'back', 'forward', 'reload', 'click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'upload', 'drag', 'wait']],
  ['注入 / 网络', ['inject add', 'inject list', 'inject rm', 'net log', 'net show', 'net wait', 'net clear', 'net route add', 'net route list', 'net route rm']],
  ['录制 → 写脚本', ['trace start', 'trace mark', 'trace add', 'trace status', 'trace stop', 'trace list', 'trace digest', 'trace show', 'trace find', 'trace rm', 'script new', 'script test']],
  ['扩展', ['site list', 'reader list', 'cdp']],
  ['daemon', ['daemon start', 'daemon stop', 'daemon restart', 'daemon status', 'daemon log']],
]

function help() {
  const lines = ['bx — 给 AI 用的浏览器控制工具', '', '用法：bx <命令> [参数] [-t 标签] [-o text|json|yaml|jsonl|csv|table]', '']
  for (const [title, names] of GROUPS) {
    lines.push(`${title}：`)
    for (const n of names) {
      const c = COMMANDS[n]
      lines.push(`  ${(n + (c.args ? ' ' + c.args : '')).padEnd(34)} ${c.summary}`)
    }
    lines.push('')
  }
  const sites = listSites()
  if (sites.length) lines.push(`站点脚本：${sites.map(s => s.name).join(', ')}   （bx <站点> --help）`, '')
  lines.push('典型流程：bx tab open <url> → bx read（看内容）/ bx snapshot（找 ref）→ bx click e3 / bx fill e5 "文字"')
  lines.push('环境变量：BX_TAB 固定操作某个标签（多个 agent 并行时用）；BX_FORMAT 默认输出格式')
  return lines.join('\n')
}

function cmdHelp(name: string, c: Cmd) {
  const lines = [`bx ${name}${c.args ? ' ' + c.args : ''}`, '', c.summary]
  const opts = Object.entries(c.opts || {})
  if (opts.length) {
    lines.push('', '选项：')
    for (const [k, o] of opts) lines.push(`  ${(`--${k}${o.short ? ', -' + o.short : ''}${o.type === 'string' ? ' <值>' : ''}`).padEnd(26)} ${o.desc || ''}`)
  }
  lines.push('', '通用：-t <标签id>  -o <格式>')
  return lines.join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  // 写在命令前面的全局参数：bx -t t2 read / bx -o json tab list
  const pre: Record<string, string> = {}
  while (argv.length && /^(-t|--tab|-o|--output|--browser)$/.test(argv[0]) && argv[1] !== undefined) {
    const k = argv.shift()!
    pre[k === '-t' || k === '--tab' ? 'tab' : k === '--browser' ? 'browser' : 'output'] = argv.shift()!
  }
  if (pre.tab) process.env.BX_TAB = pre.tab
  if (pre.output) process.env.BX_FORMAT = pre.output
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') return console.log(help())
  if (argv[0] === '--version' || argv[0] === '-v') return console.log(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version)

  // 找命令：最长匹配
  let name = ''
  for (let n = 3; n > 0; n--) {
    const cand = argv.slice(0, n).join(' ')
    if (COMMANDS[cand]) {
      name = cand
      break
    }
  }

  if (!name) {
    // 站点脚本？
    const site = await loadSite(argv[0])
    if (site) return runSite(site, argv.slice(1), { output: undefined, tab: process.env.BX_TAB, browser: pre.browser })
    // 命名空间下的帮助：bx tab / bx net
    const sub = Object.keys(COMMANDS).filter(k => k.startsWith(argv[0] + ' '))
    if (sub.length) {
      console.log(sub.map(k => `  bx ${(k + (COMMANDS[k].args ? ' ' + COMMANDS[k].args : '')).padEnd(34)} ${COMMANDS[k].summary}`).join('\n'))
      return
    }
    throw new BxError('UNKNOWN_COMMAND', `未知命令：${argv[0]}`, '`bx help` 查看所有命令，`bx site list` 查看站点脚本')
  }

  const cmd = COMMANDS[name]
  const rest = argv.slice(name.split(' ').length)
  if (name === 'script test' && !rest.includes('--help')) {
    // 自己的选项挑出来，其余原样传给站点命令
    const own: any = {}
    const pass: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--from-trace' || rest[i] === '--min' || rest[i] === '--timeout') own[rest[i].slice(2)] = rest[++i]
      else pass.push(rest[i])
    }
    if (!pass[0]) throw new BxError('BAD_ARGS', '需要站点名和命令', '例：bx script test bili search 电影 --limit 5 --from-trace t1')
    const r = await scriptTest(pass[0], pass.slice(1), { fromTrace: own['from-trace'], min: own.min ? Number(own.min) : undefined, timeout: own.timeout ? Number(own.timeout) : undefined })
    console.log(r.text)
    if (!r.ok) process.exitCode = 1
    return
  }
  if (rest.includes('--help') || rest.includes('-h')) return console.log(cmdHelp(name, cmd))
  const options: any = { tab: { type: 'string', short: 't' }, output: { type: 'string', short: 'o' } }
  for (const [k, o] of Object.entries(cmd.opts || {})) options[k] = { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) }
  const { values, positionals } = parseArgs({ args: rest, options, allowPositionals: true, strict: true })
  const o: any = { ...values }
  o.tab ||= process.env.BX_TAB

  let client: RpcClient | undefined
  const rpc = async () => (client ||= await RpcClient.connect())
  try {
    const result = await cmd.run(positionals, o, rpc)
    const fmt: Format = (o.output as Format) || (process.env.BX_FORMAT as Format) || 'text'
    const s = render(result, fmt, cmd.kind)
    if (s) console.log(s)
  } finally {
    client?.close()
  }
}

main().catch(e => {
  if (e instanceof BxError || e?.code) {
    process.stderr.write(`✗ ${e.message}\n${e.hint ? '  → ' + e.hint + '\n' : ''}`)
  } else {
    process.stderr.write(`✗ ${e?.message || e}\n`)
  }
  process.exitCode = e?.code === 'BAD_ARGS' || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 2 : 1
})

