import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { Driver, TabInfo } from './types.ts'
import { TabSession } from './session.ts'
import { CdpDriver, launchBrowser } from './drivers/cdp.ts'
import { ExtensionDriver } from './drivers/extension.ts'
import { snapshot } from './snapshot.ts'
import * as act from './actions.ts'
import { read, loadReaders } from './read.ts'
import { Trace, DESCRIBE_FN, listTraces, traceDir } from './trace.ts'
import { digestTrace } from '../trace/digest.ts'
import { BX_HOME, DAEMON_FILE, DEFAULT_PORT, ensureDir, readConfig } from '../common/paths.ts'
import { BxError, sleep, urlMatches } from '../common/util.ts'

const log = (...a: any[]) => console.log(new Date().toISOString(), ...a)

// =====================================================================
// 浏览器 & 标签注册表
// 标签对外用短 id（t1, t2 …），跨浏览器全局唯一，AI 不用管它在哪个浏览器
// =====================================================================

const browsers = new Map<string, Driver>()
const tabShort = new Map<string, { browser: string; nativeId: string }>()
const nativeShort = new Map<string, string>()
const sessions = new Map<string, TabSession>()
let tabSeq = 0
let currentTab: string | undefined

const key = (b: string, n: string) => `${b}|${n}`

function shortFor(browser: string, nativeId: string) {
  const k = key(browser, nativeId)
  let id = nativeShort.get(k)
  if (!id) {
    id = 't' + ++tabSeq
    nativeShort.set(k, id)
    tabShort.set(id, { browser, nativeId })
  }
  return id
}

function forgetTab(browser: string, nativeId: string) {
  const id = nativeShort.get(key(browser, nativeId))
  if (!id) return
  nativeShort.delete(key(browser, nativeId))
  tabShort.delete(id)
  sessions.delete(id)
  if (currentTab === id) currentTab = undefined
}

function registerBrowser(d: Driver) {
  let name = d.name
  for (let i = 2; browsers.has(name); i++) name = `${d.name}-${i}`
  d.name = name
  browsers.set(name, d)
  wireDriver(d)
  log('browser connected', d.kind, name)
  return name
}

function wireDriver(d: Driver) {
  d.onCdpEvent((nativeId, method, params) => {
    const id = nativeShort.get(key(d.name, nativeId))
    const s = id && sessions.get(id)
    if (s) s.onEvent(method, params)
  })
  d.onTabGone((nativeId, reason) => {
    if (reason === 'closed' || reason === 'tabRemoved' || reason === 'target_closed') forgetTab(d.name, nativeId)
    else {
      const id = nativeShort.get(key(d.name, nativeId))
      const s = id && sessions.get(id)
      if (s) s.reset()
    }
  })
  d.onClose(() => {
    if (browsers.get(d.name) !== d) return
    browsers.delete(d.name)
    for (const [id, t] of [...tabShort]) if (t.browser === d.name) forgetTab(t.browser, t.nativeId)
    log('browser gone', d.name)
  })
}

function getBrowser(name?: string): Driver {
  if (name) {
    const b = browsers.get(name)
    if (!b) throw new BxError('NO_BROWSER', `没有叫 ${name} 的浏览器`, `已连接：${[...browsers.keys()].join(', ') || '(无)'}`)
    return b
  }
  if (browsers.size === 0) throw noBrowser()
  if (currentTab && tabShort.has(currentTab)) return browsers.get(tabShort.get(currentTab)!.browser)!
  if (browsers.size === 1) return [...browsers.values()][0]
  throw new BxError('AMBIGUOUS_BROWSER', `连着多个浏览器：${[...browsers.keys()].join(', ')}`, '用 --browser <名字> 指定')
}

function noBrowser() {
  return new BxError(
    'NO_BROWSER',
    '还没有连接任何浏览器',
    '两种方式：① 在日常 Chrome 里装 bx 插件（extension 目录），复用登录状态；② `bx browser launch` 启动一个专用浏览器',
  )
}

async function listAllTabs(browser?: string) {
  const out: (TabInfo & { id: string; browser: string })[] = []
  for (const d of browsers.values()) {
    if (browser && d.name !== browser) continue
    const tabs = await d.listTabs().catch(() => [])
    for (const t of tabs) out.push({ ...t, id: shortFor(d.name, t.nativeId), browser: d.name })
  }
  return out
}

