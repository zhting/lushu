import { ref } from 'vue'

/** 网络是否在线（浏览器判断，断网 / 飞行模式时为 false） */
export const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)

/** 浏览器给出了「安装到桌面」机会时为 true（Chrome / Edge / 安卓；iOS Safari 需手动「添加到主屏幕」） */
export const canInstall = ref(false)
let deferredPrompt: any = null

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => (online.value = true))
  window.addEventListener('offline', () => (online.value = false))
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e
    canInstall.value = true
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    canInstall.value = false
  })
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false
  deferredPrompt.prompt()
  const choice = await deferredPrompt.userChoice.catch(() => null)
  deferredPrompt = null
  canInstall.value = false
  return choice?.outcome === 'accepted'
}

/** 是否已作为独立应用（从桌面图标）打开 */
export function isStandalone(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true)
  )
}

/** 注册 Service Worker（仅生产构建；有新版本时自动更新） */
export async function registerPwa() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  try {
    const { registerSW } = await import('virtual:pwa-register')
    registerSW({ immediate: true })
  } catch {
    // 注册失败不影响在线使用
  }
}
