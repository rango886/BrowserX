const $ = id => document.getElementById(id)

chrome.storage.local.get({ port: 9777, name: '' }).then(s => {
  $('name').value = s.name
  $('port').value = s.port
})

chrome.action.getBadgeText({}).then(t => {
  $('status').textContent = t === 'on' ? '✅ 已连接到 daemon' : '⏳ 未连接（daemon 没启动？执行 bx daemon start）'
})

$('save').onclick = async () => {
  await chrome.storage.local.set({ name: $('name').value.trim(), port: Number($('port').value) || 9777 })
  $('status').textContent = '已保存，正在重连…'
}
