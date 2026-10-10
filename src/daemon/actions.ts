import fs from 'node:fs'
import path from 'node:path'
import type { TabSession } from './session.ts'
import { parseCombo } from './keys.ts'
import { resolveTarget } from './locate.ts'
import { BxError, sleep, urlPattern, withTimeout } from '../common/util.ts'
import { BX_HOME, ensureDir } from '../common/paths.ts'

// ---------------- 定位 ----------------

async function center(s: TabSession, bid: number) {
  await s.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: bid }).catch(() => {})
  let quads: number[][]
  try {
    quads = (await s.send('DOM.getContentQuads', { backendNodeId: bid })).quads
  } catch {
    throw new BxError('STALE_REF', '元素已经不在页面上了', '重新执行 `bx snapshot`')
  }
  const q = quads.find(q => area(q) > 1)
  if (!q) throw new BxError('NOT_VISIBLE', '元素不可见（被隐藏或尺寸为 0）', '可能需要先展开菜单 / 滚动 / 关闭弹层，再 snapshot')
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
}

function area(q: number[]) {
  return Math.abs((q[2] - q[0]) * (q[7] - q[1]) - (q[3] - q[1]) * (q[6] - q[0]))
}

/** 点击点上真正的元素是不是目标（或目标的子孙 / 祖先，比如 label） */
async function hitCheck(s: TabSession, bid: number, x: number, y: number): Promise<string | null> {
  try {
    const hit = await s.send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true })
    if (hit.backendNodeId === bid) return null
    const hitObj = (await s.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId })).object.objectId
    const target = (await s.send('DOM.resolveNode', { backendNodeId: bid })).object.objectId
    // 命中的元素在目标内部（或是目标的 label）就算没被挡住；否则返回挡住它的元素描述
    const r = await s.send('Runtime.callFunctionOn', {
      objectId: target,
      functionDeclaration: `function(o){
        let x = o; while (x) { if (x === this) return null; x = x.parentNode || (x.getRootNode && x.getRootNode().host) }
        if (o.control === this || (this.contains && this.contains(o)) || (o.contains && o.contains(this))) return null;
        const e = o.nodeType === 1 ? o : o.parentElement; if (!e) return null;
        const lab = e.closest && e.closest('label'); if (lab && lab.control === this) return null;
        return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
          (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') }`,
      arguments: [{ objectId: hitObj }],
      returnByValue: true,
    })
    s.send('Runtime.releaseObject', { objectId: hitObj }).catch(() => {})
    s.send('Runtime.releaseObject', { objectId: target }).catch(() => {})
    return r.result.value ?? null
  } catch {
    return null
  }
}

// ---------------- 鼠标 ----------------

const MOD_BITS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 }
export function modBits(mods?: string | string[]) {
  let b = 0
  for (const m of ([] as string[]).concat(mods || []).flatMap(x => x.split(/[,+\s]+/)).filter(Boolean)) {
    const v = MOD_BITS[m.toLowerCase()]
    if (v === undefined) throw new BxError('BAD_ARGS', `未知修饰键 ${m}`, '可用：Shift Control Alt Meta')
    b |= v
  }
  return b
}

const BUTTON_BITS: Record<string, number> = { left: 1, right: 2, middle: 4 }

async function mouse(s: TabSession, type: string, x: number, y: number, extra: any = {}) {
  // 后台标签里，引起跳转的点击要好几秒才返回确认（没有渲染帧）；事件已经送达，不必一直等
  const p = s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra, modifiers: s.mods | (extra.modifiers || 0) })
  p.catch(() => {})
  s.mouse.x = x
  s.mouse.y = y
  if (type === 'mousePressed') s.kbdPrimed = true
  await Promise.race([p, sleep(1000)])
}

export interface ClickOpts {
  double?: boolean
  right?: boolean
  middle?: boolean
  modifiers?: string | string[]
  force?: boolean
}

export async function click(s: TabSession, target: string, opts: ClickOpts = {}) {
  await s.ensure('DOM')
  return clickNode(s, await resolveTarget(s, target), target, opts)
}

