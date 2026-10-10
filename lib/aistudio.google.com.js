/* 站点笔记（Google AI Studio）：
 * @login required 要登录 Google 账号
 * - 用法：粘贴 prompt → 点 Run → 等生成完 → 取回回复。全程后台标签，不切前台
 * - 页面只认 paste 事件：fill / type 输入的 YouTube 链接不会被识别成视频，所以走“设剪贴板 + 真实 Ctrl+V”
 * - 后台标签里 Ctrl+V 要先打开 Emulation.setFocusEmulationEnabled（bx 后台开的标签默认已经开了）
 * - 设剪贴板用的是 Windows 的 PowerShell Set-Clipboard（经 UTF-8 临时文件中转，避免中文乱码）
 * - 模型 id 直接拼在网址上（?model=），不用点选
 * - 回复在 Shadow DOM 里，用 deepText 穿透取文字；出现 thumb_up 标记或连续两轮文字不变就算生成完
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function setClipboard(text) {
  const f = join(tmpdir(), `bx-clip-${Date.now()}.txt`)
  writeFileSync(f, text, 'utf8')
  execFileSync('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value (Get-Content -LiteralPath '${f}' -Raw -Encoding UTF8); Remove-Item -LiteralPath '${f}'`])
}

/** 发送 prompt，等模型生成完，返回回复文本。prompt 可以含 YouTube 链接（会被识别成视频）；也可以用 file 从文件读
 *  @example ask('总结 https://www.youtube.com/watch?v=7WrYRuZiEvQ 这个视频')
 *  @example ask('', { file: 'prompt.txt', model: 'gemini-2.5-flash' }) */
export async function ask(prompt = '', { model = 'gemini-3.8-flash', file = '', timeout = 240, norun = false } = {}) {
  if (file) prompt = readFileSync(file, 'utf8')
  if (!prompt) throw new BxError('BAD_ARGS', '没有 prompt', '传 prompt 参数，或者用 --file 指定文件')
  const tab = await bx.open(`https://aistudio.google.com/prompts/new_chat?model=${model}`)
  try {
    await tab.waitFor({ selector: 'textarea', timeout: 30000 }).catch(() => {
      throw new BxError('NEED_LOGIN', '没等到输入框（可能没登录 Google）', `在浏览器里登录 aistudio.google.com 后重试`)
    })
    await tab.c('cdp.send', { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } })

    const box = "getByRole('textbox', { name: /Enter a prompt|Type something/i })"
    const hasUrl = /https?:\/\//.test(prompt)
    let pasted = false
    for (let i = 0; i < 5 && !pasted; i++) {
      setClipboard(prompt)
      await tab.click(box).catch(() => tab.click('textarea'))
      await bx.sleep(300)
      await tab.press('Control+V')
      await bx.sleep(2000)
      const st = await tab.eval(() => ({ value: document.querySelector('textarea')?.value || '', media: document.body.innerText.includes('Remove media') }))
      pasted = !!(st.value || (hasUrl && st.media))
    }
    if (!pasted) throw new BxError('CHANGED', '粘贴失败：页面忽略了 Ctrl+V', '重试一次通常可以；还不行就是页面改版了，要修这个函数')
    bx.log('>> 已粘贴 prompt')

    if (hasUrl) bx.log('>> 等待 URL 识别为媒体…')
    let runReady = false
    for (let i = 0; i < 30; i++) {
      const snap = (await tab.snapshot({ interactive: true, max: 150 })).text
      runReady = snap.split('\n').some(l => /button "Run/.test(l) && !/disabled/.test(l))
      if (runReady && (!hasUrl || /Remove media/.test(snap))) break
      await bx.sleep(1000)
    }
    if (norun) return { pasted: true, model, tab: tab.id, note: '已粘贴，未运行（norun）' }
    if (runReady) await tab.click("getByRole('button', { name: /^Run/ })")
    else {
      bx.log('!! Run 按钮一直不可用（URL 可能没识别出来），仍尝试 Ctrl+Enter 发送')
      await tab.press('Control+Return')
    }
    bx.log('>> 已发送，等待生成…')

    const deadline = Date.now() + timeout * 1000
    let text = ''
    let prev = ''
    let stable = 0
    while (Date.now() < deadline) {
      await bx.sleep(4000)
      const st = await tab.eval(lastTurnState)
      const raw = String(st?.text || '')
      if (/thumb_up|thumb_down/.test(raw)) {
        text = raw
        break
      }
      if (!st?.generating && raw.trim() && raw === prev) {
        if (++stable >= 2) {
          text = raw
          break
        }
      } else stable = 0
      prev = raw
    }
    if (!text.trim()) throw new BxError('TIMEOUT', `等待超时（${timeout}s）或没取到回复内容`)
    // 按行过滤界面残留：按钮图标名、代码块工具栏、行号、时间戳
    const chrome = /^(code|download|content_copy|expand_less|copy|check|edit|more_vert|thumb_up|thumb_down|python|javascript|java|c\+\+|c#|go|rust|json|yaml|html|css|sql|bash|shell|typescript|kotlin|swift|text|markdown|model)$/i
    const clean = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !chrome.test(l) && !/^\d{1,4}$/.test(l) && !/^\d{1,2}:\d{2}$/.test(l) && !/^\d+(\.\d+)?s$/.test(l))
      .join('\n')
      .trim()
    return { model, text: clean }
  } finally {
    if (!norun && !process.env.BX_KEEP_TABS) await tab.close().catch(() => {})
  }
}

/** 在页面里执行：最后一个对话轮次的可见文本 + 是否还在生成（内容在 Shadow DOM 里） */
function lastTurnState() {
  function deepText(root, out) {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) deepText(el.shadowRoot, out)
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) out.push(n.textContent.trim())
    }
  }
  const turns = document.querySelectorAll('ms-chat-turn')
  const last = turns[turns.length - 1]
  const generating = [...document.querySelectorAll('button')].some(b => (b.getAttribute('aria-label') || '').trim() === 'Stop' || (b.textContent || '').trim() === 'Stop')
  if (!last) return { text: '', generating }
  const out = []
  deepText(last, out)
  return { text: out.join('\n'), generating }
}
