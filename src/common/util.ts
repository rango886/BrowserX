/** 给 AI 看的错误：message 说清楚发生了什么，hint 说下一步怎么做 */
export class BxError extends Error {
  code: string
  hint?: string
  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.code = code
    this.hint = hint
  }
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new BxError('TIMEOUT', `${what} 超时 (${ms}ms)`)), ms)
    }),
  ])
}

/** URL 通配：* 匹配任意字符，支持 *://*.bilibili.com/video/* 这种写法 */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp('^' + esc + '$', 'i')
}

/**
 * 把“网址匹配”写法转成正则；返回 null 表示按子串匹配。三种写法：
 *   /issues\/\d+/i   斜杠包起来 → 正则（可带 flags）
 *   *github.com/*   带 * → 通配（整串匹配，不区分大小写）
 *   /issues/        其他 → 子串
 */
export function urlPattern(pattern: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern)
  if (m && /[\\^$.*+?()[\]{}|]/.test(m[1])) {
    try {
      return new RegExp(m[1], m[2])
    } catch (e: any) {
      throw new BxError('BAD_ARGS', `正则写错了：${pattern}（${e.message}）`, '正则写成 /.../flags；只想按子串匹配就不要用斜杠包起来')
    }
  }
  if (pattern.includes('*')) return globToRegExp(pattern)
  return null
}

/** RegExp 对象转成 urlPattern 认得的字符串（SDK 里传 RegExp 时用，RPC 只能传字符串） */
export function patternString(p: string | RegExp): string {
  return p instanceof RegExp ? `/${p.source}/${p.flags}` : p
}

export function urlMatches(url: string, pattern: string): boolean {
  const re = urlPattern(pattern)
  if (re) return re.test(url)
  // 没有通配符时：当作子串 / 域名匹配
  try {
    const host = new URL(url).hostname
    if (host === pattern || host.endsWith('.' + pattern)) return true
  } catch {}
  return url.includes(pattern)
}
