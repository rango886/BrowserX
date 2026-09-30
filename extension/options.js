const $ = id => document.getElementById(id)

// 从扩展程序页面的"选项"打开时是独立页面，给它加个边框居中
if (!location.search.includes('popup')) document.body.classList.add('page')

let saved = { name: '', port: 9777 }
let retrying = 0

function current() {
  return { name: $('name').value.trim(), port: Number($('port').value) || 9777 }
}
function dirty() {
  const c = current()
  return c.name !== saved.name || c.port !== saved.port
}

async function refresh() {
  let s
  try {
    s = await chrome.runtime.sendMessage({ type: 'status' })
  } catch {
    document.body.classList.remove('on')
    $('state').textContent = '插件异常'
    $('off').hidden = true
    $('info').hidden = false
    $('info').textContent = '到扩展程序页面重新加载插件'
    return
  }
  document.body.classList.toggle('on', s.connected)
  const off = !s.connected && Date.now() >= retrying
  $('off').hidden = !off
  $('info').hidden = off
  if (s.connected) {
    $('state').textContent = '已连接'
    $('info').textContent = s.attached ? `正在控制 ${s.attached} 个标签` : `v${s.version}`
  } else if (!off) {
    $('state').textContent = '连接中…'
    $('info').textContent = ''
  } else {
    $('state').textContent = '未连接'
  }
}

$('retry').onclick = () => {
  retrying = Date.now() + 2000
  chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {})
  refresh()
}

chrome.storage.local.get({ port: 9777, name: '' }).then(s => {
  saved = { name: s.name, port: s.port }
  $('name').value = s.name
  $('port').value = s.port
})

$('form').oninput = () => ($('save').disabled = !dirty())
$('form').onsubmit = async e => {
  e.preventDefault()
  if (!dirty()) return
  saved = current()
  await chrome.storage.local.set(saved) // 后台监听到变化会自动重连
  $('save').disabled = true
  retrying = Date.now() + 2000
  refresh()
}

refresh()
setInterval(refresh, 1000)