async function clickNode(s: TabSession, bid: number, label: string, opts: ClickOpts = {}) {
  const dbg = process.env.BX_DEBUG ? (m: string) => console.log(new Date().toISOString(), 'click', label, m) : () => {}
  let pt = await center(s, bid)
  dbg(`center ${pt.x},${pt.y}`)
  if (!opts.force) {
    let cover: string | null = null
    for (let i = 0; i < 10; i++) {
      cover = await hitCheck(s, bid, pt.x, pt.y)
      dbg(`hit ${i} ${cover}`)
      if (!cover) break
      await sleep(200)
      pt = await center(s, bid)
    }
    if (cover) throw new BxError('COVERED', `${label} 被别的元素挡住了：${cover}`, '先关掉弹层/遮罩（或 snapshot 看看是什么），确实要点就加 --force')
  }
  await clickAt(s, pt.x, pt.y, opts)
}

export async function clickAt(s: TabSession, x: number, y: number, opts: ClickOpts = {}) {
  const button = opts.right ? 'right' : opts.middle ? 'middle' : 'left'
  const modifiers = modBits(opts.modifiers)
  await mouse(s, 'mouseMoved', x, y, { button: 'none', modifiers })
  const n = opts.double ? 2 : 1
  for (let i = 1; i <= n; i++) {
    await mouse(s, 'mousePressed', x, y, { button, clickCount: i, buttons: BUTTON_BITS[button], modifiers })
    await mouse(s, 'mouseReleased', x, y, { button, clickCount: i, modifiers })
  }
}

export async function hover(s: TabSession, target: string) {
  await s.ensure('DOM')
  const pt = await center(s, await resolveTarget(s, target))
  await mouse(s, 'mouseMoved', pt.x, pt.y, { button: 'none' })
}

export async function drag(s: TabSession, from: string, to: string) {
  await s.ensure('DOM')
  const a = await center(s, await resolveTarget(s, from))
  const b = await center(s, await resolveTarget(s, to))
  await dragPoints(s, a, b, 10)
}

