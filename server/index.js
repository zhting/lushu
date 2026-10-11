import express from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getDb, saveDb } from './db.js'
import { aiAdminInfo, aiPublicInfo, allowAiCall, normalizeBaseUrl, parseTrip } from './ai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

const app = express()
const jsonParser = express.json({ limit: '5mb' })
// AI 生成接口带截图，单独用更大的上限（见下方路由）
app.use((req, res, next) => (req.path === '/api/ai/parse' ? next() : jsonParser(req, res, next)))

const db = getDb()

// ───────────────────────── 工具 ─────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/

function fail(res, status, message) {
  return res.status(status).json({ error: message })
}

/** 会话鉴权：Authorization: Bearer <token> */
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const session = token && db.sessions[token]
  if (!session) return fail(res, 401, '未登录或登录已过期')
  req.user = session.username
  req.token = token
  next()
}

function requireAdmin(req, res, next) {
  const user = db.users.find((u) => u.username === req.user)
  if (!user?.isAdmin) return fail(res, 403, '需要管理员权限')
  next()
}

function publicUser(u) {
  return { username: u.username, isAdmin: u.isAdmin, createdAt: u.createdAt }
}

function publicConfig() {
  const c = db.config
  return {
    amapKey: c.amapKey || '',
    amapSecurityJsCode: c.amapSecurityJsCode || '',
    hasAmapKey: !!c.amapKey,
    defaultProvider: c.defaultProvider === 'amap' && c.amapKey ? 'amap' : 'osm',
    ...aiPublicInfo(c), // 只告诉前端「有没有 AI、能不能识图」，不下发 Key
  }
}

// ───────────────────────── 认证 ─────────────────────────
app.post('/api/register', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  if (!USERNAME_RE.test(username)) return fail(res, 400, '用户名需 2-20 位（中文、字母、数字、下划线）')
  if (password.length < 4) return fail(res, 400, '密码至少 4 位')
  if (db.users.some((u) => u.username === username)) return fail(res, 409, '用户名已存在')

  // 第一个注册的用户自动成为管理员
  const isAdmin = db.users.length === 0
  const user = { username, passHash: bcrypt.hashSync(password, 10), isAdmin, createdAt: Date.now() }
  db.users.push(user)

  const token = crypto.randomBytes(24).toString('hex')
  db.sessions[token] = { username, createdAt: Date.now() }
  saveDb()
  res.json({ token, user: publicUser(user) })
})

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const user = db.users.find((u) => u.username === username)
  if (!user || !bcrypt.compareSync(password, user.passHash)) return fail(res, 401, '用户名或密码错误')

  const token = crypto.randomBytes(24).toString('hex')
  db.sessions[token] = { username, createdAt: Date.now() }
  // 会话最多保留 200 个（最旧的先淘汰）
  const tokens = Object.keys(db.sessions)
  if (tokens.length > 200) {
    tokens.sort((a, b) => db.sessions[a].createdAt - db.sessions[b].createdAt)
    for (const t of tokens.slice(0, tokens.length - 200)) delete db.sessions[t]
  }
  saveDb()
  res.json({ token, user: publicUser(user) })
})

app.post('/api/logout', auth, (req, res) => {
  delete db.sessions[req.token]
  saveDb()
  res.json({ ok: true })
})

app.get('/api/me', auth, (req, res) => {
  const user = db.users.find((u) => u.username === req.user)
  res.json({ user: publicUser(user) })
})

// ───────────────────────── 地图配置（登录用户可读，管理员可改） ─────────────────────────
app.get('/api/config', auth, (req, res) => {
  res.json(publicConfig())
})

app.put('/api/admin/config', auth, requireAdmin, (req, res) => {
  const { amapKey, amapSecurityJsCode, defaultProvider } = req.body || {}
  if (amapKey !== undefined) db.config.amapKey = String(amapKey).trim()
  if (amapSecurityJsCode !== undefined) db.config.amapSecurityJsCode = String(amapSecurityJsCode).trim()
  if (defaultProvider !== undefined) {
    if (!['osm', 'amap'].includes(defaultProvider)) return fail(res, 400, 'defaultProvider 仅支持 osm / amap')
    db.config.defaultProvider = defaultProvider
  }
  saveDb()
  res.json(publicConfig())
})

