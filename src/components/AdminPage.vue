<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { api, type AuthUser, type MapConfig } from '../services/api'

const store = useTripStore()

const amapKey = ref('')
const amapSecurityJsCode = ref('')
const defaultProvider = ref<'osm' | 'amap'>('osm')
const users = ref<AuthUser[]>([])
const message = ref('')
const error = ref('')
const busy = ref(false)

// 密钥显隐控制（默认隐藏防泄露）
const showAmapKey = ref(false)
const showSecurityCode = ref(false)

onMounted(async () => {
  try {
    const cfg: MapConfig = await api.adminGetConfig()
    amapKey.value = cfg.amapKey || ''
    amapSecurityJsCode.value = cfg.amapSecurityJsCode || ''
    defaultProvider.value = cfg.defaultProvider
    const u = await api.adminUsers()
    users.value = u.users || []
  } catch (e: any) {
    error.value = e?.message || '配置加载失败'
  }
})

async function save() {
  message.value = ''
  error.value = ''
  busy.value = true
  try {
    const cfg = await api.adminSaveConfig({
      amapKey: amapKey.value.trim(),
      amapSecurityJsCode: amapSecurityJsCode.value.trim(),
      defaultProvider: defaultProvider.value,
    })
    // 同步到当前会话的地图配置并重算线路
    store.applyServerConfig(cfg)
    message.value = '配置已保存，地图服务已即时生效'
    store.notify('配置已保存成功')
  } catch (e: any) {
    error.value = e?.message || '保存失败'
    store.notify(error.value, 'error')
  } finally {
    busy.value = false
  }
}

function copyText(text: string, label: string) {
  if (!text) {
    store.notify(`暂无${label}内容可复制`, 'error')
    return
  }
  navigator.clipboard.writeText(text).then(() => {
    store.notify(`已复制${label}到剪贴板`)
  }).catch(() => {
    store.notify('复制失败，请手动长按复制', 'error')
  })
}

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function userInitial(name: string): string {
  return (name || 'U').slice(0, 1).toUpperCase()
}
</script>