async function dragPoints(s: TabSession, a: { x: number; y: number }, b: { x: number; y: number }, steps: number) {
  await mouse(s, 'mouseMoved', a.x, a.y, { button: 'none' })
  await mouse(s, 'mousePressed', a.x, a.y, { clickCount: 1, buttons: 1 })
  for (let i = 1; i <= steps; i++) await mouse(s, 'mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, { buttons: 1 })
  await mouse(s, 'mouseReleased', b.x, b.y, { clickCount: 1 })
}

/** 按坐标操作：canvas、地图、滑块这类 snapshot 里看不到元素的页面 */
export async function mouseAction(
  s: TabSession,
  o: { action: string; x?: number; y?: number; x2?: number; y2?: number; dx?: number; dy?: number; steps?: number; right?: boolean; middle?: boolean; double?: boolean },
) {
  const num = (v: any, name: string) => {
    const n = Number(v)
    if (v === undefined || Number.isNaN(n)) throw new BxError('BAD_ARGS', `需要数字 ${name}`)
    return n
  }
  const button = o.right ? 'right' : o.middle ? 'middle' : 'left'
  switch (o.action) {
    case 'click':
      await clickAt(s, num(o.x, 'x'), num(o.y, 'y'), o)
      break
    case 'move':
      await mouse(s, 'mouseMoved', num(o.x, 'x'), num(o.y, 'y'), { button: s.mouse.buttons ? 'left' : 'none', buttons: s.mouse.buttons })
      break
    case 'down':
      s.mouse.buttons |= BUTTON_BITS[button]
      await mouse(s, 'mousePressed', o.x ?? s.mouse.x, o.y ?? s.mouse.y, { button, clickCount: 1, buttons: s.mouse.buttons })
      break
    case 'up':
      s.mouse.buttons &= ~BUTTON_BITS[button]
      await mouse(s, 'mouseReleased', o.x ?? s.mouse.x, o.y ?? s.mouse.y, { button, clickCount: 1, buttons: s.mouse.buttons })
      break
    case 'wheel': {
      let { x, y } = s.mouse
      if (!x && !y) {
        const m = await s.send('Page.getLayoutMetrics')
        x = m.cssLayoutViewport.clientWidth / 2
        y = m.cssLayoutViewport.clientHeight / 2
      }
      await mouse(s, 'mouseWheel', x, y, { button: 'none', deltaX: Number(o.dx || 0), deltaY: Number(o.dy || 0) })
      await sleep(300)
      break
    }
    case 'drag':
      await dragPoints(s, { x: num(o.x, 'x1'), y: num(o.y, 'y1') }, { x: num(o.x2, 'x2'), y: num(o.y2, 'y2') }, Math.max(1, o.steps ?? 15))
      break
    default:
      throw new BxError('BAD_ARGS', `未知鼠标动作 ${o.action}`, '可用：click move down up wheel drag')
  }
  return { x: s.mouse.x, y: s.mouse.y }
}

export async function scroll(s: TabSession, opts: { ref?: string; dir?: string; amount?: number }) {
  if (opts.ref) {
    await s.ensure('DOM')
    await s.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: await resolveTarget(s, opts.ref) })
  } else {
    const m = await s.send('Page.getLayoutMetrics')
    const vw = m.cssLayoutViewport.clientWidth
    const vh = m.cssLayoutViewport.clientHeight
    const amt = opts.amount ?? Math.round(vh * 0.8)
    const dir = opts.dir || 'down'
    const [dx, dy] = dir === 'up' ? [0, -amt] : dir === 'left' ? [-amt, 0] : dir === 'right' ? [amt, 0] : [0, amt]
    if (dir === 'top' || dir === 'bottom') await s.evaluate(`window.scrollTo(0, ${dir === 'top' ? 0 : 'document.documentElement.scrollHeight'})`)
    else await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vw / 2, y: vh / 2, deltaX: dx, deltaY: dy })
    await sleep(300)
  }
  return s.evaluate(`(() => { const d = document.scrollingElement || document.documentElement;
    return { scrollY: Math.round(scrollY), maxY: Math.max(0, d.scrollHeight - innerHeight), atBottom: scrollY + innerHeight >= d.scrollHeight - 4 } })()`)
}

// ---------------- 键盘 / 输入 ----------------

/**
 * 有的浏览器（Vivaldi 插件模式实测）里，标签没收到过真实的鼠标按下时，键盘输入会被丢掉；
 * 在输入框上点一下就好了（点输入框没有副作用）
 */
async function primeKeyboard(s: TabSession, bid?: number) {
  if (bid === undefined) bid = await activeEditable(s)
  if (bid === undefined) return false
  try {
    const pt = await center(s, bid)
    await mouse(s, 'mousePressed', pt.x, pt.y, { button: 'left', clickCount: 1, buttons: 1 })
    await mouse(s, 'mouseReleased', pt.x, pt.y, { button: 'left', clickCount: 1 })
    return true
  } catch {
    return false
  }
}

/** 当前焦点在输入框 / 可编辑区域上时，返回它的 backendNodeId */
async function activeEditable(s: TabSession): Promise<number | undefined> {
  try {
    const r = await s.send('Runtime.evaluate', {
      expression: `(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        return a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName)) ? a : null })()`,
      returnByValue: false,
    })
    if (!r.result?.objectId) return undefined
    const d = await s.send('DOM.describeNode', { objectId: r.result.objectId })
    s.send('Runtime.releaseObject', { objectId: r.result.objectId }).catch(() => {})
    return d.node.backendNodeId
  } catch {
    return undefined
  }
}

