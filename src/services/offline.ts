/**
 * 离线数据层：
 * - 快照：登录用户的资料、地图配置和全部路书存到 localStorage，断网时据此打开。
 * - 待同步：断网期间保存的路书先记在本机，联网后再推到服务端。
 * - 线路缓存：逐段车行结果存 IndexedDB，离线也能显示里程、时间和线路；在线时也省掉重复请求。
 * 退出登录时全部清除，避免同一台设备上的下一个人看到。
 */
import type { StoredTrip } from '../types'
import type { AuthUser, MapConfig } from './api'

const SNAP_PREFIX = 'lushu.offline.v1.'
const PENDING_PREFIX = 'lushu.pending.v1.'
const SYNCED_PREFIX = 'lushu.synced.v1.'
const LAST_USER = 'lushu.offline.lastUser'

export interface OfflineSnapshot {
  user: AuthUser
  config: MapConfig
  trips: StoredTrip[]
  syncedAt: number // 上次从服务端拉取成功的时间
}

/** 一条待同步的保存：entry 为本机最新版本，base 为离线前最后一次与服务端一致的 savedAt（新建的为 null） */
export interface PendingSave {
  entry: StoredTrip
  base: number | null
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false // 存储空间满或被禁用：离线功能降级，不影响在线使用
  }
}

// ── 快照 ──
export function saveSnapshot(snap: OfflineSnapshot) {
  writeJson(SNAP_PREFIX + snap.user.username, snap)
  try {
    localStorage.setItem(LAST_USER, snap.user.username)
  } catch {}
}

export function loadSnapshot(username: string): OfflineSnapshot | null {
  return readJson<OfflineSnapshot>(SNAP_PREFIX + username)
}

/** 离线启动时用：上次登录的用户 */
export function lastSnapshotUser(): AuthUser | null {
  try {
    const name = localStorage.getItem(LAST_USER)
    return name ? loadSnapshot(name)?.user ?? null : null
  } catch {
    return null
  }
}

/** 只更新快照里的路书列表（每次本地保存后调用） */
export function updateSnapshotTrips(username: string, trips: StoredTrip[]) {
  const snap = loadSnapshot(username)
  if (snap) writeJson(SNAP_PREFIX + username, { ...snap, trips })
}

// ── 与服务端一致的版本（冲突判断用） ──
export function loadSynced(username: string): Record<string, number> {
  return readJson<Record<string, number>>(SYNCED_PREFIX + username) ?? {}
}

export function saveSynced(username: string, synced: Record<string, number>) {
  writeJson(SYNCED_PREFIX + username, synced)
}

// ── 待同步 ──
export function loadPending(username: string): Record<string, PendingSave> {
  return readJson<Record<string, PendingSave>>(PENDING_PREFIX + username) ?? {}
}

export function savePending(username: string, pending: Record<string, PendingSave>) {
  if (Object.keys(pending).length) writeJson(PENDING_PREFIX + username, pending)
  else {
    try {
      localStorage.removeItem(PENDING_PREFIX + username)
    } catch {}
  }
}

/** 退出登录：清掉该用户的全部离线数据与线路缓存 */
export async function clearOffline(username: string) {
  try {
    localStorage.removeItem(SNAP_PREFIX + username)
    localStorage.removeItem(PENDING_PREFIX + username)
    localStorage.removeItem(SYNCED_PREFIX + username)
    if (localStorage.getItem(LAST_USER) === username) localStorage.removeItem(LAST_USER)
  } catch {}
  await routeCacheClear()
}

// ── 线路缓存（IndexedDB） ──
const DB_NAME = 'lushu'
const STORE = 'routes'
const ROUTE_MAX = 2000
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('at', 'at')
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null) // 隐私模式等不可用：只用内存缓存
    }
  })
  return dbPromise
}

export async function routeCacheGet<T>(key: string): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result?.value as T) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

let putCount = 0
export async function routeCachePut(key: string, value: unknown) {
  const db = await openDb()
  if (!db) return
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put({ key, value, at: Date.now() })
  } catch {
    return
  }
  // 每写 50 条检查一次总量，超出上限删掉最早的
  if (++putCount % 50 === 0) void trimRoutes(db)
}

function trimRoutes(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    try {
      const st = db.transaction(STORE, 'readwrite').objectStore(STORE)
      const countReq = st.count()
      countReq.onsuccess = () => {
        let extra = countReq.result - ROUTE_MAX
        if (extra <= 0) return resolve()
        const cur = st.index('at').openCursor()
        cur.onsuccess = () => {
          const c = cur.result
          if (!c || extra <= 0) return resolve()
          c.delete()
          extra--
          c.continue()
        }
        cur.onerror = () => resolve()
      }
      countReq.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

async function routeCacheClear() {
  const db = await openDb()
  if (!db) return
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).clear()
  } catch {}
}