// ───────────────────────── AI 生成路书 ─────────────────────────
app.get('/api/admin/ai', auth, requireAdmin, (req, res) => {
  res.json(aiAdminInfo(db.config))
})

app.put('/api/admin/ai', auth, requireAdmin, (req, res) => {
  const { baseUrl, model, vision, apiKey, clearKey } = req.body || {}
  try {
    if (baseUrl !== undefined) db.config.aiBaseUrl = normalizeBaseUrl(baseUrl)
  } catch (e) {
    return fail(res, 400, e.message)
  }
  if (model !== undefined) db.config.aiModel = String(model).trim().slice(0, 100)
  if (vision !== undefined) db.config.aiVision = !!vision
  if (clearKey) db.config.aiApiKey = ''
  else if (typeof apiKey === 'string' && apiKey.trim()) db.config.aiApiKey = apiKey.trim() // 留空表示不修改
  saveDb()
  res.json(aiAdminInfo(db.config))
})

app.post('/api/ai/parse', auth, express.json({ limit: '12mb' }), async (req, res) => {
  const c = db.config
  if (!aiPublicInfo(c).hasAi) return fail(res, 400, '管理员还没有配置 AI 服务')
  if (!allowAiCall(req.user)) return fail(res, 429, 'AI 生成每小时最多 20 次，请稍后再试')
  try {
    const plan = await parseTrip(
      { aiBaseUrl: c.aiBaseUrl, aiApiKey: c.aiApiKey, aiModel: c.aiModel, aiVision: c.aiVision },
      req.body || {},
    )
    res.json(plan)
  } catch (e) {
    fail(res, 400, e?.message || 'AI 生成失败')
  }
})

app.get('/api/admin/users', auth, requireAdmin, (req, res) => {
  res.json({ users: db.users.map(publicUser) })
})

// ───────────────────────── 路书（按用户隔离） ─────────────────────────
function userTrips(username) {
  if (!db.trips[username]) db.trips[username] = []
  return db.trips[username]
}

function validTripPayload(body) {
  const { id, savedAt, trip } = body || {}
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    typeof savedAt === 'number' &&
    trip && typeof trip.title === 'string' && Array.isArray(trip.days)
  )
}

app.get('/api/trips', auth, (req, res) => {
  res.json({ trips: userTrips(req.user) })
})

app.put('/api/trips/:id', auth, (req, res) => {
  if (!validTripPayload(req.body)) return fail(res, 400, '路书数据格式不正确')
  if (req.params.id !== req.body.id) return fail(res, 400, 'id 不一致')
  const list = userTrips(req.user)
  const entry = { id: req.body.id, savedAt: req.body.savedAt, trip: req.body.trip }
  const i = list.findIndex((e) => e.id === entry.id)
  if (i >= 0) list.splice(i, 1, entry)
  else list.unshift(entry)
  saveDb()
  res.json({ ok: true })
})

app.delete('/api/trips/:id', auth, (req, res) => {
  const list = userTrips(req.user)
  const i = list.findIndex((e) => e.id === req.params.id)
  if (i >= 0) {
    list.splice(i, 1)
    revokeShares(req.user, req.params.id) // 路书删了，分享链接一并失效
    saveDb()
  }
  res.json({ ok: true })
})

// ───────────────────────── 视频分享链接 ─────────────────────────
// 分享页只提供作者录制好的巡游视频：公开接口不返回路书内容、地点、地图配置或用户名。
// 每本路书最多一个链接；重新上传视频时沿用原链接、替换文件。链接里只有随机 token。
const VIDEO_DIR = path.join(__dirname, 'data', 'videos')
const VIDEO_MAX_BYTES = 300 * 1024 * 1024 // 300MB：约 4~5 分钟 1080p 巡游视频
const VIDEO_MAX_PER_USER = 30
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' }

