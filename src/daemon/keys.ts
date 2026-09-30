/** 按键定义：把 "Control+Shift+A" 这种写法翻译成 CDP Input.dispatchKeyEvent 参数 */
const SPECIAL: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Insert: { code: 'Insert', keyCode: 45 },
  Shift: { code: 'ShiftLeft', keyCode: 16 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Meta: { code: 'MetaLeft', keyCode: 91 },
}
for (let i = 1; i <= 12; i++) SPECIAL['F' + i] = { code: 'F' + i, keyCode: 111 + i }

const ALIAS: Record<string, string> = {
  ctrl: 'Control', control: 'Control', cmd: 'Meta', meta: 'Meta', win: 'Meta', alt: 'Alt', option: 'Alt',
  shift: 'Shift', esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab',
  space: 'Space', backspace: 'Backspace', del: 'Delete', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown',
  left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
}

const MOD_BIT: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

export interface KeyStroke {
  modifiers: number
  modifierKeys: string[]
  key: string
  code: string
  keyCode: number
  text?: string
}

export function parseCombo(combo: string): KeyStroke {
  const parts = combo.split('+').map(s => s.trim()).filter(Boolean)
  if (combo.endsWith('++')) parts.push('+')
  const norm = (p: string) => ALIAS[p.toLowerCase()] || p
  const keyName = norm(parts.pop()!)
  const modifierKeys = parts.map(norm)
  let modifiers = 0
  for (const m of modifierKeys) {
    if (!(m in MOD_BIT)) throw new Error(`未知修饰键 ${m}`)
    modifiers |= MOD_BIT[m]
  }
  const sp = SPECIAL[keyName]
  if (sp) return { modifiers, modifierKeys, key: keyName === 'Space' ? ' ' : keyName, code: sp.code, keyCode: sp.keyCode, text: modifiers & ~8 ? undefined : sp.text }
  if (keyName.length !== 1) throw new Error(`未知按键 ${keyName}（可用：Enter Tab Escape Backspace ArrowDown F5 或单个字符）`)
  const ch = keyName
  const upper = ch.toUpperCase()
  const isLetter = /[a-z]/i.test(ch)
  const isDigit = /[0-9]/.test(ch)
  const code = isLetter ? 'Key' + upper : isDigit ? 'Digit' + ch : ''
  const keyCode = isLetter || isDigit ? upper.charCodeAt(0) : 0
  // 有 Ctrl/Alt/Meta 时不产生文字输入
  const text = modifiers & ~8 ? undefined : modifiers & 8 && isLetter ? upper : ch
  return { modifiers, modifierKeys, key: text || ch, code, keyCode, text }
}
