import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api, getToken, isOfflineError, setToken, type AuthUser } from '../services/api'
import { clearOffline, lastSnapshotUser, loadPending } from '../services/offline'

/** 登录态：token 存 localStorage，刷新后通过 /api/me 恢复 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null)
  const ready = ref(false) // 是否已完成启动时的登录态检查

  async function init() {
    if (getToken()) {
      try {
        const data = await api.me()
        user.value = data.user
      } catch (e) {
        // 断网：用本机缓存的用户继续离线查看；只有服务端明确拒绝（登录过期）才退出
        const cached = isOfflineError(e) ? lastSnapshotUser() : null
        if (cached) {
          user.value = cached
        } else {
          if (!isOfflineError(e)) setToken(null)
          user.value = null
        }
      }
    }
    ready.value = true
  }

  async function login(username: string, password: string) {
    const data = await api.login(username, password)
    setToken(data.token)
    user.value = data.user
  }

  async function register(username: string, password: string) {
    const data = await api.register(username, password)
    setToken(data.token)
    user.value = data.user
  }

  async function logout() {
    const name = user.value?.username
    const pendingCount = name ? Object.keys(loadPending(name)).length : 0
    if (pendingCount && !window.confirm(`还有 ${pendingCount} 本路书的离线修改没有同步到服务器，退出后这些修改会丢失。确定退出？`)) return
    try {
      await api.logout()
    } catch { /* 会话可能已过期或离线，忽略 */ }
    setToken(null)
    user.value = null
    if (name) await clearOffline(name) // 不在这台设备上留下路书数据
  }

  return { user, ready, init, login, register, logout }
})
