import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const DB_FILE = path.join(DATA_DIR, 'db.json')

const DEFAULT_DB = {
  users: [], // { username, passHash, isAdmin, createdAt }
  sessions: {}, // token -> { username, createdAt }
  trips: {}, // username -> StoredTrip[]
  config: {
    amapKey: '',
    amapSecurityJsCode: '',
    defaultProvider: 'osm', // 'osm' | 'amap'
  },
}

let db = null
let saveTimer = null

export function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'))
      db = { ...structuredClone(DEFAULT_DB), ...parsed }
    } catch {
      console.error('[db] db.json 解析失败，使用空数据库')
      db = structuredClone(DEFAULT_DB)
    }
  } else {
    db = structuredClone(DEFAULT_DB)
    saveDbNow()
  }
  return db
}

export function getDb() {
  if (!db) loadDb()
  return db
}

/** 防抖写盘：高频保存合并为一次磁盘写入 */
export function saveDb() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveDbNow, 300)
}

export function saveDbNow() {
  clearTimeout(saveTimer)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = DB_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8')
  fs.renameSync(tmp, DB_FILE)
}

process.on('exit', () => {
  if (db) saveDbNow()
})
