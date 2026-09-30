// B 站视频页 reader：bx read 打开视频页时自动使用
// read() / section() 会被序列化后注入页面执行，只能用页面里有的东西，不能引用这个文件里的其它变量

export const meta = {
  name: 'bili-video',
  match: ['*://www.bilibili.com/video/*', '*://m.bilibili.com/video/*'],
  description: 'B 站视频页：标题、UP、数据、简介、标签、分P、相关推荐；评论按需展开',
  waitFor: '#viewbox_report, .video-info-container, h1',
}

export function read(args) {
  const s = window.__INITIAL_STATE__
  if (!s || !s.videoData) return { fallback: true }
  const v = s.videoData
  const t = sec => new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16)
  const d = x => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`
  const out = {
    title: v.title,
    type: 'video',
    meta: { author: v.owner.name, published: t(v.pubdate), site: '哔哩哔哩' },
    video: {
      bvid: v.bvid,
      duration: d(v.duration),
      up: `${v.owner.name} (mid ${v.owner.mid})`,
      stat: `播放 ${v.stat.view} · 点赞 ${v.stat.like} · 投币 ${v.stat.coin} · 收藏 ${v.stat.favorite} · 评论 ${v.stat.reply} · 弹幕 ${v.stat.danmaku}`,
      tags: (s.tags || []).map(x => x.tag_name).join(' / ') || undefined,
    },
    content: v.desc || '(无简介)',
    sections: [
      { id: 'comments', title: `评论（${v.stat.reply} 条，按热度）`, chars: '按需加载' },
      { id: 'related', title: `相关推荐（${(s.related || []).length} 个）` },
    ],
  }
  if (v.pages && v.pages.length > 1) out.items = v.pages.map(p => ({ title: `P${p.page} ${p.part}`, text: d(p.duration) }))
  return out
}

export async function section(id, args) {
  const s = window.__INITIAL_STATE__
  const v = s.videoData
  if (id === 'related') {
    const items = (s.related || []).map(r => `- ${r.title}（${r.owner.name} · 播放 ${r.stat.view}）https://www.bilibili.com/video/${r.bvid}`)
    return { title: v.title, section: id, content: items.join('\n'), range: [0, items.length], total: items.length }
  }
  if (id === 'comments') {
    const want = args.limit || 20
    const lines = []
    let offset = ''
    for (let i = 0; i < 10 && lines.length < want; i++) {
      const u = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${v.aid}&mode=3&pagination_str=${encodeURIComponent(JSON.stringify({ offset }))}`
      const j = await (await fetch(u, { credentials: 'include' })).json()
      if (j.code !== 0) throw new Error(`评论接口返回 ${j.code} ${j.message}`)
      for (const r of j.data.replies || []) {
        lines.push(`- **${r.member.uname}**（👍${r.like}${r.rcount ? ` · ${r.rcount} 回复` : ''}）：${r.content.message.replace(/\n+/g, ' ')}`)
        if (lines.length >= want) break
      }
      offset = j.data.cursor?.pagination_reply?.next_offset
      if (!offset || j.data.cursor?.is_end) break
    }
    return { title: v.title, section: id, content: lines.join('\n'), range: [0, lines.length], total: v.stat.reply, more: undefined }
  }
  throw new Error(`没有分段 ${id}（可用：comments, related）`)
}
