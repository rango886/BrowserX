// B 站站点脚本：bx bili <命令>
// 取数据的思路：优先在页面里直接调 B 站自己的接口（带着浏览器登录状态），签名在 Node 里算
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { wbiKey, signQuery } from './wbi.js'

const API = 'https://api.bilibili.com'
const stripTags = (s = '') => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const time = (sec) => (sec ? new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16) : undefined)
const dur = (s) => (typeof s === 'number' ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : s)

/** 接受 BV 号 / av 号 / 视频链接 */
function parseVideo(x) {
  const s = String(x)
  const bv = s.match(/BV[0-9A-Za-z]{10}/)
  if (bv) return { bvid: bv[0] }
  const av = s.match(/(?:^|av)(\d+)$/i)
  if (av) return { aid: Number(av[1]) }
  throw new Error(`认不出视频：${s}（需要 BV 号、av 号或视频链接）`)
}
function parseMid(x) {
  const m = String(x).match(/(\d{2,})/)
  if (!m) throw new Error(`认不出用户：${x}（需要 mid 或空间链接）`)
  return Number(m[1])
}

async function api(ctx, p, params = {}, { sign = false } = {}) {
  const tab = await ctx.tab()
  const qs = sign ? signQuery(params, await wbiKey(u => tab.fetch(u))) : new URLSearchParams(params).toString()
  const j = await tab.fetch(`${API}/${p}?${qs}`)
  if (j.code !== 0) {
    const hint = j.code === -101 ? '（需要登录：在浏览器里登录 B 站后重试）' : j.code === -352 || j.code === -412 || j.code === -799 ? '（被风控了，稍后再试或降低频率）' : ''
    throw new Error(`B 站接口 ${p} 返回 ${j.code} ${j.message || ''}${hint}`)
  }
  return j.data
}

async function videoView(ctx, v) {
  return api(ctx, 'x/web-interface/view', v)
}

// 排行榜分区 → [网址里的名字, rid]（用 bx 把每个分区点一遍、从网络记录里读出来的）
const RANK_RID = {
  全部: ['all', 0], 动画: ['douga', 1005], 游戏: ['game', 1008], 鬼畜: ['kichiku', 1007], 音乐: ['music', 1003], 舞蹈: ['dance', 1004],
  影视: ['cinephile', 1001], 娱乐: ['ent', 1002], 知识: ['knowledge', 1010], 科技数码: ['tech', 1012], 美食: ['food', 1020], 汽车: ['car', 1013],
  时尚美妆: ['fashion', 1014], 体育运动: ['sports', 1018], 动物: ['animal', 1024],
}
const PGC_RANK = ['番剧', '国创', '纪录片', '电影', '电视剧', '综艺', 'anime', 'guochuang', 'documentary', 'movie', 'tv', 'variety']

