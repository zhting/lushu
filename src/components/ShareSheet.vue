<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { api, type ShareInfo } from '../services/api'
import { downloadBlob, safeFilename, toGpx, toIcs } from '../services/exporters'
import TripPoster from './TripPoster.vue'

/** 分享与导出：巡游视频分享链接（只分享视频）、长图、GPX、日历、JSON */
const emit = defineEmits<{ close: [] }>()
const store = useTripStore()

const info = ref<ShareInfo>({ token: null })
const loadingShare = ref(true)
const busy = ref('')
const uploadPct = ref(0)
const posterOn = ref(false)
const posterEl = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const shareUrl = computed(() => (info.value.token ? `${location.origin}/s/${info.value.token}` : ''))
const fname = computed(() => safeFilename(store.trip?.title || '路书'))
const sizeText = computed(() => (info.value.size ? `${(info.value.size / 1024 / 1024).toFixed(1)} MB` : ''))

onMounted(async () => {
  if (store.currentId) {
    try {
      info.value = await api.getShare(store.currentId)
    } catch (e: any) {
      store.notify(e?.message || '读取分享状态失败', 'error')
    }
  }
  loadingShare.value = false
  // 刚录完的视频：弹窗重新打开时自动上传
  const blob = store.pendingShareVideo
  if (blob) {
    store.pendingShareVideo = null
    await upload(blob)
  }
})

/** 关闭弹窗、到地图录制全程巡游视频；录完自动回到这里上传 */
function recordAndShare() {
  if (!store.trip?.days.some((d) => d.stops.length > 1)) {
    store.notify('至少要有一天安排了两个以上地点，才能录制巡游视频', 'error')
    return
  }
  emit('close')
  store.requestShareRecording()
}

function pickFile() {
  fileInput.value?.click()
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  if (!/^video\/(mp4|webm)$/.test(f.type) && !/\.(mp4|webm)$/i.test(f.name)) {
    store.notify('只支持 MP4 或 WebM 视频', 'error')
    return
  }
  await upload(f)
}

async function upload(blob: Blob) {
  if (!store.currentId) return
  busy.value = 'upload'
  uploadPct.value = 0
  try {
    info.value = await api.uploadShareVideo(store.currentId, blob, (r) => (uploadPct.value = Math.round(r * 100)))
    await copyLink()
  } catch (e: any) {
    store.notify(e?.message || '视频上传失败', 'error')
  } finally {
    busy.value = ''
  }
}

async function copyLink() {
  if (!shareUrl.value) return
  try {
    await navigator.clipboard.writeText(shareUrl.value)
    store.notify('视频链接已复制，发给朋友即可观看')
  } catch {
    store.notify('视频已上传，请手动复制链接', 'info')
  }
}

async function revokeLink() {
  if (!store.currentId || !window.confirm('关闭后链接立即失效，服务器上的视频也会删除。确定关闭？')) return
  busy.value = 'share'
  try {
    await api.revokeShare(store.currentId)
    info.value = { token: null }
    store.notify('分享链接已关闭，视频已删除')
  } catch (e: any) {
    store.notify(e?.message || '关闭失败', 'error')
  } finally {
    busy.value = ''
  }
}

async function exportImage() {
  busy.value = 'image'
  posterOn.value = true
  try {
    await nextTick()
    const el = posterEl.value?.querySelector('.poster') as HTMLElement | null
    if (!el) throw new Error('长图渲染失败')
    // 等封面图加载完，否则导出的图片顶部是空的
    await Promise.all(
      Array.from(el.querySelectorAll('img')).map((img) =>
        img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = () => r(null) }),
      ),
    )
    const { toBlob } = await import('html-to-image')
    // 只用系统字体，跳过网页字体内嵌（否则会去读跨域的地图样式表并报错）
    const blob = await toBlob(el, { pixelRatio: 2, backgroundColor: '#f5f8fc', cacheBust: true, skipFonts: true })
    if (!blob) throw new Error('长图生成失败')
    downloadBlob(blob, `${fname.value}.png`)
    store.notify('长图已导出')
  } catch (e: any) {
    store.notify(e?.message || '长图导出失败', 'error')
  } finally {
    posterOn.value = false
    busy.value = ''
  }
}