function tabRef(id?: string) {
  let tid = id ? (id.startsWith('t') ? id : 't' + id) : currentTab
  if (!tid) throw new BxError('NO_TAB', '没有当前标签页', '`bx tab list` 看看有哪些，再 `bx tab use <id>`；或 `bx tab open <url>`')
  const t = tabShort.get(tid)
  if (!t) throw new BxError('NO_TAB', `标签 ${tid} 不存在（可能已关闭）`, '执行 `bx tab list`')
  return { id: tid, ...t, driver: browsers.get(t.browser)! }
}

function session(id?: string): TabSession {
  const t = tabRef(id)
  let s = sessions.get(t.id)
  if (!s) {
    s = new TabSession(t.driver, t.nativeId, t.id)
    sessions.set(t.id, s)
  }
  return s
}

// =====================================================================
// 操作后的"变化摘要"：让 AI 不用每次都重新 snapshot 才知道发生了什么
// =====================================================================

async function withChanges<T>(s: TabSession, fn: () => Promise<T>, opts: { settle?: boolean } = {}) {
  await s.ensure('Page')
  const d = s.driver
  const before = {
    url: await s.evaluate('location.href').catch(() => ''),
    title: await s.evaluate('document.title').catch(() => ''),
    nav: s.navCount,
    dialogs: s.dialogs.length,
    tabs: new Set((await d.listTabs().catch(() => [])).map(t => t.nativeId)),
  }
  const result = await fn()
  if (opts.settle !== false) await s.settle(6000)
  const changes: Record<string, any> = {}
  if (!tabShort.has(s.shortId)) {
    changes.tabClosed = true
    return { ...(result as any), changes }
  }
  const url = await s.evaluate('location.href').catch(() => before.url)
  const title = await s.evaluate('document.title').catch(() => before.title)
  if (url !== before.url) changes.url = url
  if (title !== before.title) changes.title = title
  if (s.navCount !== before.nav) changes.navigated = true
  if (s.dialogs.length > before.dialogs) changes.dialogs = s.dialogs.slice(before.dialogs).map(x => `${x.type}: ${x.message} (${x.handled})`)
  const after = await d.listTabs().catch(() => [])
  const fresh = after.filter(t => !before.tabs.has(t.nativeId))
  if (fresh.length) changes.newTabs = fresh.map(t => ({ id: shortFor(d.name, t.nativeId), url: t.url }))
  if (changes.navigated) changes.note = '页面已跳转，之前的 ref 失效，需要重新 snapshot'
  if (fresh.length) changes.note = (changes.note ? changes.note + '；' : '') + `打开了新标签，用 \`bx tab use ${changes.newTabs[0].id}\` 切过去`
  return { ok: true, ...(result as any), changes: Object.keys(changes).length ? changes : undefined }
}

// =====================================================================
// 标签组：tab open --group <组名或组 id> 时把新标签放进去（默认不放）
// =====================================================================

async function putInGroup(d: Driver, nativeId: string, group: string) {
  if (!d.groups) return
  const tabs = await d.listTabs()
  const me = tabs.find(t => t.nativeId === nativeId)
  const groups = await d.groups.list()
  // 先按 id 找，再按名字找（同一窗口优先），都没有就新建
  const g =
    groups.find(g => String(g.id) === group) ||
    groups.find(g => g.title === group && g.windowId === me?.windowId) ||
    groups.find(g => g.title === group)
  if (g) {
    await (d as ExtensionDriver).ext('groups.create', { tabIds: [Number(nativeId)], groupId: g.id })
    return { id: g.id, title: g.title, created: false }
  }
  const n = await d.groups.create([nativeId], { title: group, color: 'purple' })
  return { id: n.id, title: n.title, created: true }
}

// =====================================================================
// RPC 方法
// =====================================================================

