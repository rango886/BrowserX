export interface TabInfo {
  /** 驱动内部的原生 id（扩展模式是 chrome tabId，CDP 模式是 targetId） */
  nativeId: string
  windowId?: number
  active?: boolean
  groupId?: number
  title: string
  url: string
}

export interface GroupInfo {
  id: number
  title: string
  color: string
  collapsed: boolean
  windowId: number
}

export type CdpEventHandler = (nativeTabId: string, method: string, params: any) => void

/**
 * 驱动接口：两种连接方式（插件 / 直连 CDP）对上层暴露同一套能力。
 * 页面级能力全部走 send()（CDP 命令），浏览器级能力（标签、标签组）走专门的方法。
 */
export interface Driver {
  name: string
  kind: 'extension' | 'cdp'
  info: Record<string, any>
  listTabs(): Promise<TabInfo[]>
  openTab(url: string, opts: { background?: boolean; windowId?: number }): Promise<TabInfo>
  closeTab(nativeId: string): Promise<void>
  activateTab(nativeId: string): Promise<void>
  /** 标签组：CDP 模式不支持，返回 undefined */
  groups?: {
    list(): Promise<GroupInfo[]>
    create(nativeTabIds: string[], opts: { title?: string; color?: string }): Promise<GroupInfo>
    update(groupId: number, opts: { title?: string; color?: string; collapsed?: boolean }): Promise<GroupInfo>
    ungroup(nativeTabIds: string[]): Promise<void>
  }
  /** 对某个标签发 CDP 命令，需要时自动 attach */
  send(nativeTabId: string, method: string, params?: any): Promise<any>
  detach(nativeTabId: string): Promise<void>
  onCdpEvent(h: CdpEventHandler): void
  /** 标签被关 / 调试被断开等 */
  onTabGone(h: (nativeTabId: string, reason: string) => void): void
  /** 标签被换成了另一个原生 id（Chrome 预渲染激活时的 tabs.onReplaced） */
  onTabReplaced?(h: (oldNativeId: string, newNativeId: string) => void): void
  onClose(h: () => void): void
  close(): Promise<void>
}