export async function press(s: TabSession, combo: string) {
  if (!s.kbdPrimed) {
    await s.ensure('DOM')
    if (await primeKeyboard(s)) s.kbdPrimed = true
  }
  const k = parseCombo(combo)
  const MOD: Record<string, { code: string; keyCode: number; bit: number }> = {
    Alt: { code: 'AltLeft', keyCode: 18, bit: 1 }, Control: { code: 'ControlLeft', keyCode: 17, bit: 2 },
    Meta: { code: 'MetaLeft', keyCode: 91, bit: 4 }, Shift: { code: 'ShiftLeft', keyCode: 16, bit: 8 },
  }
  let mods = s.mods
  for (const m of k.modifierKeys) {
    mods |= MOD[m].bit
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: m, code: MOD[m].code, windowsVirtualKeyCode: MOD[m].keyCode, modifiers: mods })
  }
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: k.modifiers | s.mods }
  await s.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, text: k.text, unmodifiedText: k.text })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  for (const m of [...k.modifierKeys].reverse()) {
    mods &= ~MOD[m].bit
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: m, code: MOD[m].code, windowsVirtualKeyCode: MOD[m].keyCode, modifiers: mods | s.mods })
  }
}

/** 按住 / 松开一个键（按住 Shift 再点几下 = 多选）。按住的修饰键会带到之后的点击和按键里 */
export async function keyAction(s: TabSession, action: 'down' | 'up', combo: string) {
  const k = parseCombo(combo)
  if (k.modifierKeys.length) throw new BxError('BAD_ARGS', 'key down / up 一次只按一个键', '例：bx key down Shift')
  const bit = ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 } as Record<string, number>)[k.key] || 0
  if (action === 'down') s.mods |= bit
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: s.mods }
  if (action === 'down') await s.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, text: k.text })
  else {
    s.mods &= ~bit
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base, modifiers: s.mods })
  }
  const held = Object.entries({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }).filter(([, b]) => s.mods & b).map(([n]) => n)
  return { held }
}

const FOCUS_FN = `function(clear){
  this.scrollIntoView({block:'center', inline:'nearest'});
  this.focus();
  const tag = this.tagName;
  const info = { tag, type: this.type || '', editable: this.isContentEditable || 'value' in this };
  if (tag === 'SELECT') return info;
  if (clear) {
    if ('value' in this) { try { this.select() } catch (e) {} }
    else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r) }
  } else if ('value' in this) {
    try { const n = this.value.length; this.setSelectionRange(n, n) } catch (e) {}
  } else if (this.isContentEditable) {
    const r = document.createRange(); r.selectNodeContents(this); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r)
  }
  return info
}`

const VALUE_FN = `function(){ return 'value' in this ? this.value : this.innerText }`

const SET_VALUE_FN = `function(v){
  const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(this, v);
  this.dispatchEvent(new Event('input', {bubbles:true}));
  this.dispatchEvent(new Event('change', {bubbles:true}));
}`

/** 填写：清空后输入（会触发真实的 input 事件，React / Vue 都认） */
export async function fill(s: TabSession, target: string, text: string, opts: { append?: boolean; submit?: boolean } = {}) {
  await s.ensure('DOM')
  const bid = await resolveTarget(s, target)
  const info = await s.callOn(bid, FOCUS_FN, [!opts.append])
  if (info.tag === 'SELECT') return selectNode(s, bid, target, [text])
  if (!info.editable) throw new BxError('NOT_EDITABLE', `${target} 不是输入框（是 <${info.tag.toLowerCase()}>）`, '用 snapshot 找 textbox / searchbox / combobox')
  const before = opts.append ? await s.callOn(bid, VALUE_FN) : ''
  const input = async () => {
    if (text === '') await press(s, 'Delete')
    else await s.send('Input.insertText', { text })
    return s.callOn(bid, VALUE_FN)
  }
  let value = await input()
  const landed = (v: any) => typeof v !== 'string' || text === '' || (opts.append ? v.length > String(before).length : v.includes(text))
  // 键盘输入没生效：先在输入框上点一下，再重新输入一次
  if (!landed(value) && (await primeKeyboard(s, bid))) {
    s.kbdPrimed = true
    await s.callOn(bid, FOCUS_FN, [!opts.append])
    value = await input()
  }
  // 日期、颜色等特殊输入框，键盘输入不生效时直接设值
  if (!opts.append && value !== text && ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(info.type)) {
    await s.callOn(bid, SET_VALUE_FN, [text])
    value = await s.callOn(bid, VALUE_FN)
  }
  if (opts.submit) await press(s, 'Enter')
  return { value: typeof value === 'string' ? value.slice(0, 300) : value }
}

