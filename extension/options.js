const $ = id => document.getElementById(id)

// 作为独立设置页（chrome://extensions → 详细信息 → 扩展程序选项）打开时，用宽一点的布局
if (!location.search.includes('popup')) document.body.classList.add('page')

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

let holdUntil = 0
function show(state, title, detail = '') {
  $('status').className = `status ${state}`
  $('st-title').textContent = title
  $('st-detail').textContent = detail
}

async function refresh() {
  if (Date.now() < holdUntil) return
  let s
  try {
    s = await chrome.runtime.sendMessage({ type: 'status' })
  } catch {
    return show('bad', '后台没有响应', '到扩展程序页面重新加载一下插件')
  }
  $('ver').textContent = 'v' + s.version
  if (s.connected) {
    const extra = s.attached ? ` · 正在控制 ${s.attached} 个标签` : ''
    show('ok', `已连接 · ${s.name}`, `daemon 127.0.0.1:${s.port} · ${ago(s.connectedAt)}连上${extra}`)
  } else {
    show('bad', '未连接', `${s.lastError || `连不上 127.0.0.1:${s.port}`}，每 3 秒自动重试`)
  }
}

chrome.storage.local.get({ port: 9777, name: '' }).then(s => {
  $('name').value = s.name
  $('port').value = s.port
})

$('form').onsubmit = async e => {
  e.preventDefault()
  await chrome.storage.local.set({ name: $('name').value.trim(), port: Number($('port').value) || 9777 })
  show('wait', '已保存，正在重连…')
  holdUntil = Date.now() + 1200
}

$('reconnect').onclick = async () => {
  show('wait', '正在重连…')
  holdUntil = Date.now() + 1200
  await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {})
}

refresh()
setInterval(refresh, 1000)
