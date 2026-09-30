// B 站 wbi 签名：在 Node 里算，请求在页面里发（带登录状态）
import crypto from 'node:crypto'

const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

let cache = null

export async function wbiKey(fetchJson) {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.key
  const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav')
  const name = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
  const raw = name(nav.data.wbi_img.img_url) + name(nav.data.wbi_img.sub_url)
  const key = MIXIN.map(i => raw[i]).join('').slice(0, 32)
  cache = { key, at: Date.now() }
  return key
}

export function signQuery(params, key) {
  const p = { ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), wts: String(Math.round(Date.now() / 1000)) }
  const q = Object.keys(p)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(p[k].replace(/[!'()*]/g, ''))}`)
    .join('&')
  return q + '&w_rid=' + crypto.createHash('md5').update(q + key).digest('hex')
}