/** 往当前焦点处输入文字（和 fill 一样：没生效就在焦点输入框上点一下再输一次） */
export async function typeText(s: TabSession, text: string) {
  await s.ensure('DOM')
  const bid = await activeEditable(s)
  const before = bid !== undefined ? await s.callOn(bid, VALUE_FN).catch(() => undefined) : undefined
  await s.send('Input.insertText', { text })
  if (bid === undefined || typeof before !== 'string') return
  const after = await s.callOn(bid, VALUE_FN).catch(() => undefined)
  if (after === before && (await primeKeyboard(s, bid))) {
    s.kbdPrimed = true
    await s.callOn(bid, FOCUS_FN, [false])
    await s.send('Input.insertText', { text })
  }
}

export async function selectOption(s: TabSession, target: string, values: string[]) {
  await s.ensure('DOM')
  return selectNode(s, await resolveTarget(s, target), target, values)
}

async function selectNode(s: TabSession, bid: number, ref: string, values: string[]) {
  const r = await s.callOn(
    bid,
    `function(vals){
      if (this.tagName !== 'SELECT') return { error: 'not-select', tag: this.tagName };
      const opts = [...this.options]; const picked = [];
      for (const o of opts) o.selected = false;
      for (const v of vals) {
        const o = opts.find(o => o.value === v) || opts.find(o => o.label.trim() === v) || opts.find(o => o.label.includes(v));
        if (!o) return { error: 'no-option', value: v, options: opts.map(o => o.label.trim()).slice(0, 30) };
        o.selected = true; picked.push(o.label.trim());
        if (!this.multiple) break;
      }
      this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true}));
      return { selected: picked };
    }`,
    [values],
  )
  if (r.error === 'not-select') throw new BxError('NOT_SELECT', `${ref} 不是 <select>（是 <${r.tag.toLowerCase()}>）`, '自定义下拉框：先 click 打开，再 snapshot 找选项 click')
  if (r.error === 'no-option') throw new BxError('NO_OPTION', `没有选项 "${r.value}"`, `可选：${r.options.join(' | ')}`)
  return r
}

export async function check(s: TabSession, target: string, want: boolean) {
  await s.ensure('DOM')
  const bid = await resolveTarget(s, target)
  const state = () => s.callOn(bid, `function(){ return this.checked ?? (this.getAttribute('aria-checked') === 'true') }`)
  if ((await state()) !== want) await clickNode(s, bid, target)
  return { checked: await state() }
}

/** 一次填多个字段：文本框填字，勾选框 / 单选填 true/false，下拉框填选项。每个填完读回实际的值 */
export async function fillMany(s: TabSession, fields: { target: string; value: any }[]) {
  await s.ensure('DOM')
  const out: any[] = []
  for (const f of fields) {
    const bid = await resolveTarget(s, f.target)
    const kind = await s.callOn(bid, `function(){
      if (this.tagName === 'SELECT') return 'select';
      const t = (this.type || '').toLowerCase(), role = this.getAttribute('role');
      if (t === 'checkbox' || t === 'radio' || role === 'checkbox' || role === 'switch' || role === 'radio') return 'check';
      return 'text' }`)
    if (kind === 'check') {
      const want = typeof f.value === 'boolean' ? f.value : /^(1|true|yes|y|on|是|✓|√)$/i.test(String(f.value).trim())
      out.push({ target: f.target, ...(await check(s, f.target, want)) })
    } else if (kind === 'select') out.push({ target: f.target, ...(await selectNode(s, bid, f.target, [String(f.value)])) })
    else out.push({ target: f.target, ...(await fill(s, f.target, String(f.value))) })
  }
  return { fields: out }
}

