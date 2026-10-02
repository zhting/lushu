import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api, getToken, setToken, type AuthUser } from '../services/api'

/** 登录态：token 存 localStorage，刷新后通过 /api/me 恢复 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null)
  const ready = ref(false) // 是否已完成启动时的登录态检查

  async function init() {
    if (getToken()) {
      try {
        const data = await api.me()
        user.value = data.user
      } catch {
        setToken(null)
        user.value = null
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
    try {
      await api.logout()
    } catch { /* 会话可能已过期，忽略 */ }
    setToken(null)
    user.value = null
  }

  return { user, ready, init, login, register, logout }
})