type Handler = (p: any) => Promise<any>
const methods: Record<string, Handler> = {
  'daemon.status': async () => ({
    pid: process.pid,
    port: PORT,
    browsers: [...browsers.values()].map(b => ({ name: b.name, kind: b.kind })),
    currentTab,
  }),
  'daemon.stop': async () => {
    setTimeout(() => shutdown(), 100)
    return { ok: true }
  },

  // ---------- 浏览器 ----------
  'browser.list': async () =>
    Promise.all(
      [...browsers.values()].map(async b => ({
        name: b.name,
        kind: b.kind,
        tabs: (await b.listTabs().catch(() => [])).length,
        groups: !!b.groups,
        ...(b.kind === 'extension' ? { userAgent: b.info.userAgent } : { endpoint: (b as CdpDriver).endpoint }),
        ...(b.info.launched ? { profile: b.info.launched.profile, headless: b.info.launched.headless } : {}),
      })),
    ),
  'browser.launch': async ({ name = 'bx', headless, executable, port }) => {
    if (browsers.has(name)) throw new BxError('EXISTS', `已经有叫 ${name} 的浏览器了`)
    const d = await launchBrowser(name, { headless, executable, port })
    registerBrowser(d)
    return { name: d.name, endpoint: d.endpoint, ...d.info.launched }
  },
  'browser.connect': async ({ name, cdp }) => {
    const d = new CdpDriver(name || 'cdp', cdp)
    await d.connect()
    return { name: registerBrowser(d), endpoint: cdp }
  },
  'browser.disconnect': async ({ name, kill }) => {
    const d = getBrowser(name)
    if (kill && d.kind === 'cdp') await (d as CdpDriver).closeBrowser()
    await d.close()
    browsers.delete(d.name)
    return { ok: true }
  },

  // ---------- 标签 ----------
  'debug.ext': async ({ browser, method, params }) => {
    const d = getBrowser(browser)
    if (d.kind !== 'extension') throw new BxError('BAD_ARG', `${d.name} 不是插件模式`)
    return (d as ExtensionDriver).ext(method, params || {})
  },
  'tab.list': async ({ browser, filter }) => {
    let tabs = await listAllTabs(browser)
    if (filter) tabs = tabs.filter(t => t.url.includes(filter) || t.title.toLowerCase().includes(String(filter).toLowerCase()))
    const groups = new Map<string, string>()
    for (const d of browsers.values()) if (d.groups) for (const g of await d.groups.list().catch(() => [])) groups.set(`${d.name}|${g.id}`, g.title || g.color)
    return tabs.map(t => ({
      id: t.id,
      cur: t.id === currentTab ? '*' : '',
      browser: t.browser,
      active: t.active || undefined,
      group: t.groupId !== undefined ? groups.get(`${t.browser}|${t.groupId}`) : undefined,
      title: t.title,
      url: t.url,
    }))
  },
  'tab.open': async ({ url, browser, background, group, keep }) => {
    const d = getBrowser(browser)
    const t = await d.openTab('about:blank', { background })
    const id = shortFor(d.name, t.nativeId)
    let groupInfo: any
    let groupNote: string | undefined
    if (group !== undefined && group !== false && group !== '') {
      if (!d.groups) groupNote = `${d.name} 是 CDP 模式，不支持标签组，没有放进组`
      else groupInfo = await putInGroup(d, t.nativeId, String(group)).catch(e => ((groupNote = `放进组失败：${e.message}`), undefined))
    }
    if (!keep) currentTab = id
    const s = session(id)
    if (trace) await trace.addTab(s, 'newtab')
    if (url && url !== 'about:blank') await act.goto(s, url).catch(e => log('open', e.message))
    const finalUrl = await s.evaluate('location.href').catch(() => url)
    const out: any = { id, browser: d.name, url: finalUrl, title: await s.evaluate('document.title').catch(() => ''), current: !keep }
    if (String(finalUrl).startsWith('chrome-error://')) {
      const reason = await s.evaluate(`document.querySelector('.error-code')?.textContent || ''`).catch(() => '')
      out.error = `页面打开失败 ${reason}`.trim()
    }
    if (groupInfo) out.group = groupInfo.title + (groupInfo.created ? '（新建）' : '')
    if (groupNote) out.note = groupNote
    return out
  },
  'tab.close': async ({ ids }) => {
    const list: string[] = ids?.length ? ids : [tabRef().id]
    for (const id of list) {
      const t = tabRef(id)
      await t.driver.closeTab(t.nativeId)
      forgetTab(t.browser, t.nativeId)
    }
    return { closed: list, current: currentTab }
  },
  'tab.use': async ({ id }) => {
    const t = tabRef(id)
    currentTab = t.id
    const s = session(t.id)
    return { current: t.id, browser: t.browser, url: await s.evaluate('location.href').catch(() => ''), title: await s.evaluate('document.title').catch(() => '') }
  },
  'tab.activate': async ({ id }) => {
    const t = tabRef(id)
    await t.driver.activateTab(t.nativeId)
    return { ok: true, id: t.id }
  },
  'tab.current': async () => {
    if (!currentTab) return { current: null }
    return methods['tab.use']({ id: currentTab })
  },
  /** 找一个 URL 匹配的标签（给脚本用）；没有就新开 */
  'tab.find': async ({ match, open, browser, background = true }) => {
    const tabs = await listAllTabs(browser)
    const hit = tabs.find(t => urlMatches(t.url, match))
    if (hit) return { id: hit.id, url: hit.url, reused: true }
    if (!open) return null
    const r = await methods['tab.open']({ url: open, browser, background, keep: true })
    return { id: r.id, url: r.url, reused: false }
  },

  // ---------- 标签组 ----------
  'group.list': async ({ browser }) => {
    const out: any[] = []
    for (const d of browsers.values()) {
      if (browser && d.name !== browser) continue
      if (!d.groups) continue
      const tabs = await listAllTabs(d.name)
      for (const g of await d.groups.list())
        out.push({ id: g.id, browser: d.name, title: g.title, color: g.color, collapsed: g.collapsed || undefined, tabs: tabs.filter(t => t.groupId === g.id).map(t => t.id) })
    }
    return out
  },
  'group.create': async ({ tabs, title, color }) => {
    const refs = (tabs?.length ? tabs : [tabRef().id]).map((x: string) => tabRef(x))
    const d = refs[0].driver
    if (!d.groups) throw new BxError('UNSUPPORTED', '标签组只有插件模式支持（CDP 没有标签组接口）')
    if (refs.some((r: any) => r.driver !== d)) throw new BxError('BAD_ARGS', '一个标签组里的标签必须在同一个浏览器')
    return d.groups.create(refs.map((r: any) => r.nativeId), { title, color })
  },
  'group.update': async ({ id, browser, title, color, collapsed }) => {
    const d = getBrowser(browser)
    if (!d.groups) throw new BxError('UNSUPPORTED', '标签组只有插件模式支持')
    return d.groups.update(Number(id), { title, color, collapsed })
  },
  'group.ungroup': async ({ tabs }) => {
    const refs = (tabs?.length ? tabs : [tabRef().id]).map((x: string) => tabRef(x))
    const d = refs[0].driver
    if (!d.groups) throw new BxError('UNSUPPORTED', '标签组只有插件模式支持')
    await d.groups.ungroup(refs.map((r: any) => r.nativeId))
    return { ok: true }
  },

  // ---------- 页面：导航 ----------
  'page.goto': async ({ tab, url }) => {
    const s = session(tab)
    return withChanges(s, async () => (await act.goto(s, url), {}), { settle: false })
  },
  'page.back': async ({ tab }) => withChanges(session(tab), async () => (await act.history(session(tab), -1), {}), { settle: false }),
  'page.forward': async ({ tab }) => withChanges(session(tab), async () => (await act.history(session(tab), 1), {}), { settle: false }),
  'page.reload': async ({ tab }) => withChanges(session(tab), async () => (await act.reload(session(tab)), {}), { settle: false }),
  'page.wait': async ({ tab, ...o }) => act.waitFor(session(tab), o),

  // ---------- 页面：观察 ----------
  'page.snapshot': async ({ tab, interactive, max }) => snapshot(session(tab), { interactive, maxLines: max }),
  'page.read': async ({ tab, ...o }) => read(session(tab), o),
  'page.shot': async ({ tab, ...o }) => {
    const t = tabRef(tab)
    return act.screenshot(session(tab), o, () => t.driver.activateTab(t.nativeId))
  },
  'page.eval': async ({ tab, code, world }) => {
    const s = session(tab)
    if (world === 'isolated') {
      // 隔离环境：和页面共享 DOM，但看不到页面的 JS 变量，页面也看不到我们
      const { frameTree } = await s.send('Page.getFrameTree')
      const { executionContextId } = await s.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'bx' })
      const r = await s.send('Runtime.evaluate', { expression: code, contextId: executionContextId, returnByValue: true, awaitPromise: true, replMode: true })
      if (r.exceptionDetails) throw new BxError('JS_ERROR', `JS 报错：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
      return { value: r.result.value }
    }
    return { value: await s.evaluate(code, { replMode: true }) }
  },
  'page.fetch': async ({ tab, url, init, as }) => {
    const s = session(tab)
    const r = await s.evaluate(`(async () => {
      const r = await fetch(${JSON.stringify(url)}, Object.assign({ credentials: 'include' }, ${JSON.stringify(init || {})}));
      const text = await r.text();
      return { status: r.status, url: r.url, headers: Object.fromEntries(r.headers), text };
    })()`)
    if (as === 'text') return r
    try {
      return { ...r, json: JSON.parse(r.text), text: undefined }
    } catch {
      return r
    }
  },
  'page.console': async ({ tab, level, clear, limit = 50 }) => {
    const s = session(tab)
    const first = !s.enabled.has('Runtime')
    await s.ensure('Runtime')
    let list = s.console
    if (level) list = list.filter(x => x.level === level || (level === 'error' && x.level === 'exception'))
    const out = list.slice(-limit).map(x => ({ level: x.level, text: x.text }))
    if (clear) s.console = []
    return first ? { note: '控制台记录刚开启，之前的日志没有；需要的话 bx reload 后再看', logs: out } : out
  },
  'page.dialogs': async ({ tab, policy }) => {
    const s = session(tab)
    if (policy) s.dialogPolicy = policy
    return { policy: s.dialogPolicy, recent: s.dialogs.slice(-10) }
  },

  // ---------- 页面：交互 ----------
  'page.click': async ({ tab, ref, double, right, force }) => {
    const s = session(tab)
    return withChanges(s, async () => (await act.click(s, ref, { double, right, force }), {}))
  },
  'page.hover': async ({ tab, ref }) => withChanges(session(tab), async () => (await act.hover(session(tab), ref), {})),
  'page.fill': async ({ tab, ref, text, append, submit }) => {
    const s = session(tab)
    return withChanges(s, () => act.fill(s, ref, text, { append, submit }), { settle: !!submit })
  },
  'page.press': async ({ tab, keys }) => {
    const s = session(tab)
    return withChanges(s, async () => {
      for (const k of keys) await act.press(s, k)
      return {}
    })
  },
  'page.type': async ({ tab, text }) => {
    const s = session(tab)
    await s.send('Input.insertText', { text })
    return { ok: true }
  },
  'page.select': async ({ tab, ref, values }) => withChanges(session(tab), () => act.selectOption(session(tab), ref, values)),
  'page.check': async ({ tab, ref, value = true }) => withChanges(session(tab), () => act.check(session(tab), ref, value)),
  'page.upload': async ({ tab, ref, files }) => withChanges(session(tab), () => act.upload(session(tab), ref, files)),
  'page.drag': async ({ tab, from, to }) => withChanges(session(tab), async () => (await act.drag(session(tab), from, to), {})),
  'page.scroll': async ({ tab, ref, dir, amount }) => act.scroll(session(tab), { ref, dir, amount }),

  // ---------- 注入 ----------
  'inject.add': async ({ tab, source, label, now = true }) => {
    const s = session(tab)
    await s.ensure('Page')
    const { identifier } = await s.send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true })
    s.inits.push({ id: identifier, source, label: label || source.slice(0, 60) })
    if (now) await s.evaluate(source).catch(() => {})
    return { id: identifier, note: '之后这个标签每次打开新页面都会先执行这段脚本（在页面自己的脚本之前）' }
  },
  'inject.list': async ({ tab }) => session(tab).inits.map(x => ({ id: x.id, label: x.label })),
  'inject.rm': async ({ tab, id }) => {
    const s = session(tab)
    const ids = id ? [id] : s.inits.map(x => x.id)
    for (const i of ids) await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: i }).catch(() => {})
    s.inits = s.inits.filter(x => !ids.includes(x.id))
    return { removed: ids }
  },

  // ---------- 网络 ----------
  'net.log': async ({ tab, filter, type, status, limit = 50, failed }) => {
    const s = session(tab)
    const first = !s.enabled.has('Network')
    await s.ensure('Network')
    let list = s.netOrder
    if (filter) list = list.filter(e => e.url.includes(filter))
    if (type) {
      const types = String(type).split(',')
      list = list.filter(e => types.includes(e.type))
    }
    if (status) list = list.filter(e => String(e.status ?? '').startsWith(String(status).replace(/x+$/, '')))
    if (failed) list = list.filter(e => e.failed || (e.status ?? 0) >= 400)
    const rows = list.slice(-limit).map(e => ({
      id: e.id,
      method: e.method,
      status: e.failed ? `ERR ${e.failed}` : e.status ?? '…',
      type: e.type,
      size: e.size,
      ms: e.duration,
      url: e.url.length > 200 ? e.url.slice(0, 200) + '…' : e.url,
    }))
    if (first) return { note: '网络记录刚开启，之前的请求没有记录；需要的话先 bx reload', requests: rows }
    return rows
  },
  'net.show': async ({ tab, id, body = true, headers, max = 20000 }) => {
    const s = session(tab)
    const e = s.netOrder.find(x => x.id === Number(id))
    if (!e) throw new BxError('NO_REQUEST', `没有请求 #${id}`, '`bx net log` 查看请求列表')
    const out: any = { ...e, requestId: undefined, done: undefined, start: undefined }
    if (!headers) {
      out.requestHeaders = undefined
      out.responseHeaders = undefined
    }
    if (body && e.done && !e.failed) {
      const b = await s.responseBody(e).catch(err => ({ body: `(${err.message})`, base64: false }))
      if (b.base64) out.body = `(二进制 ${Math.round((b.body.length * 3) / 4)} 字节)`
      else {
        try {
          out.json = JSON.parse(b.body)
        } catch {
          out.body = b.body.length > max ? b.body.slice(0, max) + `…(共 ${b.body.length} 字符)` : b.body
        }
      }
    }
    return out
  },
  'net.wait': async ({ tab, match, timeout, body = true }) => {
    const s = session(tab)
    await s.ensure('Network')
    const e = await s.waitForResponse(match, timeout)
    if (!body) return { id: e.id, url: e.url, status: e.status }
    return methods['net.show']({ tab: s.shortId, id: e.id })
  },
  'net.clear': async ({ tab }) => {
    const s = session(tab)
    s.netOrder = []
    s.net.clear()
    return { ok: true }
  },
  'net.route.add': async ({ tab, pattern, action, status, body, contentType, headers }) => {
    const s = session(tab)
    const r = { id: ++s.routeSeq, pattern, action, status, body, contentType, headers, hits: 0 }
    s.routes.push(r)
    await s.syncFetch()
    return { id: r.id, pattern, action }
  },
  'net.route.list': async ({ tab }) => session(tab).routes.map(r => ({ id: r.id, pattern: r.pattern, action: r.action, hits: r.hits })),
  'net.route.rm': async ({ tab, id }) => {
    const s = session(tab)
    s.routes = id ? s.routes.filter(r => r.id !== Number(id)) : []
    await s.syncFetch()
    return { remaining: s.routes.length }
  },

  // ---------- 其它 ----------
  'cookies.get': async ({ tab, url }) => {
    const s = session(tab)
    const u = url || (await s.evaluate('location.href'))
    const r = await s.send('Network.getCookies', { urls: [u] })
    return r.cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure }))
  },
  'reader.list': async ({ cwd }) => {
    const { readers, errors } = await loadReaders(cwd)
    return { readers: readers.map(r => ({ name: r.name, scope: r.scope, match: r.meta.match, file: r.file, description: r.meta.description })), errors: errors.length ? errors : undefined }
  },
  'cdp.send': async ({ tab, method, params }) => session(tab).send(method, params),

  // ---------- trace 录制 ----------
  'trace.start': async ({ name, goal, tab, noTab }) => {
    if (trace) throw new BxError('TRACING', `正在录制 ${trace.name}`, '先 `bx trace stop`')
    const n = name || 'trace-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const t = new Trace(n, goal)
    trace = t
    try {
      if (!noTab && (tab || currentTab)) await t.addTab(session(tab))
    } catch (e: any) {
      log('trace addTab', e.message)
    }
    return {
      ...t.status(),
      note: '开始录制。之后用 bx 操作的标签会自动加入；用户在这些标签里手动点击/输入也会记下。关键步骤可以 bx trace mark "说明"，结束用 bx trace stop',
    }
  },
  'trace.status': async () => (trace ? trace.status() : { recording: false }),
  'trace.mark': async ({ note, tab }) => {
    if (!trace) throw new BxError('NOT_TRACING', '没有在录制', '`bx trace start --goal "要做什么"`')
    trace.add({ tab: tab || currentTab || '', type: 'mark', note })
    return { ok: true, t: trace.rel() }
  },
  'trace.add': async ({ tab }) => {
    if (!trace) throw new BxError('NOT_TRACING', '没有在录制')
    await trace.addTab(session(tab), 'newtab')
    return trace.status()
  },
  'trace.stop': async () => {
    if (!trace) throw new BxError('NOT_TRACING', '没有在录制')
    const t = trace
    trace = null
    const r = await t.stop()
    const report = digestTrace(r.dir)
    return { ...r, report: report.file, next: `bx trace digest ${r.name}   # 查看调查报告；写脚本：bx script new <站点名> --from-trace ${r.name}` }
  },
  'trace.list': async () => listTraces(),
  'trace.rm': async ({ name }) => {
    const d = traceDir(name)
    fs.rmSync(d, { recursive: true, force: true })
    return { removed: name }
  },
}