export async function upload(s: TabSession, target: string, files: string[]) {
  await s.ensure('DOM')
  const abs = files.map(f => path.resolve(f))
  for (const f of abs) if (!fs.existsSync(f)) throw new BxError('NO_FILE', `文件不存在：${f}`)
  const bid = await resolveTarget(s, target)
  const isInput = await s.callOn(bid, `function(){ return this.tagName === 'INPUT' && this.type === 'file' }`)
  if (isInput) {
    await s.send('DOM.setFileInputFiles', { files: abs, backendNodeId: bid })
    return { files: abs }
  }
  // 是个“点了会弹选文件窗口”的按钮：截住选文件窗口，把文件交给它
  await s.ensure('Page')
  await s.send('Page.setInterceptFileChooserDialog', { enabled: true })
  try {
    const opened = s.waitEvent('Page.fileChooserOpened', 6000)
    opened.catch(() => {})
    await clickNode(s, bid, target)
    const ev = await opened.catch(() => {
      throw new BxError('NO_FILE_CHOOSER', `点了 ${target} 没有弹出选文件窗口`, '找页面上的 <input type=file>（可能是隐藏的）：bx upload "input[type=file]" 文件')
    })
    if (!ev.backendNodeId) throw new BxError('UNSUPPORTED', '这个选文件窗口不是 <input type=file> 弹出来的（File System Access API），没法代选文件')
    if (ev.mode === 'selectSingle' && abs.length > 1) throw new BxError('BAD_ARGS', '这个文件框只能选一个文件')
    await s.send('DOM.setFileInputFiles', { files: abs, backendNodeId: ev.backendNodeId })
    return { files: abs, via: 'file-chooser' }
  } finally {
    await s.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
  }
}

// ---------------- 导航 ----------------

export async function goto(s: TabSession, url: string) {
  await s.ensure('Page')
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url
  const r = await s.send('Page.navigate', { url })
  if (r.errorText) throw new BxError('NAV_FAILED', `打开 ${url} 失败：${r.errorText}`)
  await s.settle(15000)
}

export async function history(s: TabSession, delta: number) {
  await s.ensure('Page')
  const h = await s.send('Page.getNavigationHistory')
  const e = h.entries[h.currentIndex + delta]
  if (!e) throw new BxError('NO_HISTORY', delta < 0 ? '已经是第一页，没法后退' : '没有可以前进的页面')
  await s.send('Page.navigateToHistoryEntry', { entryId: e.id })
  await s.settle()
}

export async function reload(s: TabSession) {
  await s.ensure('Page')
  await s.send('Page.reload', {})
  await s.settle(15000)
}

// ---------------- 等待 ----------------

export async function waitFor(
  s: TabSession,
  o: { text?: string; gone?: string; selector?: string; url?: string; fn?: string; timeout?: number; idle?: boolean },
) {
  const timeout = o.timeout ?? 15000
  const end = Date.now() + timeout
  const conds: string[] = []
  if (o.text) conds.push(`document.body && document.body.innerText.includes(${JSON.stringify(o.text)})`)
  if (o.gone) conds.push(`!(document.body && document.body.innerText.includes(${JSON.stringify(o.gone)}))`)
  if (o.selector) conds.push(`!!document.querySelector(${JSON.stringify(o.selector)})`)
  if (o.url) {
    const re = urlPattern(o.url)
    conds.push(re ? `new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)}).test(location.href)` : `location.href.includes(${JSON.stringify(o.url)})`)
  }
  if (o.fn) conds.push(`!!(await (async () => (${o.fn}))())`)
  if (o.idle || conds.length === 0) {
    await s.ensure('Network')
    await s.settle(timeout)
    if (conds.length === 0) return { ok: true }
  }
  const expr = `(async () => ${conds.join(' && ')})()`
  while (Date.now() < end) {
    if (await s.evaluate(expr).catch(() => false)) return { ok: true, waited: timeout - (end - Date.now()) }
    await sleep(200)
  }
  throw new BxError('TIMEOUT', `等待条件超时 (${timeout}ms)：${JSON.stringify(o)}`, '用 `bx read` 或 `bx shot` 看看页面现在是什么样')
}

