<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useTripStore } from '../stores/trip'
import { todayStr } from '../services/geo'

const store = useTripStore()
const auth = useAuthStore()
const showCreateModal = ref(false)
const showUserMenu = ref(false)
const activeMenuTripId = ref<string | null>(null)
const title = ref('')
const startDate = ref(todayStr())

function openCreateModal() {
  title.value = ''
  startDate.value = todayStr()
  showCreateModal.value = true
}

function create() {
  if (!title.value.trim()) {
    title.value = '未命名行程'
  }
  store.createTrip(title.value.trim(), startDate.value, 2)
  showCreateModal.value = false
}

function fmtSavedAt(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚更新'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`
}

function toggleTripMenu(id: string, e: MouseEvent) {
  e.stopPropagation()
  activeMenuTripId.value = activeMenuTripId.value === id ? null : id
}

function closeAllMenus() {
  showUserMenu.value = false
  activeMenuTripId.value = null
}
</script>

<template>
  <div class="home-page" @click="closeAllMenus">
    <div class="home-container">
      <!-- 整个覆盖顶部的 Hero 区域（背景图通顶，Header 浮于其上） -->
      <section class="top-hero-full-wrap">
        <!-- 背景图片：覆盖整个顶部 Header 到创建按钮区域 -->
        <img src="/images/hero_banner.jpg" alt="自驾公路风景" class="hero-full-bg-img" />
        <!-- 顶部柔光蒙层，保证 Logo 与导航文字清晰明亮 -->
        <div class="hero-top-soft-mask"></div>

        <!-- 浮在背景图顶部的 Brand Header -->
        <header class="hero-floating-header">
          <div class="brand-group">
            <img src="/images/logo.png" alt="小鹿路书" class="brand-mascot-logo" />
            <div class="brand-text-block">
              <h1 class="brand-title-text">小鹿路书</h1>
              <p class="brand-sub-text">按天规划你的自驾行程</p>
            </div>
          </div>

          <div class="header-right-btns">
            <!-- 用户头像：白底圆形深灰剪影 -->
            <div class="user-action-wrap" @click.stop>
              <button class="user-circle-btn" title="个人与管理中心" @click="showUserMenu = !showUserMenu">
                <svg class="user-svg-icon" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                </svg>
              </button>
              <div v-if="showUserMenu" class="dropdown-popover user-dropdown">
                <div class="user-info-row">
                  <div class="user-avatar-small">👤</div>
                  <div class="user-detail">
                    <div class="username">{{ auth.user?.username }}</div>
                    <div class="user-role">{{ auth.user?.isAdmin ? '系统管理员' : '标准用户' }}</div>
                    <div class="user-engine-line">
                      <span class="engine-tag">{{ store.mapCfg.provider === 'amap' ? '🇨🇳 高德地图' : '🌐 开源地图' }}</span>
                    </div>
                  </div>
                </div>
                <div class="popover-divider"></div>
                <button v-if="auth.user?.isAdmin" class="popover-item" @click="store.adminOpen = true; showUserMenu = false">
                  ⚙️ 管理后台
                </button>
                <button class="popover-item danger-item" @click="auth.logout()">
                  🚪 退出登录
                </button>
              </div>
            </div>
          </div>
        </header>

        <!-- 左上方手绘字：去看更大的世界 + 弯曲圆环波浪线 -->
        <div class="hero-handwrite-svg-wrap">
          <svg viewBox="0 0 200 70" class="handwrite-svg" fill="none">
            <text
              x="6"
              y="32"
              font-family="-apple-system, BlinkMacSystemFont, 'Caveat', 'Kaiti', 'STKaiti', cursive, sans-serif"
              font-size="22"
              font-weight="800"
              font-style="italic"
              fill="#2074f8"
              letter-spacing="1px"
            >去看更大的世界</text>
            <path
              d="M 5 52 C 40 40, 95 40, 145 46 C 162 48, 175 49, 180 43 C 183 38, 180 32, 172 34 C 165 36, 166 45, 177 46"
              stroke="#2074f8"
              stroke-width="2.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>

        <!-- 底部悬浮大胶囊按钮：白圆圈加号 + 创建新路书 + 细右箭头 -->
        <div class="hero-btn-bottom-bar">
          <button class="hero-action-pill-btn" @click="openCreateModal">
            <div class="hero-btn-main">
              <span class="white-round-plus">＋</span>
              <span class="btn-text-create">创建新路书</span>
            </div>
            <span class="btn-arrow-thin">›</span>
          </button>
        </div>
      </section>

      <!-- 我的路书列表区域 -->
      <section class="my-trips-section">
        <div class="section-title-bar">
          <div class="title-left">
            <h2 class="main-title">我的路书</h2>
            <span class="sub-count">共 {{ store.tripSummaries.length }} 个路书</span>
          </div>
          <button class="sample-link-btn" @click="store.loadSample()">
            载入示例行程
          </button>
        </div>

        <!-- 空列表提示 -->
        <div v-if="!store.tripSummaries.length" class="empty-roadtrip-card">
          <div class="empty-icon">🗺️</div>
          <div class="empty-title">还没有路书</div>
          <p class="empty-desc">点击上方「创建新路书」开始规划第一次自驾之旅</p>
          <button class="btn btn-primary btn-round" @click="openCreateModal">＋ 创建新路书</button>
        </div>

        <!-- 路书卡片网格 -->
        <div v-else class="roadtrip-grid">
          <div
            v-for="s in store.tripSummaries"
            :key="s.id"
            class="roadtrip-card"
            @click="store.openTrip(s.id)"
          >
            <!-- 封面图部分 -->
            <div class="card-cover-wrap">
              <img src="/images/trip_cover.jpg" alt="路书封面" class="card-cover-img" />
              <!-- 手绘文艺字：山河辽阔 / —— 总有下一站 -->
              <div class="card-cover-badge">
                <div class="badge-line1">山河辽阔</div>
                <div class="badge-line2">—— 总有下一站</div>
              </div>
              <button
                class="card-more-btn"
                title="更多操作"
                @click="toggleTripMenu(s.id, $event)"
              >
                •••
              </button>
              <div v-if="activeMenuTripId === s.id" class="dropdown-popover trip-popover" @click.stop>
                <button class="popover-item danger-item" @click.stop="store.deleteTrip(s.id); activeMenuTripId = null">
                  🗑️ 删除该路书
                </button>
              </div>
            </div>

            <!-- 卡片信息部分 -->
            <div class="card-info-wrap">
              <h3 class="trip-card-title">{{ s.title }}</h3>
              <div class="trip-card-meta">
                <span class="meta-item">📅 {{ s.startDate }} · {{ s.days }} 天</span>
              </div>
              <div class="trip-card-footer">
                <span class="update-time">{{ fmtSavedAt(s.savedAt) }}</span>
                <div class="card-arrow-circle">
                  <span>›</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 创建新路书 Modal 弹窗 -->
    <div v-if="showCreateModal" class="modal-backdrop" @click="showCreateModal = false">
      <div class="modal-card" @click.stop>
        <div class="modal-head">
          <h3>新建路书</h3>
          <button class="modal-close-btn" @click="showCreateModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>行程名称</label>
            <input v-model="title" placeholder="例如：2026 国庆旅游、川西大环线" @keyup.enter="create" autofocus />
          </div>
          <div class="field">
            <label>出发日期</label>
            <input v-model="startDate" type="date" />
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-secondary" @click="showCreateModal = false">取消</button>
          <button class="btn btn-primary" @click="create">创建路书</button>
        </div>
      </div>
    </div>
  </div>
</template>