function shareTokenOf(username, tripId) {
  return Object.keys(db.shares).find((t) => db.shares[t].username === username && db.shares[t].tripId === tripId) || null
}

function removeVideoFile(file) {
  if (!file) return
  // 只删 VIDEO_DIR 下的文件名，防止路径穿越
  const p = path.join(VIDEO_DIR, path.basename(file))
  fs.rm(p, { force: true }, () => {})
}

function revokeShares(username, tripId) {
  for (const t of Object.keys(db.shares)) {
    if (db.shares[t].username === username && db.shares[t].tripId === tripId) {
      removeVideoFile(db.shares[t].file)
      delete db.shares[t]
    }
  }
}

/** 按文件头判断真实格式，不信任请求声明的类型 */
function sniffVideo(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm'
  return null
}

function shareInfo(token) {
  const sh = token && db.shares[token]
  if (!sh?.file) return { token: null }
  return { token, size: sh.size, mime: sh.mime, createdAt: sh.createdAt }
}

app.get('/api/trips/:id/share', auth, (req, res) => {
  res.json(shareInfo(shareTokenOf(req.user, req.params.id)))
})

// 分片上传：反向代理（如 Nginx 默认 client_max_body_size 1m）会拒收大请求，
// 视频按小于 1MB 的分片依次上传，服务端追加到临时文件，最后校验格式并登记分享。
const CHUNK_MAX_BYTES = 1000 * 1024
const uploads = new Map() // uploadId -> { username, tripId, tmp, size, next, at }

function dropUpload(id) {
  const u = uploads.get(id)
  if (u) fs.rm(u.tmp, { force: true }, () => {})
  uploads.delete(id)
}

// 清理 1 小时内没有完成的上传
setInterval(() => {
  const now = Date.now()
  for (const [id, u] of uploads) if (now - u.at > 3600_000) dropUpload(id)
}, 10 * 60_000).unref()

app.post('/api/trips/:id/share/upload', auth, (req, res) => {
  if (!userTrips(req.user).some((e) => e.id === req.params.id)) return fail(res, 404, '路书不存在')
  if (!shareTokenOf(req.user, req.params.id)) {
    const count = Object.values(db.shares).filter((sh) => sh.username === req.user).length
    if (count >= VIDEO_MAX_PER_USER) return fail(res, 400, `最多同时分享 ${VIDEO_MAX_PER_USER} 个视频，请先关闭不用的链接`)
  }
  // 同一用户同时只保留一个进行中的上传
  for (const [id, u] of uploads) if (u.username === req.user) dropUpload(id)
  fs.mkdirSync(VIDEO_DIR, { recursive: true })
  const uploadId = crypto.randomBytes(12).toString('hex')
  uploads.set(uploadId, { username: req.user, tripId: req.params.id, tmp: path.join(VIDEO_DIR, `${uploadId}.part`), size: 0, next: 0, at: Date.now() })
  res.json({ uploadId, chunkSize: 768 * 1024 })
})

app.put(
  '/api/trips/:id/share/upload/:uploadId/:index',
  auth,
  express.raw({ type: 'application/octet-stream', limit: CHUNK_MAX_BYTES }),
  (req, res) => {
    const u = uploads.get(req.params.uploadId)
    if (!u || u.username !== req.user || u.tripId !== req.params.id) return fail(res, 404, '上传已失效，请重新上传')
    const index = Number(req.params.index)
    const buf = req.body
    if (!Buffer.isBuffer(buf) || !buf.length) return fail(res, 400, '分片为空')
    if (index === u.next - 1) return res.json({ ok: true, size: u.size }) // 重试已收到的分片
    if (index !== u.next) return fail(res, 409, '分片顺序不对，请重新上传')
    if (u.size + buf.length > VIDEO_MAX_BYTES) {
      dropUpload(req.params.uploadId)
      return fail(res, 413, '视频超过 300MB，请缩短后再分享')
    }
    try {
      fs.appendFileSync(u.tmp, buf)
    } catch {
      dropUpload(req.params.uploadId)
      return fail(res, 500, '视频保存失败，请稍后重试')
    }
    u.size += buf.length
    u.next++
    u.at = Date.now()
    res.json({ ok: true, size: u.size })
  },
)

