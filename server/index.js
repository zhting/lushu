import express from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getDb, saveDb } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

const app = express()
app.use(express.json({ limit: '5mb' }))

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
    saveDb()
  }
  res.json({ ok: true })
})

// ───────────────────────── 静态托管（生产模式） ─────────────────────────
const DIST = path.join(__dirname, '..', 'dist')
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')))
}

app.listen(PORT, () => {
  console.log(`[lushu] 服务端已启动: http://localhost:${PORT}`)
})
