// 生成插件图标：node scripts/make-icons.mjs
// 黑色圆角方块 + 深灰标签栏 + 白色 X，和设置页的 logo 一致。纯 node 实现，不需要依赖。
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons')
fs.mkdirSync(dir, { recursive: true })

const BG = [0x16, 0x16, 0x16] // 主体：近黑
const BAR = [0x3a, 0x3a, 0x3a] // 标签栏：深灰
const DOT = [0x9a, 0x9a, 0x9a] // 标签栏上的圆点：中灰

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 点到线段的距离
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

// 在 0..1 的坐标系里采样一个点，返回 [r,g,b,a]
function sample(x, y, small) {
  const r = 0.22 // 圆角半径
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r)
  if (Math.hypot(x - cx, y - cy) > r) return null
  // 顶部是浏览器的标签栏（白色半透明的条 + 大图标上有三个小圆点），下面是页面区域里的 X
  // 这样看起来是"浏览器窗口"而不是"关闭按钮"
  const bar = small ? 0.3 : 0.28
  if (y < bar) {
    if (!small) for (const dx of [0.2, 0.31, 0.42]) if (Math.hypot(x - dx, y - 0.155) < 0.042) return DOT
    return BAR
  }
  const cyX = (bar + 1) / 2, h = small ? 0.22 : 0.2, w = small ? 0.085 : 0.06
  const onX = segDist(x, y, 0.5 - h, cyX - h, 0.5 + h, cyX + h) < w || segDist(x, y, 0.5 + h, cyX - h, 0.5 - h, cyX + h) < w
  if (onX) return [255, 255, 255]
  return BG
}

for (const size of [16, 32, 48, 128]) {
  const ss = 4 // 每个像素 4x4 超采样抗锯齿
  const buf = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, n = 0
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, size <= 32)
          if (c) (r += c[0]), (g += c[1]), (b += c[2]), n++
        }
      const o = (py * size + px) * 4
      if (n) (buf[o] = r / n), (buf[o + 1] = g / n), (buf[o + 2] = b / n), (buf[o + 3] = (255 * n) / (ss * ss))
    }
  fs.writeFileSync(path.join(dir, `${size}.png`), png(size, buf))
}
console.log('icons written to', dir)