export default {
  name: 'bili',
  description: 'B 站：搜索、排行榜、视频信息、评论、下载、UP 主投稿和动态',
  home: 'https://www.bilibili.com',
  domains: ['bilibili.com'],
  commands: {
    // 根据 trace "rank" 的调查报告写的：数据在 x/web-interface/ranking/v2 的 data.list[]，带 wbi 签名，rid 是分区
    rank: {
      summary: '热门排行榜（可按分区）',
      args: [{ name: 'category', desc: `分区：${Object.keys(RANK_RID).join(' / ')}（也可以写网址里的英文，如 douga）`, optional: true }],
      opts: { limit: { type: 'number', default: 100, desc: '前多少名（最多 100）' } },
      examples: ['bx bili rank', 'bx bili rank 动画 --limit 10', 'bx bili rank 知识 | bx bili video comments - --limit 3'],
      async *run(ctx) {
        const name = ctx.args.category || '全部'
        const hit = Object.entries(RANK_RID).find(([k, v]) => k === name || v[0] === name)
        if (!hit) {
          if (PGC_RANK.includes(name)) throw new Error(`${name} 是番剧/影视类榜单，走的是 pgc 接口，还没支持`)
          throw new Error(`没有分区“${name}”，可选：${Object.keys(RANK_RID).join(' / ')}`)
        }
        const d = await api(ctx, 'x/web-interface/ranking/v2', { rid: hit[1][1], type: 'all', web_location: '333.934' }, { sign: true })
        let i = 0
        for (const v of d.list || []) {
          yield {
            rank: ++i,
            bvid: v.bvid,
            title: v.title,
            author: v.owner?.name,
            mid: v.owner?.mid,
            view: v.stat?.view,
            like: v.stat?.like,
            danmaku: v.stat?.danmaku,
            reply: v.stat?.reply,
            duration: dur(v.duration),
            pubdate: time(v.pubdate),
            url: `https://www.bilibili.com/video/${v.bvid}`,
          }
          if (i >= ctx.opts.limit) return
        }
      },
    },
    me: {
      summary: '当前浏览器登录的账号',
      async run(ctx) {
        const tab = await ctx.tab()
        const j = await tab.fetch(`${API}/x/web-interface/nav`)
        const d = j.data || {}
        return d.isLogin ? { login: true, mid: d.mid, name: d.uname, level: d.level_info?.current_level, vip: d.vipStatus === 1 } : { login: false, hint: '在浏览器里打开 bilibili.com 登录后重试' }
      },
    },

    search: {
      summary: '搜索视频（或用户）',
      args: [{ name: 'keyword', desc: '关键词', rest: true }],
      opts: {
        limit: { type: 'number', default: 20, desc: '最多返回多少条' },
        type: { type: 'string', default: 'video', choices: ['video', 'user'], desc: '搜什么' },
        order: { type: 'string', default: 'totalrank', choices: ['totalrank', 'click', 'pubdate', 'dm', 'stow'], desc: '排序：综合/播放/最新/弹幕/收藏' },
      },
      examples: ['bx bili search 最近有什么电影 --limit 10', 'bx bili search 电影解说 --order click -o csv > 结果.csv'],
      async *run(ctx) {
        const keyword = [].concat(ctx.args.keyword).join(' ')
        const type = ctx.opts.type === 'user' ? 'bili_user' : 'video'
        let n = 0
        for (let page = 1; n < ctx.opts.limit && page <= 50; page++) {
          const d = await api(ctx, 'x/web-interface/wbi/search/type', { search_type: type, keyword, page, order: ctx.opts.order }, { sign: true })
          const list = d.result || []
          if (!list.length) break
          for (const r of list) {
            if (type === 'video')
              yield { bvid: r.bvid, title: stripTags(r.title), author: r.author, mid: r.mid, play: r.play, danmaku: r.video_review, duration: r.duration, pubdate: time(r.pubdate), url: `https://www.bilibili.com/video/${r.bvid}` }
            else yield { mid: r.mid, name: r.uname, fans: r.fans, videos: r.videos, sign: r.usign, url: `https://space.bilibili.com/${r.mid}` }
            if (++n >= ctx.opts.limit) return
          }
          if (page >= (d.numPages || 1)) break
          await ctx.sleep(300)
        }
      },
    },

    'video info': {
      summary: '视频详细信息（播放、点赞、分P、简介…）',
      args: [{ name: 'video', desc: 'BV 号 / av 号 / 视频链接' }],
      key: ['bvid', 'url', 'aid'],
      async run(ctx) {
        const d = await videoView(ctx, parseVideo(ctx.args.video))
        return {
          bvid: d.bvid,
          aid: d.aid,
          title: d.title,
          owner: { mid: d.owner.mid, name: d.owner.name },
          pubdate: time(d.pubdate),
          duration: dur(d.duration),
          stat: { view: d.stat.view, like: d.stat.like, coin: d.stat.coin, favorite: d.stat.favorite, share: d.stat.share, reply: d.stat.reply, danmaku: d.stat.danmaku },
          tname: d.tname,
          desc: d.desc,
          pages: d.pages.map(p => ({ page: p.page, cid: p.cid, part: p.part, duration: dur(p.duration) })),
          url: `https://www.bilibili.com/video/${d.bvid}`,
        }
      },
    },

    'video comments': {
      summary: '视频评论',
      args: [{ name: 'video', desc: 'BV 号 / av 号 / 视频链接' }],
      key: ['bvid', 'url', 'aid'],
      opts: {
        limit: { type: 'number', default: 50, desc: '最多多少条' },
        sort: { type: 'string', default: 'hot', choices: ['hot', 'time'], desc: '热门 / 最新' },
      },
      examples: ['bx bili video comments BV1GJ411x7h7 --limit 20', 'bx bili search 电影 --limit 5 | bx bili video comments - --limit 3'],
      async *run(ctx) {
        const v = parseVideo(ctx.args.video)
        const aid = v.aid || (await videoView(ctx, v)).aid
        let offset = ''
        let n = 0
        for (let i = 0; i < 100 && n < ctx.opts.limit; i++) {
          const pagination_str = JSON.stringify({ offset })
          const d = await api(ctx, 'x/v2/reply/wbi/main', { oid: aid, type: 1, mode: ctx.opts.sort === 'time' ? 2 : 3, pagination_str, plat: 1 }, { sign: true })
          const list = [...(i === 0 ? d.top_replies || [] : []), ...(d.replies || [])]
          for (const r of list) {
            yield { bvid: v.bvid, rpid: r.rpid_str, user: r.member.uname, mid: Number(r.mid), message: r.content.message, like: r.like, replies: r.rcount, time: time(r.ctime) }
            if (++n >= ctx.opts.limit) return
          }
          offset = d.cursor?.pagination_reply?.next_offset
          if (!offset || d.cursor?.is_end || !list.length) break
          await ctx.sleep(300)
        }
      },
    },

    'video download': {
      summary: '下载视频（DASH 音视频分离，有 ffmpeg 时自动合并）',
      args: [{ name: 'video', desc: 'BV 号 / av 号 / 视频链接' }],
      key: ['bvid', 'url', 'aid'],
      opts: {
        out: { type: 'string', default: '.', desc: '保存目录' },
        quality: { type: 'string', default: '1080', choices: ['4k', '1080+', '1080', '720', '480', '360'], desc: '清晰度（超出账号权限时自动降级）' },
        page: { type: 'number', default: 1, desc: '第几 P' },
        'audio-only': { type: 'boolean', desc: '只下音频' },
      },
      async run(ctx) {
        const info = await videoView(ctx, parseVideo(ctx.args.video))
        const p = info.pages[ctx.opts.page - 1]
        if (!p) throw new Error(`没有第 ${ctx.opts.page} P（共 ${info.pages.length} P）`)
        const qn = { '4k': 120, '1080+': 112, '1080': 80, '720': 64, '480': 32, '360': 16 }[ctx.opts.quality]
        const d = await api(ctx, 'x/player/wbi/playurl', { bvid: info.bvid, cid: p.cid, qn, fnval: 4048, fourk: 1 }, { sign: true })
        if (!d.dash) throw new Error('没有拿到 DASH 地址（可能是付费 / 地区限制视频）')
        const video = d.dash.video.filter(x => x.id <= qn).sort((a, b) => b.id - a.id || b.bandwidth - a.bandwidth)[0] || d.dash.video[0]
        const audio = [...(d.dash.audio || []), ...(d.dash.flac?.audio ? [d.dash.flac.audio] : [])].sort((a, b) => b.bandwidth - a.bandwidth)[0]
        const cookies = await ctx.rpc.call('cookies.get', { tab: (await ctx.tab()).id, url: 'https://www.bilibili.com' })
        const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ')
        const safe = s => s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
        const dir = path.resolve(ctx.opts.out)
        fs.mkdirSync(dir, { recursive: true })
        const base = path.join(dir, safe(`${info.title}${info.pages.length > 1 ? ` P${p.page} ${p.part}` : ''} [${info.bvid}]`))

        const get = async (url, file, label) => {
          const res = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0', Cookie: cookie } })
          if (!res.ok) throw new Error(`下载失败 ${res.status}：${label}`)
          const total = Number(res.headers.get('content-length')) || 0
          const out = fs.createWriteStream(file)
          let got = 0, last = 0
          for await (const chunk of res.body) {
            out.write(chunk)
            got += chunk.length
            if (Date.now() - last > 500) {
              last = Date.now()
              process.stderr.write(`\r${label} ${(got / 1e6).toFixed(1)}MB${total ? ` / ${(total / 1e6).toFixed(1)}MB` : ''}   `)
            }
          }
          await new Promise(r => out.end(r))
          process.stderr.write(`\r${label} ${(got / 1e6).toFixed(1)}MB 完成            \n`)
          return got
        }

        const qdesc = d.accept_description?.[d.accept_quality?.indexOf(video.id)] || video.id
        if (ctx.opts['audio-only']) {
          const file = base + '.m4a'
          const size = await get(audio.baseUrl || audio.base_url, file, '音频')
          return { bvid: info.bvid, title: info.title, file, size }
        }
        const vf = base + '.video.m4s'
        const af = base + '.audio.m4s'
        await get(video.baseUrl || video.base_url, vf, `视频(${qdesc})`)
        if (audio) await get(audio.baseUrl || audio.base_url, af, '音频')
        const mp4 = base + '.mp4'
        const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vf, ...(audio ? ['-i', af] : []), '-c', 'copy', mp4], { stdio: ['ignore', 'ignore', 'pipe'] })
        if (ff.status === 0) {
          fs.rmSync(vf, { force: true })
          fs.rmSync(af, { force: true })
          return { bvid: info.bvid, title: info.title, quality: qdesc, file: mp4, size: fs.statSync(mp4).size }
        }
        return { bvid: info.bvid, title: info.title, quality: qdesc, files: [vf, af], note: '没找到 ffmpeg（或合并失败），音视频是分开的文件：ffmpeg -i 视频 -i 音频 -c copy out.mp4' }
      },
    },

    'user info': {
      summary: 'UP 主信息',
      args: [{ name: 'user', desc: 'mid 或空间链接' }],
      key: ['mid', 'owner.mid', 'url'],
      async run(ctx) {
        const mid = parseMid(ctx.args.user)
        const d = await api(ctx, 'x/web-interface/card', { mid })
        const c = d.card
        return { mid, name: c.name, sign: c.sign, level: c.level_info?.current_level, fans: d.follower, following: c.attention, videos: d.archive_count, likes: d.like_num, url: `https://space.bilibili.com/${mid}` }
      },
    },

    'user videos': {
      summary: 'UP 主的投稿视频列表',
      args: [{ name: 'user', desc: 'mid 或空间链接' }],
      key: ['mid', 'owner.mid', 'url'],
      opts: {
        limit: { type: 'number', default: 30 },
        order: { type: 'string', default: 'pubdate', choices: ['pubdate', 'click', 'stow'], desc: '最新 / 最多播放 / 最多收藏' },
      },
      async *run(ctx) {
        const mid = parseMid(ctx.args.user)
        let n = 0
        for (let pn = 1; n < ctx.opts.limit && pn <= 100; pn++) {
          const d = await api(ctx, 'x/space/wbi/arc/search', { mid, pn, ps: 30, order: ctx.opts.order, dm_img_list: '[]', dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ', dm_cover_img_str: 'QU5HTEUgKEludGVsKQ', dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}' }, { sign: true })
          const list = d.list?.vlist || []
          for (const v of list) {
            yield { bvid: v.bvid, title: v.title, play: v.play, comment: v.comment, length: v.length, created: time(v.created), url: `https://www.bilibili.com/video/${v.bvid}` }
            if (++n >= ctx.opts.limit) return
          }
          if (!list.length || pn * 30 >= (d.page?.count || 0)) break
          await ctx.sleep(400)
        }
      },
    },

    'user dynamics': {
      summary: 'UP 主动态',
      args: [{ name: 'user', desc: 'mid 或空间链接' }],
      key: ['mid', 'owner.mid', 'url'],
      opts: { limit: { type: 'number', default: 20 } },
      async *run(ctx) {
        const mid = parseMid(ctx.args.user)
        let offset = ''
        let n = 0
        for (let i = 0; i < 50 && n < ctx.opts.limit; i++) {
          const d = await api(ctx, 'x/polymer/web-dynamic/v1/feed/space', { host_mid: mid, offset, features: 'itemOpusStyle' }, { sign: true })
          for (const it of d.items || []) {
            const m = it.modules || {}
            const dyn = m.module_dynamic || {}
            const major = dyn.major || {}
            const text = dyn.desc?.text || major.opus?.summary?.text || ''
            const out = { id: it.id_str, type: it.type.replace('DYNAMIC_TYPE_', '').toLowerCase(), time: m.module_author?.pub_time, text: text.slice(0, 500) }
            if (major.archive) Object.assign(out, { bvid: major.archive.bvid, title: major.archive.title })
            if (major.opus?.title) out.title = major.opus.title
            out.url = `https://t.bilibili.com/${it.id_str}`
            yield out
            if (++n >= ctx.opts.limit) return
          }
          if (!d.has_more) break
          offset = d.offset
          await ctx.sleep(400)
        }
      },
    },
  },
}
