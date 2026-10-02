const TOKEN_KEY = 'lushu.token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
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
    throw new Error('网络请求失败，请检查服务端是否已启动')
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
}
