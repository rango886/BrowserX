// BrowserX 插件：把浏览器能力通过 ws 暴露给本机的 bx daemon
// - 浏览器级：tabs / tabGroups / windows
// - 页面级：chrome.debugger 转发 CDP（按需 attach）

const DEFAULTS = { port: 9777, name: '' }
let ws = null
let connecting = false
let connectedAt = 0
let lastError = ''
const attached = new Set()

async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS)
  if (!s.name) {
    // 默认名字：浏览器类型 + 随机后缀，用户可以在设置页改成 work / personal 之类
    const ua = navigator.userAgent
    const kind = ua.includes('Edg/') ? 'edge' : 'chrome'
    s.name = kind
  }
  return s
}

async function connect() {
  if (connecting || (ws && ws.readyState <= 1)) return
  connecting = true
  try {
    const { port, name } = await getSettings()
    if (ws && ws.readyState <= 1) return
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ext`)
    ws = sock // 立刻记下，防止重复连接
    sock.onopen = () => {
      connectedAt = Date.now()
      lastError = ''
      const ua = navigator.userAgent
      sock.send(JSON.stringify({ type: 'hello', name, userAgent: ua, extensionId: chrome.runtime.id }))
      setBadge('on')
    }
    sock.onmessage = e => onMessage(JSON.parse(e.data))
    sock.onclose = () => {
      if (ws === sock) ws = null
      if (connectedAt) lastError = '连接断开'
      else lastError = `连不上 127.0.0.1:${port}`
      connectedAt = 0
      setBadge('')
      setTimeout(connect, 3000)
    }
    sock.onerror = () => {}
  } finally {
    connecting = false
  }
}

function setBadge(text) {
  chrome.action.setBadgeText({ text }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color: '#2a7' }).catch(() => {})
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj))
}

// 心跳：WebSocket 有活动时 MV3 service worker 不会被休眠（Chrome 116+）
setInterval(() => send({ type: 'ping' }), 20_000)
chrome.alarms.create('bx-keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => connect())
chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
chrome.storage.onChanged.addListener(() => {
  ws?.close()
  setTimeout(connect, 200) // 改了设置马上重连，不用等 3 秒
})

// 设置页查询状态
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'status') {
    getSettings().then(s =>
      reply({
        connected: !!ws && ws.readyState === 1,
        connectedAt,
        lastError,
        name: s.name,
        port: s.port,
        attached: attached.size,
        version: chrome.runtime.getManifest().version,
      }),
    )
    return true
  }
  if (msg?.type === 'reconnect') {
    ws?.close()
    connect()
    reply(true)
  }
})

// 诊断日志：最近的 debugger 相关事件
const dbgLog = []
function dlog(...a) {
  dbgLog.push(new Date().toISOString().slice(11, 23) + ' ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
  if (dbgLog.length > 100) dbgLog.shift()
}
function timeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} 超时 ${ms}ms`)), ms))])
}

// 等标签加载完（status=complete）。Vivaldi 里标签还在初始导航时就 attach，
// 之后所有要渲染进程回答的 CDP 命令都会永远没有回应；Chrome 没这个问题，等一下也无害
function waitComplete(tabId, ms = 10_000) {
  return new Promise(resolve => {
    let done = false
    const finish = t => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(onUpd)
      clearTimeout(timer)
      resolve(t)
    }
    const onUpd = (id, info, t) => {
      if (id === tabId && info.status === 'complete') finish(t)
    }
    const timer = setTimeout(() => chrome.tabs.get(tabId).then(finish, () => finish(null)), ms)
    chrome.tabs.onUpdated.addListener(onUpd)
    chrome.tabs.get(tabId).then(t => t.status === 'complete' && finish(t), () => finish(null))
  })
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return
  // 被休眠（discarded）的标签没有渲染进程，命令会没回应，先唤醒
  const tab = await chrome.tabs.get(tabId)
  if (tab.discarded || tab.status !== 'complete') {
    dlog('wake/wait', tabId, { discarded: tab.discarded, status: tab.status })
    if (tab.discarded) await chrome.tabs.reload(tabId)
    await waitComplete(tabId, tab.discarded ? 15_000 : 5_000)
  }
  dlog('attach start', tabId)
  try {
    await timeout(chrome.debugger.attach({ tabId }, '1.3'), 10_000, 'debugger.attach')
    dlog('attach ok', tabId)
  } catch (e) {
    dlog('attach err', tabId, String(e?.message || e))
    if (!String(e.message).includes('already attached')) throw e
  }
  attached.add(tabId)
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (src.tabId !== undefined) send({ type: 'event', kind: 'cdp', tabId: src.tabId, method, params })
})
chrome.debugger.onDetach.addListener((src, reason) => {
  dlog('onDetach', src.tabId, reason)
  attached.delete(src.tabId)
  send({ type: 'event', kind: 'detached', tabId: src.tabId, reason })
})
chrome.tabs.onRemoved.addListener(tabId => {
  attached.delete(tabId)
  send({ type: 'event', kind: 'tabRemoved', tabId })
})

