// aistudio 站点脚本：在 Google AI Studio 里跑 prompt（粘贴式输入，YouTube 链接自动识别成视频）
// 全程后台标签完成，不切前台。用法：
//   bx aistudio ask "总结https://www.youtube.com/watch?v=xxxx视频"
//   bx aistudio ask -f prompt.txt -m gemini-2.5-flash
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 设置 Windows 剪贴板（经 UTF-8 临时文件中转，避免中文乱码） */
function setClipboard(text) {
  const f = join(tmpdir(), `bx-clip-${Date.now()}.txt`)
  writeFileSync(f, text, 'utf8')
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Set-Clipboard -Value (Get-Content -LiteralPath '${f}' -Raw -Encoding UTF8); Remove-Item -LiteralPath '${f}'`])
}

export default {
  name: 'aistudio',
  description: 'Google AI Studio：粘贴 prompt 并取回模型回复（YouTube 链接自动识别，全程后台）',
  home: 'https://aistudio.google.com/prompts/new_chat',
  domains: ['aistudio.google.com'],
  commands: {
    ask: {
      summary: '发送 prompt，等模型生成完，返回回复文本',
      args: [{ name: 'prompt', optional: true, desc: '提示词，可含 YouTube 链接' }],
      key: 'prompt',
      opts: {
        model: { type: 'string', default: 'gemini-3.8-flash', desc: '模型 id（拼在 URL 上，不用点击选择）' },
        file: { type: 'string', desc: '从文件读 prompt' },
        timeout: { type: 'number', default: 240, desc: '等待生成的超时秒数' },
        norun: { type: 'boolean', desc: '只粘贴不运行（调试用）' },
      },
      examples: [
        'bx aistudio ask "总结https://www.youtube.com/watch?v=7WrYRuZiEvQ视频"',
        'bx aistudio ask -f prompt.txt -m gemini-2.5-flash',
        'cat prompt.txt | bx aistudio ask -',
      ],
      async run(ctx) {
        let prompt = ctx.args.prompt
        if (ctx.opts.file) prompt = readFileSync(ctx.opts.file, 'utf8')
        if (!prompt) throw new Error('提供 prompt 位置参数，或用 --file 指定文件')
        const model = ctx.opts.model

        // 1. URL 拼模型参数直接进对应模型，全程后台标签
        const tab = await ctx.open(`https://aistudio.google.com/prompts/new_chat?model=${model}`)
        await tab.waitFor({ selector: 'textarea', timeout: 30000 })

        // 2. 焦点模拟：让后台标签的渲染进程认为自己有焦点，
        //    这样 CDP 粘贴命令（Ctrl+V 的原生 paste 处理）才能在后台执行
        await ctx.rpc.call('cdp.send', {
          tab: tab.id,
          method: 'Emulation.setFocusEmulationEnabled',
          params: { enabled: true },
        })

        // 3. 找输入框 ref
        const getRef = async () => {
          const snap = await tab.snapshot({ interactive: true, max: 150 })
          const line = String(snap.text ?? snap).split('\n')
            .find(l => /textbox "Enter a prompt/.test(l))
          return line?.match(/\[ref=(e\d+)/)?.[1] ?? null
        }

        // 4. 粘贴：设剪贴板 → 真实点击 → 真实 Ctrl+V。
        //    页面只认 paste 事件（fill/type 输入的 URL 不会被识别成视频）。
        //    成功标志：输入框有字，或 URL 已被转成媒体（输入框里 URL 被剥走）
        const ref = await getRef()
        if (!ref) throw new Error('没找到 prompt 输入框（页面结构可能变了）')
        const hasUrl = /https?:\/\//.test(prompt)
        let pasted = false
        for (let i = 0; i < 5; i++) {
          setClipboard(prompt)
          await tab.click(ref)
          await ctx.sleep(300)
          await tab.press('Control+V')
          await ctx.sleep(2000)
          const st = await tab.eval(pasteState)
          if (st.value || (hasUrl && st.media)) { pasted = true; break }
        }
        if (!pasted) throw new Error('粘贴失败：页面忽略了 Ctrl+V，重试一次通常可解决')
        ctx.log('>> 已粘贴 prompt')

        // 5. 带 URL 时等链接被识别成媒体，Run 可用后再点
        if (hasUrl) ctx.log('>> 等待 URL 识别为媒体…')
        let runRef = null
        for (let i = 0; i < 30; i++) {
          const snap = await tab.snapshot({ interactive: true, max: 150 })
          const s = String(snap.text ?? snap)
          runRef = s.split('\n')
            .find(l => /button "Run/.test(l) && !/disabled/.test(l))
            ?.match(/\[ref=(e\d+)/)?.[1] ?? null
          const hasMedia = /Remove media/.test(s)
          if (runRef && (!hasUrl || hasMedia)) break
          await ctx.sleep(1000)
        }
        if (ctx.opts.norun) return { pasted: true, model, note: '已粘贴，未运行（--norun）' }
        if (!runRef) ctx.log('!! Run 按钮一直不可用（URL 可能没识别出来），仍尝试 Ctrl+Enter 发送')

        // 6. 运行
        if (runRef) await tab.click(runRef)
        else await tab.press('Control+Return')
        ctx.log('>> 已发送，等待生成…')

        // 7. 轮询回复（穿透 Shadow DOM 取文本）：
        //    出现点赞/点踩标记，或文本非空且连续两轮（约 8s）不变，即认为生成完成
        const deadline = Date.now() + ctx.opts.timeout * 1000
        let text = '', prev = '', stable = 0
        while (Date.now() < deadline) {
          await ctx.sleep(4000)
          const st = await tab.eval(lastTurnState)
          const raw = String(st?.text || '')
          if (/thumb_up|thumb_down/.test(raw)) { text = raw; break }
          if (!st?.generating && raw.trim() && raw === prev) { if (++stable >= 2) { text = raw; break } }
          else stable = 0
          prev = raw
        }
        if (!text.trim()) throw new Error(`等待超时（${ctx.opts.timeout}s）或未取到回复内容`)
        // 按行过滤界面残留：按钮标记、代码块工具栏（语言名/复制/展开）、行号、模型名+时间戳
        const chrome = /^(code|download|content_copy|expand_less|copy|check|edit|more_vert|thumb_up|thumb_down|python|javascript|java|c\+\+|c#|go|rust|json|yaml|html|css|sql|bash|shell|typescript|kotlin|swift|text|markdown|model)$/i
        const clean = text.split('\n')
          .map(l => l.trim())
          .filter(l => l && !chrome.test(l) && !/^\d{1,4}$/.test(l) && !/^\d{1,2}:\d{2}$/.test(l) && !/^\d+(\.\d+)?s$/.test(l))
          .join('\n')
          .trim()
        return { model, text: clean }
      },
    },
  },
}

// ---- 以下函数会被序列化到页面里执行，不能引用外部变量 ----

/** 输入框状态：value = 文本内容，media = 是否已出现媒体条目 */
function pasteState() {
  const ta = document.querySelector('textarea')
  return {
    value: ta ? ta.value : '',
    media: document.body.innerText.includes('Remove media'),
  }
}

/** 取最后一个对话轮次的可见文本 + 是否还在生成（AI Studio 的内容在 Shadow DOM 里） */
function lastTurnState() {
  function deepText(root, out) {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) deepText(el.shadowRoot, out)
      for (const n of el.childNodes)
        if (n.nodeType === 3 && n.textContent.trim()) out.push(n.textContent.trim())
    }
  }
  const turns = document.querySelectorAll('ms-chat-turn')
  const last = turns[turns.length - 1]
  const generating = [...document.querySelectorAll('button')]
    .some(b => (b.getAttribute('aria-label') || '').trim() === 'Stop' || (b.textContent || '').trim() === 'Stop')
  if (!last) return { text: '', generating }
  const out = []
  deepText(last, out)
  return { text: out.join('\n'), generating }
}
