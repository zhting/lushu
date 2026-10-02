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
    // 同步到当前会话的地图配置并重算线路（坐标系可能变化）
    store.applyServerConfig(cfg)
    message.value = '已保存，地图配置已生效'
  } catch (e: any) {
    error.value = e?.message || '保存失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="admin-page">
    <header class="topbar">
      <button class="btn btn-mini" @click="store.adminOpen = false">← 返回</button>
      <div class="brand">⚙ 管理后台</div>
    </header>

    <div class="admin-body">
      <div class="card">
        <h3>地图 API 配置（对全部用户生效）</h3>
        <div class="field">
          <label>高德 Key（类型须为「Web端(JS API)」，留空则仅支持开源地图）</label>
          <input v-model="amapKey" placeholder="在 console.amap.com 申请" autocomplete="off" />
        </div>
        <div class="field">
          <label>安全密钥 securityJsCode（2021-12-02 后申请的 Key 必填）</label>
          <input v-model="amapSecurityJsCode" placeholder="与该 Key 配套的 jscode" autocomplete="off" />
        </div>
        <div class="field">
          <label>新用户的默认地图数据源</label>
          <select v-model="defaultProvider" style="width: auto">
            <option value="osm">开源地图（OpenStreetMap，免 Key）</option>
            <option value="amap">高德地图（需已填写 Key）</option>
          </select>
        </div>
        <p class="muted" style="margin: 0 0 10px">
          Key 保存在服务端，仅用于前端加载地图 JS API；正式部署请在高德控制台为该 Key 配置域名白名单。
        </p>
        <p v-if="message" class="muted" style="margin: 0 0 10px; color: #059669">{{ message }}</p>
        <p v-if="error" class="error-text" style="margin: 0 0 10px">{{ error }}</p>
        <button class="btn btn-primary" style="width: auto; padding: 8px 20px" :disabled="busy" @click="save">
          {{ busy ? '保存中…' : '保存配置' }}
        </button>
      </div>

      <div class="card">
        <h3>用户（{{ users.length }}）</h3>
        <div v-for="u in users" :key="u.username" class="admin-user-row">
          <b>{{ u.username }}</b>
          <span v-if="u.isAdmin" class="chip">管理员</span>
          <span class="muted" style="margin-left: auto">
            {{ u.createdAt ? new Date(u.createdAt).toLocaleString() : '' }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
