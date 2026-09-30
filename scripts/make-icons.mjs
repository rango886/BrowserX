// 生成插件图标：node scripts/make-icons.mjs [--preview out.png]
// 深色圆角方块 + 白色鼠标指针（"帮你操作浏览器"），四周留透明边。纯 node 实现，不需要依赖。
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons')
const SIZES = [16, 32, 48, 128]

const TILE = [0x1c, 0x1c, 0x1e]
const FG = [0xff, 0xff, 0xff]

// 各尺寸四周的透明边（像素）。小尺寸像素金贵，边留少一点
const MARGIN = { 16: 1, 32: 2, 48: 4, 128: 12 }

// 鼠标指针，坐标系：0..1，尖端在左上。斜边用 45°，抗锯齿更干净
const ARROW = [
  [0, 0],
  [0, 0.8],
  [0.2, 0.62],
  [0.33, 0.92],
  [0.46, 0.86],
  [0.33, 0.58],
  [0.58, 0.58],
]
const AW = 0.58, AH = 0.92
// 指针在方块里的大小：小尺寸相对大一点才看得清
const SCALE = { 32: 0.6, 48: 0.56, 128: 0.52 }
// 按视觉重心居中：指针上宽下窄、左重右轻，整体略往右挪一点
const NUDGE_X = 0.03

// 16px 单独手画像素（矢量缩到这么小会发虚）。# = 指针，坐标是整个 16x16 画布
const PIXEL16 = [
  '................',
  '................',
  '................',
  '................',
  '......#.........',
  '......##........',
  '......###.......',
  '......####......',
  '......#####.....',
  '......###.......',
  '.......##.......',
  '........##......',
  '................',
  '................',
  '................',
  '................',
]

// ---------- 最小 PNG 编码 ----------
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
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 形状 ----------
function inPoly(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r)
  return Math.hypot(x - cx, y - cy) <= r
}
function arrowFor(size) {
  const k = SCALE[size] ?? 0.52
  const ox = 0.5 - (AW * k) / 2 + NUDGE_X, oy = 0.5 - (AH * k) / 2
  return ARROW.map(([x, y]) => [ox + x * k, oy + y * k])
}

// 方块内坐标 0..1 的颜色，null = 透明
function sample(x, y, arrow) {
  if (!inRoundRect(x, y, 0.24)) return null
  return arrow && inPoly(x, y, arrow) ? FG : TILE
}

function render(size) {
  const m = MARGIN[size] ?? Math.round(size * 0.09)
  const inner = size - 2 * m
  const arrow = size === 16 ? null : arrowFor(size)
  const ss = 8 // 超采样抗锯齿
  const buf = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, n = 0
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px - m + (sx + 0.5) / ss) / inner, (py - m + (sy + 0.5) / ss) / inner, arrow)
          if (c) (r += c[0]), (g += c[1]), (b += c[2]), n++
        }
      const o = (py * size + px) * 4
      if (size === 16 && PIXEL16[py][px] === '#') (r = FG[0] * n), (g = FG[1] * n), (b = FG[2] * n)
      if (n) (buf[o] = r / n), (buf[o + 1] = g / n), (buf[o + 2] = b / n), (buf[o + 3] = (255 * n) / (ss * ss))
    }
  return buf
}

const previewAt = process.argv.indexOf('--preview')
if (previewAt > 0) {
  // 预览：每个尺寸最近邻放大到 128，横排，浅底 + 深底各一行
  const cell = 128, gap = 16, W = SIZES.length * (cell + gap) + gap, H = 2 * (cell + gap) + gap
  const out = Buffer.alloc(W * H * 4)
  for (let row = 0; row < 2; row++) {
    const bg = row ? [0x2b, 0x2b, 0x2b] : [0xf1, 0xf1, 0xf1]
    for (let y = row * (cell + gap); y < (row + 1) * (cell + gap) + (row ? gap : 0); y++)
      for (let x = 0; x < W; x++) out.set([...bg, 255], (y * W + x) * 4)
    SIZES.forEach((s, i) => {
      const img = render(s), k = cell / s
      for (let y = 0; y < cell; y++)
        for (let x = 0; x < cell; x++) {
          const si = ((Math.floor(y / k) * s + Math.floor(x / k)) * 4), a = img[si + 3] / 255
          const o = ((gap + row * (cell + gap) + y) * W + gap + i * (cell + gap) + x) * 4
          for (let c = 0; c < 3; c++) out[o + c] = img[si + c] * a + bg[c] * (1 - a)
        }
    })
  }
  fs.writeFileSync(process.argv[previewAt + 1], png(W, H, out))
  console.log('preview', process.argv[previewAt + 1])
} else {
  fs.mkdirSync(OUT, { recursive: true })
  for (const s of SIZES) fs.writeFileSync(path.join(OUT, `${s}.png`), png(s, s, render(s)))
  console.log('icons written to', OUT)
}