// =====================================================================
// trace：录制期间，把操作和观察到的内容记下来
// =====================================================================

let trace: Trace | null = null
const TRACED_ACTIONS = new Set(['page.goto', 'page.back', 'page.forward', 'page.reload', 'page.click', 'page.hover', 'page.fill', 'page.press', 'page.type', 'page.select', 'page.check', 'page.upload', 'page.drag', 'page.scroll', 'page.wait', 'tab.open', 'tab.use', 'page.fetch'])
const TRACED_OBS = new Set(['page.read', 'page.snapshot', 'page.eval', 'net.show', 'net.wait'])

async function traced(method: string, p: any, h: Handler) {
  const t = trace!
  let s: TabSession | undefined
  if (method !== 'tab.open') {
    try {
      s = session(p.tab)
      await t.addTab(s, 'auto')
    } catch {}
  }
  const describe = async (ref?: string) => (s && ref ? s.callOn(s.resolveRef(ref), DESCRIBE_FN).catch(() => undefined) : undefined)
  const target = await describe(p.ref || p.from)
  const toTarget = p.to ? await describe(p.to) : undefined
  const short = method.replace(/^page\./, '')
  const args: any = {}
  for (const k of ['url', 'ref', 'text', 'keys', 'values', 'value', 'files', 'dir', 'selector', 'fn', 'match', 'id', 'section', 'via', 'mode', 'code', 'init', 'submit', 'from', 'to']) if (p[k] !== undefined) args[k] = p[k]
  if (s) s.acting++
  const t0 = t.rel() // 记操作开始的时间，这样它触发的请求排在它后面
  try {
    const r = await h(p)
    const tab = s?.shortId || r?.id || ''
    if (TRACED_OBS.has(method)) {
      const out = typeof r === 'string' ? r : JSON.stringify(r)
      t.add({ t: t0, tab, type: 'observe', method: short, args, output: out.slice(0, 60000) })
    } else {
      const ev: any = { t: t0, tab, type: 'action', method: short, args }
      if (target) ev.target = target
      if (toTarget) ev.toTarget = toTarget
      if (r?.changes) ev.changes = r.changes
      if (method === 'page.fill' && r?.value !== undefined) ev.value = r.value
      if (method === 'page.fetch') ev.status = r?.status
      t.add(ev)
      // 操作打开的新标签也加进录制
      for (const nt of r?.changes?.newTabs || []) await t.addTab(session(nt.id), 'newtab').catch(() => {})
    }
    return r
  } catch (e: any) {
    t.add({ t: t0, tab: s?.shortId || '', type: 'action', method: short, args, target, error: e.message })
    throw e
  } finally {
    if (s) {
      s.acting--
      s.actedAt = Date.now()
    }
  }
}