function exportGpx() {
  if (!store.trip) return
  const xml = toGpx(store.trip, store.legPaths, store.mapCfg.provider)
  downloadBlob(new Blob([xml], { type: 'application/gpx+xml' }), `${fname.value}.gpx`)
  store.notify('GPX 已导出，可导入车机、两步路、六只脚等 App')
}

function exportIcs() {
  if (!store.trip) return
  const ics = toIcs(store.trip, store.schedules, store.legDistances)
  downloadBlob(new Blob([ics], { type: 'text/calendar' }), `${fname.value}.ics`)
  store.notify('日历已导出，打开文件即可加入手机日历')
}

function exportJson() {
  downloadBlob(new Blob([store.exportJson()], { type: 'application/json' }), `${fname.value}.json`)
  store.notify('已导出路书 JSON 文件')
}
</script>

<template>
  <div class="modal-backdrop" @click="emit('close')">
    <div class="modal-card share-sheet" @click.stop>
      <div class="modal-head">
        <h3>分享与导出</h3>
        <button class="modal-close-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <section class="share-section">
          <div class="share-section-title">分享巡游视频</div>
          <p class="muted share-desc">
            链接只能看到你录制的这段巡游视频，看不到路书内容、地点列表和你的账号信息。关闭链接后视频随即删除。
          </p>
          <div v-if="loadingShare" class="muted">读取中…</div>
          <div v-else-if="busy === 'upload'" class="upload-progress">
            <div class="upload-bar"><span :style="{ width: uploadPct + '%' }"></span></div>
            <span class="muted">视频上传中 {{ uploadPct }}%</span>
          </div>
          <template v-else-if="info.token">
            <div class="share-link-row">
              <input class="share-link-input" :value="shareUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
              <button class="btn btn-primary btn-mini" @click="copyLink">复制</button>
            </div>
            <div class="share-link-ops">
              <a :href="shareUrl" target="_blank" rel="noopener" class="btn-text-action">打开看看</a>
              <button class="btn-text-action" :disabled="!!busy" @click="recordAndShare">重新录制</button>
              <button class="btn-text-action" :disabled="!!busy" @click="pickFile">换成本地视频</button>
              <button class="btn-text-action danger-text" :disabled="!!busy" @click="revokeLink">关闭链接</button>
              <span v-if="sizeText" class="muted">{{ sizeText }}</span>
            </div>
          </template>
          <div v-else class="share-video-actions">
            <button class="btn btn-primary" :disabled="!!busy || !store.currentId" @click="recordAndShare">🎬 录制并分享</button>
            <button class="btn btn-secondary" :disabled="!!busy || !store.currentId" @click="pickFile">上传已导出的视频</button>
          </div>
          <input ref="fileInput" type="file" accept="video/mp4,video/webm,.mp4,.webm" style="display: none" @change="onFile" />
        </section>

        <section class="share-section">
          <div class="share-section-title">导出</div>
          <div class="export-grid">
            <button class="export-item" :disabled="!!busy" @click="exportImage">
              <span class="export-icon">🖼️</span>
              <span class="export-name">{{ busy === 'image' ? '生成中…' : '长图' }}</span>
              <span class="export-desc">发朋友圈、小红书</span>
            </button>
            <button class="export-item" :disabled="!!busy" @click="exportGpx">
              <span class="export-icon">🧭</span>
              <span class="export-name">GPX 轨迹</span>
              <span class="export-desc">导入车机、户外 App</span>
            </button>
            <button class="export-item" :disabled="!!busy" @click="exportIcs">
              <span class="export-icon">📅</span>
              <span class="export-name">日历</span>
              <span class="export-desc">每天一个日程</span>
            </button>
            <button class="export-item" :disabled="!!busy" @click="exportJson">
              <span class="export-icon">⎘</span>
              <span class="export-name">JSON</span>
              <span class="export-desc">备份或导入其他账号</span>
            </button>
          </div>
        </section>
      </div>
    </div>

    <!-- 长图渲染区：放在屏幕外，只在导出时挂载 -->
    <div v-if="posterOn" ref="posterEl" class="poster-offscreen" aria-hidden="true">
      <TripPoster />
    </div>
  </div>
</template>