// ---------------- 截图 ----------------

export async function screenshot(
  s: TabSession,
  o: { ref?: string; full?: boolean; out?: string; marks?: boolean; format?: 'png' | 'jpeg'; quality?: number },
  activate: () => Promise<void>,
) {
  await s.ensure('Page')
  const format = o.format || (o.out?.endsWith('.jpg') || o.out?.endsWith('.jpeg') ? 'jpeg' : 'png')
  const params: any = { format, captureBeyondViewport: !!o.full }
  if (format === 'jpeg') params.quality = o.quality ?? 80
  if (o.ref) {
    await s.ensure('DOM')
    const bid = await resolveTarget(s, o.ref)
    await s.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: bid }).catch(() => {})
    const { model } = await s.send('DOM.getBoxModel', { backendNodeId: bid })
    const b = model.border
    const xs = [b[0], b[2], b[4], b[6]], ys = [b[1], b[3], b[5], b[7]]
    const sc = await s.evaluate('({x: scrollX, y: scrollY})')
    params.clip = { x: Math.min(...xs) + sc.x, y: Math.min(...ys) + sc.y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), scale: 1 }
    params.captureBeyondViewport = true
  } else if (o.full) {
    const m = await s.send('Page.getLayoutMetrics')
    const cs = m.cssContentSize || m.contentSize
    params.clip = { x: 0, y: 0, width: cs.width, height: Math.min(cs.height, 16000), scale: 1 }
  }
  let removeMarks = async () => {}
  if (o.marks) removeMarks = await drawMarks(s)
  let data: string
  try {
    data = (await withTimeout(s.send('Page.captureScreenshot', params), 3000, '截图')).data
  } catch {
    // 后台标签可能不渲染：切到前台再试
    await activate()
    await sleep(300)
    data = (await withTimeout(s.send('Page.captureScreenshot', params), 15000, '截图')).data
  } finally {
    await removeMarks()
  }
  const file = o.out ? path.resolve(o.out) : path.join(ensureDir(path.join(BX_HOME, 'shots')), `${s.shortId}-${Date.now()}.${format === 'jpeg' ? 'jpg' : 'png'}`)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  return { file, bytes: Math.round((data.length * 3) / 4) }
}

/** 在截图上画出 ref 编号（set-of-marks），方便多模态模型"看图说编号" */
async function drawMarks(s: TabSession) {
  await s.ensure('DOM')
  const boxes: { ref: string; x: number; y: number; w: number; h: number }[] = []
  await Promise.all(
    [...s.refs.entries()].slice(0, 400).map(async ([ref, bid]) => {
      try {
        const { quads } = await s.send('DOM.getContentQuads', { backendNodeId: bid })
        const q = quads[0]
        if (!q) return
        const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
        const x = Math.min(...xs), y = Math.min(...ys)
        boxes.push({ ref, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y })
      } catch {}
    }),
  )
  await s.evaluate(`(() => {
    const boxes = ${JSON.stringify(boxes)};
    const root = document.createElement('div'); root.id = '__bx_marks__';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    for (const b of boxes) {
      if (b.y > innerHeight || b.y + b.h < 0 || b.w < 2) continue;
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;border:1.5px solid #e0245e;left:'+b.x+'px;top:'+b.y+'px;width:'+b.w+'px;height:'+b.h+'px';
      const t = document.createElement('span'); t.textContent = b.ref;
      t.style.cssText = 'position:absolute;left:-1px;top:-14px;background:#e0245e;color:#fff;font:bold 10px/13px monospace;padding:0 2px';
      d.appendChild(t); root.appendChild(d);
    }
    document.documentElement.appendChild(root);
  })()`)
  return async () => {
    await s.evaluate(`document.getElementById('__bx_marks__')?.remove()`).catch(() => {})
  }
}