app.post('/api/trips/:id/share/upload/:uploadId/finish', auth, (req, res) => {
  const u = uploads.get(req.params.uploadId)
  if (!u || u.username !== req.user || u.tripId !== req.params.id) return fail(res, 404, '上传已失效，请重新上传')
  if (Number(req.body?.size) !== u.size) {
    dropUpload(req.params.uploadId)
    return fail(res, 400, '视频没有完整上传，请重试')
  }
  let head
  try {
    const fd = fs.openSync(u.tmp, 'r')
    head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    fs.closeSync(fd)
  } catch {
    dropUpload(req.params.uploadId)
    return fail(res, 400, '没有收到视频，请重新录制')
  }
  const mime = sniffVideo(head)
  if (!mime) {
    dropUpload(req.params.uploadId)
    return fail(res, 400, '只支持 MP4 或 WebM 视频')
  }
  let token = shareTokenOf(req.user, u.tripId)
  if (!token) token = crypto.randomBytes(16).toString('base64url')
  const file = `${crypto.randomBytes(16).toString('hex')}.${VIDEO_TYPES[mime]}`
  try {
    fs.renameSync(u.tmp, path.join(VIDEO_DIR, file))
  } catch {
    dropUpload(req.params.uploadId)
    return fail(res, 500, '视频保存失败，请稍后重试')
  }
  uploads.delete(req.params.uploadId)
  const old = db.shares[token]?.file
  db.shares[token] = { username: req.user, tripId: u.tripId, file, mime, size: u.size, createdAt: Date.now() }
  if (old && old !== file) removeVideoFile(old)
  saveDb()
  res.json(shareInfo(token))
})

app.delete('/api/trips/:id/share', auth, (req, res) => {
  revokeShares(req.user, req.params.id)
  saveDb()
  res.json({ ok: true })
})

// 公开接口（无需登录）：只返回视频本身的信息
app.get('/api/public/share/:token', (req, res) => {
  const info = shareInfo(req.params.token)
  if (!info.token) return fail(res, 404, '分享链接不存在或已关闭')
  res.json({ mime: info.mime, size: info.size, createdAt: info.createdAt })
})

// 视频文件：支持 Range 请求（拖动进度条、iOS 播放都需要）
app.get('/api/public/share/:token/video', (req, res) => {
  const sh = db.shares[req.params.token]
  if (!sh?.file) return fail(res, 404, '分享链接不存在或已关闭')
  res.sendFile(path.join(VIDEO_DIR, path.basename(sh.file)), {
    headers: {
      'Content-Type': sh.mime,
      'Cache-Control': 'no-store', // 关闭链接后立即失效，不让浏览器 / 代理缓存
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  }, (err) => {
    if (err && !res.headersSent) fail(res, 404, '视频文件不存在')
  })
})

// ───────────────────────── 静态托管（生产模式） ─────────────────────────
const DIST = path.join(__dirname, '..', 'dist')
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')))
}

// 接口错误统一返回 JSON（如请求体过大、JSON 格式错误），前端才能显示可读的提示
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  if (err?.type === 'entity.too.large') return fail(res, 413, '上传内容太大')
  if (err?.type === 'entity.parse.failed') return fail(res, 400, '请求格式不正确')
  console.error('[lushu]', err)
  fail(res, err?.status || 500, '服务器出错，请稍后重试')
})

app.listen(PORT, () => {
  console.log(`[lushu] 服务端已启动: http://localhost:${PORT}`)
})
