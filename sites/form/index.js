// 通用表单填写：bx form fields <url> / bx form fill <url> --file 表格.csv
// 思路：AI 先用 fields 看表单有哪些字段，写一份 mapping（CSV 列 → 字段）；之后 fill 按行确定性地执行
import fs from 'node:fs'
import YAML from 'yaml'

/** 简单的 CSV 解析（支持引号、逗号、换行） */
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '')
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const [head, ...body] = rows.filter(r => r.some(x => x.trim()))
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])))
}

/** 在页面里列出表单字段 */
function listFields() {
  const labelOf = el => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (l) return l.innerText.trim()
    }
    const wrap = el.closest('label')
    if (wrap) return wrap.innerText.replace(el.innerText || '', '').trim()
    return el.getAttribute('aria-label') || el.placeholder || ''
  }
  const out = []
  for (const el of document.querySelectorAll('input, textarea, select, [contenteditable="true"]')) {
    const type = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.isContentEditable ? 'richtext' : el.type || 'text'
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue
    if (!el.checkVisibility?.() && type !== 'file') continue
    const sel = el.id ? `#${CSS.escape(el.id)}` : el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : null
    const f = { label: labelOf(el).split('\n')[0].slice(0, 60), name: el.name || undefined, type, selector: sel || undefined, required: el.required || undefined }
    if (type === 'select') f.options = [...el.options].map(o => o.label.trim()).filter(Boolean).slice(0, 30)
    if (type === 'radio' || type === 'checkbox') f.value = el.value
    out.push(f)
  }
  return out
}

/** 在页面里按 mapping 填一行数据 */
function fillRow(row, map) {
  const norm = s => String(s || '').replace(/[\s:：*]/g, '').toLowerCase()
  const fields = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')].filter(el => !['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type))
  const labelOf = el => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (l) return l.innerText
    }
    const wrap = el.closest('label')
    return wrap ? wrap.innerText : el.getAttribute('aria-label') || el.placeholder || ''
  }
  const find = key => {
    try {
      if (/^[#.\[]|^\w+\[/.test(key)) {
        const els = [...document.querySelectorAll(key)]
        if (els.length) return els
      }
    } catch {}
    const k = norm(key)
    let hit = fields.filter(el => norm(el.name) === k || norm(el.id) === k)
    if (!hit.length) hit = fields.filter(el => norm(labelOf(el)) === k)
    if (!hit.length) hit = fields.filter(el => k && norm(labelOf(el)).includes(k))
    return hit
  }
  const setVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const truthy = v => /^(1|true|yes|y|是|对|✓|√|on)$/i.test(String(v).trim())
  const filled = {}, missing = [], problems = []
  for (const [col, value] of Object.entries(row)) {
    const target = map[col] ?? col
    if (target === null || target === false || target === '-') continue
    const els = find(target)
    if (!els.length) { missing.push(col); continue }
    const el = els[0]
    el.focus?.()
    if (el.type === 'checkbox') {
      const want = els.length > 1 ? null : truthy(value)
      if (want === null) for (const c of els) { const on = String(value).split(/[;,，、|]/).map(s => s.trim()).includes(c.value) || String(value).includes(labelOf(c).trim()); if (c.checked !== on) c.click() }
      else if (el.checked !== want) el.click()
    } else if (el.type === 'radio') {
      const r = els.find(r => r.value === value || labelOf(r).trim() === value) || document.querySelector(`input[type=radio][name="${el.name}"][value="${CSS.escape(value)}"]`)
      if (r) r.click(); else problems.push(`${col}: 没有选项 ${value}`)
    } else if (el.tagName === 'SELECT') {
      const o = [...el.options].find(o => o.value === value || o.label.trim() === value) || [...el.options].find(o => value && o.label.includes(value))
      if (o) setVal(el, o.value); else problems.push(`${col}: 下拉框没有 ${value}`)
    } else if (el.type === 'file') {
      problems.push(`${col}: 文件字段需要用 upload，已跳过`)
      continue
    } else if (el.isContentEditable) {
      el.innerText = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } else setVal(el, value)
    filled[col] = target
  }
  return { filled, missing, problems }
}