function groupInfo(g) {
  return { id: g.id, title: g.title || '', color: g.color, collapsed: g.collapsed, windowId: g.windowId }
}

const handlers = {
  'tabs.list': () => chrome.tabs.query({}),
  'tabs.open': async ({ url, active, windowId }) => {
    const t = await chrome.tabs.create({ url: url || 'about:blank', active: active !== false, windowId })
    return (await waitComplete(t.id)) || t
  },
  'tabs.close': ({ tabId }) => chrome.tabs.remove(tabId),
  'tabs.activate': async ({ tabId }) => {
    const t = await chrome.tabs.update(tabId, { active: true })
    await chrome.windows.update(t.windowId, { focused: true })
    return t
  },
  'windows.list': () => chrome.windows.getAll(),
  'groups.list': async () => (await chrome.tabGroups.query({})).map(groupInfo),
  'groups.create': async ({ tabIds, title, color, groupId }) => {
    const id = await chrome.tabs.group(groupId !== undefined ? { tabIds, groupId } : { tabIds })
    const upd = {}
    if (title !== undefined) upd.title = title
    if (color) upd.color = color
    const g = Object.keys(upd).length ? await chrome.tabGroups.update(id, upd) : await chrome.tabGroups.get(id)
    return groupInfo(g)
  },
  'groups.update': async ({ groupId, title, color, collapsed }) => {
    const upd = {}
    if (title !== undefined) upd.title = title
    if (color) upd.color = color
    if (collapsed !== undefined) upd.collapsed = collapsed
    return groupInfo(await chrome.tabGroups.update(groupId, upd))
  },
  'groups.ungroup': ({ tabIds }) => chrome.tabs.ungroup(tabIds),
  'cdp.send': async ({ tabId, method, params }) => {
    await ensureAttached(tabId)
    try {
      return await timeout(chrome.debugger.sendCommand({ tabId }, method, params || {}), 30_000, `sendCommand ${method}`)
    } catch (e) {
      dlog('send err', tabId, method, String(e?.message || e))
      throw e
    }
  },
  'debug.info': async () => ({
    attached: [...attached],
    targets: (await chrome.debugger.getTargets()).filter(t => t.attached || t.type !== 'page').map(t => ({ type: t.type, tabId: t.tabId, attached: t.attached, url: t.url?.slice(0, 80), extensionId: t.extensionId })),
    log: dbgLog,
  }),
  'runtime.reload': () => setTimeout(() => chrome.runtime.reload(), 100),
  'cdp.detach': async ({ tabId }) => {
    attached.delete(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => {})
  },
  'cookies.get': ({ url, name }) => (name ? chrome.cookies.get({ url, name }) : chrome.cookies.getAll({ url })),
}

async function onMessage(msg) {
  if (msg.type === 'pong') return
  const h = handlers[msg.method]
  if (!h) return send({ id: msg.id, error: { code: 'NO_METHOD', message: `插件不支持 ${msg.method}` } })
  try {
    const result = await h(msg.params || {})
    send({ id: msg.id, result: result === undefined ? null : result })
  } catch (e) {
    send({ id: msg.id, error: { code: 'EXT_ERROR', message: String(e?.message || e) } })
  }
}

connect()
