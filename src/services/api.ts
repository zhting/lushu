const TOKEN_KEY = 'lushu.token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

/** 网络不通（断网、服务器不可达）：与服务端返回的业务错误区分开，离线逻辑据此降级 */
export class NetworkError extends Error {
  readonly offline = true
  constructor() {
    super('网络连接失败，请检查网络')
  }
}

export function isOfflineError(e: unknown): boolean {
  return !!(e as any)?.offline
}

async function request(method: string, url: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  } catch {
    throw new NetworkError()
  }
  let data: any = null
  try {
    data = await res.json()
  } catch { /* 非 JSON 响应 */ }
  if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`)
  return data
}

export interface AuthUser {
  username: string
  isAdmin: boolean
  createdAt?: number
}

export interface MapConfig {
  amapKey: string
  amapSecurityJsCode: string
  hasAmapKey: boolean
  defaultProvider: 'osm' | 'amap'
  hasAi?: boolean
  aiVision?: boolean
}

export interface AiAdminConfig {
  baseUrl: string
  model: string
  vision: boolean
  hasKey: boolean
  keyHint: string
}

/** AI 识别 / 规划出的行程（地点尚未匹配坐标） */
export interface AiPlanStop {
  name: string
  city: string
  kind: 'waypoint' | 'scenic' | 'food' | 'fuel' | 'hotel'
  stayMinutes: number | null
  note: string
}

export interface AiPlan {
  title: string
  mode: 'extract' | 'plan'
  days: { stops: AiPlanStop[] }[]
  notes: string
}

export const api = {
  register: (username: string, password: string) => request('POST', '/api/register', { username, password }),
  login: (username: string, password: string) => request('POST', '/api/login', { username, password }),
  logout: () => request('POST', '/api/logout'),
  me: () => request('GET', '/api/me'),
  getConfig: (): Promise<MapConfig> => request('GET', '/api/config'),
  adminGetConfig: (): Promise<MapConfig> => request('GET', '/api/config'),
  adminSaveConfig: (cfg: Partial<MapConfig>) => request('PUT', '/api/admin/config', cfg),
  adminUsers: () => request('GET', '/api/admin/users'),
  getTrips: () => request('GET', '/api/trips'),
  putTrip: (entry: unknown) => request('PUT', `/api/trips/${(entry as any).id}`, entry),
  deleteTrip: (id: string) => request('DELETE', `/api/trips/${id}`),
  getShare: (id: string): Promise<ShareInfo> => request('GET', `/api/trips/${id}/share`),
  revokeShare: (id: string) => request('DELETE', `/api/trips/${id}/share`),
  getShared: (token: string): Promise<{ mime: string; size: number; createdAt: number }> =>
    request('GET', `/api/public/share/${encodeURIComponent(token)}`),
  uploadShareVideo,
  adminGetAi: (): Promise<AiAdminConfig> => request('GET', '/api/admin/ai'),
  adminSaveAi: (cfg: Partial<AiAdminConfig> & { apiKey?: string; clearKey?: boolean }): Promise<AiAdminConfig> =>
    request('PUT', '/api/admin/ai', cfg),
  aiParse: (input: { text: string; images: string[]; startDate: string; hints?: string }): Promise<AiPlan> =>
    request('POST', '/api/ai/parse', input),
}

export interface ShareInfo {
  token: string | null
  size?: number
  mime?: string
  createdAt?: number
}

/** 上传分享视频（XHR 以便显示上传进度）；同一路书重复上传会替换视频、沿用链接 */
function uploadShareVideo(tripId: string, blob: Blob, onProgress?: (ratio: number) => void): Promise<ShareInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/trips/${encodeURIComponent(tripId)}/share/video`)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', blob.type.includes('mp4') ? 'video/mp4' : 'video/webm')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      let data: any = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch { /* 非 JSON（如反向代理的 413 页面） */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else if (xhr.status === 413) reject(new Error('视频太大，服务器拒收（请联系管理员调大上传限制）'))
      else reject(new Error(data?.error || `上传失败（HTTP ${xhr.status}）`))
    }
    xhr.onerror = () => reject(new Error('网络错误，视频上传失败'))
    xhr.send(blob)
  })
}
