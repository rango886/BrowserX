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

export function urlMatches(url: string, pattern: string): boolean {
  if (pattern.includes('*')) return globToRegExp(pattern).test(url)
  // 没有通配符时：当作子串 / 域名匹配
  try {
    const host = new URL(url).hostname
    if (host === pattern || host.endsWith('.' + pattern)) return true
  } catch {}
  return url.includes(pattern)
}
