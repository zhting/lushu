<script setup lang="ts">
import { computed } from 'vue'
import { useTripStore } from '../stores/trip'
import { online } from '../services/pwa'

/** 离线提示条：显示缓存时间与待同步数量 */
const store = useTripStore()

const show = computed(() => store.offlineMode || !online.value || store.pendingCount > 0)

const syncedText = computed(() => {
  const ts = store.offlineSyncedAt
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})
</script>

<template>
  <div v-if="show" class="offline-banner" :class="{ 'offline-pending-only': online && !store.offlineMode }" role="status">
    <template v-if="!online || store.offlineMode">
      <span class="offline-dot"></span>
      <span>
        离线查看中<template v-if="syncedText">，数据截至 {{ syncedText }}</template>。
        修改会先存在本机<template v-if="store.pendingCount">（{{ store.pendingCount }} 本待同步）</template>，联网后自动同步；搜索地点、新线路和天气需要联网。
      </span>
    </template>
    <template v-else>
      <span>{{ store.pendingCount }} 本路书的离线修改正在同步…</span>
      <button class="btn-text-action" @click="store.syncPending()">立即同步</button>
    </template>
  </div>
</template>
