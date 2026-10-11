<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../services/api'

/**
 * 分享页 /s/<token>：只播放作者录制的巡游视频。
 * 服务端公开接口只返回视频本身，不含路书内容、地点、地图配置或用户名。
 */
const props = defineProps<{ token: string }>()
const state = ref<'loading' | 'ok' | 'error'>('loading')
const error = ref('')
const videoUrl = `/api/public/share/${encodeURIComponent(props.token)}/video`
const ext = ref('mp4')

onMounted(async () => {
  document.title = '小鹿路书 · 自驾巡游视频'
  try {
    const meta = await api.getShared(props.token)
    ext.value = meta.mime?.includes('webm') ? 'webm' : 'mp4'
    state.value = 'ok'
  } catch (e: any) {
    error.value = e?.message || '分享链接无法打开'
    state.value = 'error'
  }
})
</script>

<template>
  <div class="share-video-page">
    <header class="share-video-head">
      <img src="/images/logo.png" alt="" class="share-video-logo" />
      <span class="share-video-brand">小鹿路书</span>
    </header>

    <main class="share-video-main">
      <div v-if="state === 'loading'" class="muted">视频加载中…</div>
      <div v-else-if="state === 'error'" class="share-error">
        <p>😕 {{ error }}</p>
        <p class="muted">链接可能已被作者关闭。</p>
      </div>
      <template v-else>
        <video class="share-video-player" :src="videoUrl" controls playsinline preload="metadata"></video>
        <div class="share-video-ops">
          <a class="btn btn-secondary btn-mini" :href="videoUrl" :download="`自驾巡游视频.${ext}`">下载视频</a>
        </div>
      </template>
    </main>

    <footer class="share-video-foot muted">用 <a href="/">小鹿路书</a> 规划你自己的自驾行程</footer>
  </div>
</template>