// =====================================================================
// 服务
// =====================================================================

const config = readConfig()
const PORT = Number(config.port || DEFAULT_PORT)
const TOKEN = crypto.randomBytes(16).toString('hex')
const BOOT = Date.now()

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('bx daemon\n')
})
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 })

server.on('upgrade', (req, sock, head) => {
  const u = new URL(req.url || '/', 'http://x')
  const origin = req.headers.origin || ''
  if (u.pathname === '/ext') {
    // 只接受浏览器插件（网页的 Origin 是 http(s)://，伪造不了 chrome-extension://）
    if (!/^(chrome|moz)-extension:\/\//.test(origin)) return sock.destroy()
  } else if (u.pathname === '/cli') {
    if (u.searchParams.get('token') !== TOKEN || origin) return sock.destroy()
  } else return sock.destroy()
  wss.handleUpgrade(req, sock, head, ws => {
    if (u.pathname === '/ext') onExtension(ws, origin)
    else onClient(ws)
  })
})

function onExtension(ws: WebSocket, origin: string) {
  ws.once('message', raw => {
    const hello = JSON.parse(String(raw))
    if (hello.type !== 'hello') return ws.close()
    const d = new ExtensionDriver(hello.name || 'chrome', ws, { userAgent: hello.userAgent, origin, extensionId: hello.extensionId })
    // 同一个插件重连：替换旧连接，标签 id 保持不变
    for (const old of browsers.values()) {
      if (old.kind === 'extension' && old.info.origin === origin && old.name.replace(/-\d+$/, '') === d.name) {
        browsers.delete(old.name)
        d.name = old.name
        old.close().catch(() => {})
        for (const s of sessions.values()) if (s.driver === old) s.reset()
        for (const s of sessions.values()) if (s.driver === old) s.driver = d
        browsers.set(d.name, d)
        wireDriver(d)
        log('browser reconnected', d.name)
        return
      }
    }
    registerBrowser(d)
  })
}

function onClient(ws: WebSocket) {
  ws.on('message', async raw => {
    let msg: any
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    // daemon 刚启动时插件还没连上：稍等一下再回答，免得报"没有浏览器"
    if (browsers.size === 0 && !String(msg.method).startsWith('daemon.') && !String(msg.method).startsWith('trace.') && msg.method !== 'browser.launch' && msg.method !== 'browser.connect') {
      while (browsers.size === 0 && Date.now() - BOOT < 6000) await sleep(200)
    }
    const h = methods[msg.method]
    try {
      if (!h) throw new BxError('NO_METHOD', `未知方法 ${msg.method}`)
      const params = msg.params || {}
      const result = trace && (TRACED_ACTIONS.has(msg.method) || TRACED_OBS.has(msg.method)) ? await traced(msg.method, params, h) : await h(params)
      ws.send(JSON.stringify({ id: msg.id, result: result ?? null }))
    } catch (e: any) {
      const err = e instanceof BxError ? e.toJSON() : { code: 'ERROR', message: String(e?.message || e) }
      ws.send(JSON.stringify({ id: msg.id, error: err }))
    }
  })
}

async function shutdown() {
  log('shutting down')
  try {
    const info = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'))
    if (info.pid === process.pid) fs.unlinkSync(DAEMON_FILE)
  } catch {}
  for (const b of browsers.values()) await b.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('unhandledRejection', e => log('unhandledRejection', e))

server.on('error', (e: any) => {
  log('server error', e.message)
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', async () => {
  ensureDir(BX_HOME)
  fs.writeFileSync(DAEMON_FILE, JSON.stringify({ port: PORT, token: TOKEN, pid: process.pid }))
  log(`bx daemon listening on 127.0.0.1:${PORT} pid=${process.pid}`)
  // 配置文件里的浏览器自动连上
  for (const b of config.browsers || []) {
    try {
      if (b.cdp) {
        const d = new CdpDriver(b.name, b.cdp)
        await d.connect()
        registerBrowser(d)
      } else if (b.launch) registerBrowser(await launchBrowser(b.name, b.launch))
    } catch (e: any) {
      log('config browser failed', b.name, e.message)
    }
  }
})
