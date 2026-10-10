import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { TabSession } from './session.ts'
import { REPO_ROOT } from '../common/paths.ts'
import { BxError, sleep } from '../common/util.ts'
import { scroll } from './actions.ts'

const require = createRequire(import.meta.url)

let LIB_SRC: string | null = null
/** Readability + Turndown + 提取器，包在一个闭包里注入，不污染页面全局 */
function libSource() {
  if (LIB_SRC) return LIB_SRC
  const readability = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8')
  const turndown = fs.readFileSync(path.join(path.dirname(require.resolve('turndown/package.json')), 'lib/turndown.browser.umd.js'), 'utf8')
  const extract = fs.readFileSync(path.join(REPO_ROOT, 'src/inject/extract.js'), 'utf8')
  LIB_SRC = `(() => {
    const Readability = (() => { const module = { exports: {} }; ${readability}\n; return module.exports })();
    const TurndownService = (() => { const module = { exports: {} }; const exports = module.exports; ${turndown}\n; return module.exports })();
    ${extract}
    return { Readability, TurndownService, bxExtract };
  })()`
  return LIB_SRC
}

// ---------------- read ----------------
// 这里只做通用提取。按域名的专用读法（函数库里的 read 函数）在 CLI 进程里先试，见 src/sdk/index.ts

export interface ReadOpts {
  mode?: 'brief' | 'default' | 'full'
  section?: string
  offset?: number
  limit?: number
  budget?: number
  via?: string // readability / list / outline / generic
  links?: boolean
  scroll?: number
}

export async function read(s: TabSession, o: ReadOpts) {
  await s.ensure('Page')
  // 后台标签刚打开时可能还是空文档（body 为 null，或者客户端渲染还没出文字），先等一下，最多 6 秒
  for (let i = 0; i < 30; i++) {
    const ok = await s.evaluate(`!!document.body && document.readyState !== 'loading' && (document.body.innerText || '').trim().length > 50`, { timeout: 2000 }).catch(() => false)
    if (ok) break
    await sleep(200)
  }
  for (let i = 0; i < (o.scroll ?? 0); i++) {
    await scroll(s, { dir: 'down' })
    await sleep(500)
  }
  const via = ['readability', 'list', 'outline'].includes(o.via || '') ? o.via : undefined
  const res = await s.evaluate(
    `(async () => { const L = ${libSource()}; return await L.bxExtract(${JSON.stringify({
      mode: o.mode || 'default',
      section: o.section,
      offset: o.offset,
      limit: o.limit,
      budget: o.budget || 6000,
      via,
      links: o.links,
    })}, L) })()`,
  )
  if (res?.error) throw new BxError('READ_FAILED', res.error, res.sections ? `可用分段：${res.sections.map((x: any) => x.id).join(', ')}` : undefined)
  return res
}