function submitForm(text) {
  const btns = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
  const b = text ? btns.find(b => (b.innerText || b.value || '').trim() === text) || btns.find(b => (b.innerText || b.value || '').includes(text)) : document.querySelector('form [type=submit], form button:not([type=button])')
  if (!b) return false
  b.click()
  return true
}

export default {
  name: 'form',
  description: '通用表单：列字段、按 CSV 批量填写',
  commands: {
    fields: {
      summary: '列出页面上的表单字段（用来写 mapping）',
      args: [{ name: 'url', desc: '表单页面地址' }],
      async run(ctx) {
        const tab = await ctx.open(ctx.args.url)
        return tab.eval(listFields)
      },
    },
    fill: {
      summary: '按 CSV 每一行填写表单（可选自动提交），每行输出一条结果',
      args: [{ name: 'url', desc: '表单页面地址' }],
      opts: {
        file: { type: 'string', desc: 'CSV 文件（第一行是列名）' },
        map: { type: 'string', desc: 'mapping.yaml：CSV 列名 → 字段（label / name / CSS 选择器），不写就按列名自动匹配' },
        submit: { type: 'string', desc: '填完点哪个按钮（按钮文字）；不给就只填不提交' },
        'dry-run': { type: 'boolean', desc: '只检查字段能不能对上，不填写' },
        from: { type: 'number', default: 1, desc: '从第几行开始（失败后续跑用）' },
        wait: { type: 'number', default: 1000, desc: '提交后等待毫秒数' },
        capture: { type: 'string', desc: '提交后抓取这个 CSS 选择器的文字（比如成功提示）' },
      },
      examples: ['bx form fields https://example.com/apply', 'bx form fill https://example.com/apply --file 表格.csv --map mapping.yaml --submit 提交'],
      async *run(ctx) {
        if (!ctx.opts.file) throw new Error('需要 --file 表格.csv')
        const rows = parseCsv(fs.readFileSync(ctx.opts.file, 'utf8'))
        const map = ctx.opts.map ? YAML.parse(fs.readFileSync(ctx.opts.map, 'utf8')) || {} : {}
        const tab = await ctx.open(ctx.args.url)
        for (let i = ctx.opts.from - 1; i < rows.length; i++) {
          const row = rows[i]
          const rec = { row: i + 1 }
          try {
            if (i > ctx.opts.from - 1) await tab.goto(ctx.args.url)
            if (ctx.opts['dry-run']) {
              const fields = await tab.eval(listFields)
              const r = await tab.eval((row, map, fields) => {
                const norm = s => String(s || '').replace(/[\s:：*]/g, '').toLowerCase()
                const miss = []
                for (const col of Object.keys(row)) {
                  const t = norm(map[col] ?? col)
                  if (map[col] === null || map[col] === '-') continue
                  const ok = fields.some(f => norm(f.name) === t || norm(f.label) === t || norm(f.label).includes(t) || f.selector === (map[col] ?? col))
                  if (!ok) miss.push(col)
                }
                return miss
              }, row, map, fields)
              yield { ...rec, ok: r.length === 0, missing: r.length ? r : undefined }
              continue
            }
            const r = await tab.eval(fillRow, row, map)
            Object.assign(rec, { ok: !r.missing.length && !r.problems.length, filled: Object.keys(r.filled).length })
            if (r.missing.length) rec.missing = r.missing
            if (r.problems.length) rec.problems = r.problems
            if (ctx.opts.submit !== undefined) {
              const ok = await tab.eval(submitForm, ctx.opts.submit)
              if (!ok) throw new Error(`找不到按钮 "${ctx.opts.submit}"`)
              await ctx.sleep(ctx.opts.wait)
              rec.url = await tab.url()
              if (ctx.opts.capture) rec.result = await tab.eval(s => document.querySelector(s)?.innerText?.trim() ?? null, ctx.opts.capture)
            }
          } catch (e) {
            rec.ok = false
            rec.error = e.message
          }
          yield rec
        }
      },
    },
  },
}