<template>
  <div class="admin-page">
    <div class="admin-container">
      <!-- 沉浸式顶部 Header（保持充足高度与安全边距） -->
      <header class="admin-hero-header">
        <img src="/images/hero_banner.jpg" alt="管理后台风景" class="admin-header-bg" />
        <div class="admin-header-mask"></div>

        <!-- 顶部快捷导航栏（返回按钮 + 身份徽标） -->
        <div class="admin-nav-bar">
          <button class="admin-back-btn" title="返回路书首页" @click="store.adminOpen = false">
            <span class="back-arrow">‹</span>
            <span class="back-label">返回</span>
          </button>
          <div class="admin-shield-badge">
            <span class="shield-emoji">🛡️</span>
            <span>管理员工作台</span>
          </div>
        </div>

        <!-- 品牌大卡片 -->
        <div class="admin-brand-row">
          <img src="/images/logo.png" alt="小鹿路书" class="admin-brand-logo" />
          <div class="admin-brand-text">
            <h1 class="admin-brand-title">小鹿路书 · 系统管理后台</h1>
            <p class="admin-brand-sub">服务端地图密钥与多用户管理中心</p>
          </div>
        </div>
      </header>

      <!-- 主体卡片区域 -->
      <main class="admin-content-body">
        <!-- 卡片 1：地图 API 配置 -->
        <section class="admin-card">
          <div class="admin-card-head">
            <div class="head-icon-circle blue-icon">🗺️</div>
            <div class="head-title-col">
              <h2 class="card-main-title">地图服务配置</h2>
              <p class="card-sub-title">用于路线规划、地点搜索与自驾车程耗时计算（对全员生效）</p>
            </div>
          </div>

          <div class="admin-card-body">
            <!-- 高德 Key（隐藏密文显示 + 显隐切换 + 复制） -->
            <div class="admin-field">
              <div class="field-top-row">
                <label class="field-title">高德 Key <span class="label-pill">Web端 (JS API)</span></label>
                <a
                  href="https://console.amap.com"
                  target="_blank"
                  rel="noreferrer"
                  class="field-external-link"
                >前往高德控制台 ↗</a>
              </div>
              <div class="input-icon-box">
                <span class="input-icon">🔑</span>
                <input
                  v-model="amapKey"
                  :type="showAmapKey ? 'text' : 'password'"
                  placeholder="请输入在高德控制台申请的 Web 端 Key"
                  class="admin-styled-input"
                  autocomplete="off"
                  spellcheck="false"
                />
                <div class="input-actions-right">
                  <button
                    type="button"
                    class="input-action-btn"
                    :title="showAmapKey ? '隐藏明文' : '查看明文'"
                    @click="showAmapKey = !showAmapKey"
                  >
                    <span>{{ showAmapKey ? '👁️' : '🔒' }}</span>
                  </button>
                  <button
                    type="button"
                    class="input-action-btn"
                    title="复制高德 Key"
                    @click="copyText(amapKey, '高德 Key')"
                  >
                    <span>📋</span>
                  </button>
                </div>
              </div>
              <p class="field-sub-note">留空时系统默认仅使用开源地图 (OpenStreetMap)；默认为密文显示防窥屏。</p>
            </div>

            <!-- 安全密钥 securityJsCode（隐藏密文显示 + 显隐切换 + 复制） -->
            <div class="admin-field">
              <div class="field-top-row">
                <label class="field-title">安全密钥 securityJsCode <span class="label-pill warning-pill">高德官方配套必填</span></label>
              </div>
              <div class="input-icon-box">
                <span class="input-icon">🛡️</span>
                <input
                  v-model="amapSecurityJsCode"
                  :type="showSecurityCode ? 'text' : 'password'"
                  placeholder="与该 Key 配套的安全密钥 jscode"
                  class="admin-styled-input"
                  autocomplete="off"
                  spellcheck="false"
                />
                <div class="input-actions-right">
                  <button
                    type="button"
                    class="input-action-btn"
                    :title="showSecurityCode ? '隐藏明文' : '查看明文'"
                    @click="showSecurityCode = !showSecurityCode"
                  >
                    <span>{{ showSecurityCode ? '👁️' : '🔒' }}</span>
                  </button>
                  <button
                    type="button"
                    class="input-action-btn"
                    title="复制安全密钥"
                    @click="copyText(amapSecurityJsCode, '安全密钥')"
                  >
                    <span>📋</span>
                  </button>
                </div>
              </div>
              <p class="field-sub-note">高德自 2021 年 12 月起对所有新申请的 Web 端 Key 强制要求配套安全密钥，两者必须成对配置方可正常加载地图。</p>
            </div>

            <!-- 全站地图引擎设置（管理员全局确定） -->
            <div class="admin-field">
              <label class="field-title">全站地图规划引擎 <span class="label-pill">管理员指定 · 全员生效</span></label>
              <div class="provider-switch-row">
                <div
                  class="provider-toggle-card"
                  :class="{ active: defaultProvider === 'osm' }"
                  @click="defaultProvider = 'osm'"
                >
                  <div class="toggle-check-ring">
                    <span v-if="defaultProvider === 'osm'">✓</span>
                  </div>
                  <div class="toggle-card-info">
                    <div class="toggle-card-title">🌐 开源地图 (OSM)</div>
                    <div class="toggle-card-desc">免 Key 开箱即用 · 国际地理底图与 OSRM 线路</div>
                  </div>
                </div>

                <div
                  class="provider-toggle-card"
                  :class="{ active: defaultProvider === 'amap' }"
                  @click="defaultProvider = 'amap'"
                >
                  <div class="toggle-check-ring">
                    <span v-if="defaultProvider === 'amap'">✓</span>
                  </div>
                  <div class="toggle-card-info">
                    <div class="toggle-card-title">🇨🇳 高德地图 (AMap)</div>
                    <div class="toggle-card-desc">全国精准路网 · POI 搜索与实时自驾车程耗时</div>
                  </div>
                </div>
              </div>
              <p class="field-sub-note">由系统管理员统一确定，保存后对全站所有用户统一生效，普通用户端不再提供切换。</p>
            </div>

            <!-- 提示信息 -->
            <div v-if="message" class="admin-banner success-banner">
              <span class="banner-icon">✓</span>
              <span>{{ message }}</span>
            </div>
            <div v-if="error" class="admin-banner error-banner">
              <span class="banner-icon">✕</span>
              <span>{{ error }}</span>
            </div>

            <!-- 保存按钮 -->
            <div class="admin-action-row">
              <button
                class="admin-save-btn"
                :disabled="busy"
                @click="save"
              >
                <span v-if="busy" class="spinner-ring"></span>
                <span v-else class="btn-save-emoji">💾</span>
                <span class="btn-save-label">{{ busy ? '正在同步保存…' : '保存全局地图配置' }}</span>
              </button>
            </div>
          </div>
        </section>

        <!-- 卡片 2：用户账户列表 -->
        <section class="admin-card">
          <div class="admin-card-head">
            <div class="head-icon-circle purple-icon">👥</div>
            <div class="head-title-col">
              <div class="title-with-badge">
                <h2 class="card-main-title">系统用户管理</h2>
                <span class="head-count-tag">共 {{ users.length }} 位成员</span>
              </div>
              <p class="card-sub-title">已注册的小鹿路书账户与角色权限</p>
            </div>
          </div>

          <div class="admin-card-body">
            <div class="user-cards-stack">
              <div
                v-for="u in users"
                :key="u.username"
                class="user-row-card"
              >
                <div class="user-avatar-wrap" :class="{ 'admin-border': u.isAdmin }">
                  <span class="avatar-letter">{{ userInitial(u.username) }}</span>
                  <span v-if="u.isAdmin" class="crown-mini-badge" title="管理员">👑</span>
                </div>

                <div class="user-detail-col">
                  <div class="user-main-line">
                    <span class="user-username-text">{{ u.username }}</span>
                    <span v-if="u.isAdmin" class="user-role-badge admin-badge">
                      🛡️ 系统管理员
                    </span>
                    <span v-else class="user-role-badge standard-badge">
                      标准用户
                    </span>
                  </div>
                  <div class="user-time-line">
                    <span class="clock-icon">🕒</span>
                    <span>注册时间：{{ fmtTime(u.createdAt) }}</span>
                  </div>
                </div>

                <div class="user-state-col">
                  <span class="online-status-dot">● 正常</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>
