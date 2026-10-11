<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { api } from '../services/api'
import { downloadBlob, safeFilename, toGpx, toIcs } from '../services/exporters'
import TripPoster from './TripPoster.vue'

/** 分享与导出：只读链接、长图、GPX、日历、JSON */
const emit = defineEmits<{ close: [] }>()
const store = useTripStore()

const token = ref<string | null>(null)
const loadingShare = ref(true)
const busy = ref('')
const posterOn = ref(false)
const posterEl = ref<HTMLElement | null>(null)

const shareUrl = computed(() => (token.value ? `${location.origin}/s/${token.value}` : ''))
const fname = computed(() => safeFilename(store.trip?.title || '路书'))

onMounted(async () => {
  if (!store.currentId) {
    loadingShare.value = false
    return
  }
  try {
    token.value = (await api.getShare(store.currentId)).token
  } catch (e: any) {
    store.notify(e?.message || '读取分享状态失败', 'error')
  } finally {
    loadingShare.value = false
  }
})

async function createLink() {
  if (!store.currentId) return
  busy.value = 'share'
  try {
    store.saveNow() // 先把最新内容存上去，分享页看到的才是当前版本
    token.value = (await api.createShare(store.currentId)).token
    await copyLink()
  } catch (e: any) {
    store.notify(e?.message || '生成链接失败', 'error')
  } finally {
    busy.value = ''
  }
}

async function copyLink() {
  if (!shareUrl.value) return
  try {
    await navigator.clipboard.writeText(shareUrl.value)
    store.notify('链接已复制，发给同行的人即可查看')
  } catch {
    store.notify('复制失败，请手动长按链接复制', 'error')
  }
}

async function revokeLink() {
  if (!store.currentId || !window.confirm('关闭后，已发出去的链接将无法再打开。确定关闭？')) return
  busy.value = 'share'
  try {
    await api.revokeShare(store.currentId)
    token.value = null
    store.notify('分享链接已关闭')
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
          <div class="share-section-title">只读分享链接</div>
          <p class="muted share-desc">拿到链接的人不用登录就能查看行程、地图和导航，但不能修改。</p>
          <div v-if="loadingShare" class="muted">读取中…</div>
          <template v-else-if="token">
            <div class="share-link-row">
              <input class="share-link-input" :value="shareUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
              <button class="btn btn-primary btn-mini" @click="copyLink">复制</button>
            </div>
            <div class="share-link-ops">
              <a :href="shareUrl" target="_blank" rel="noopener" class="btn-text-action">打开看看</a>
              <button class="btn-text-action danger-text" :disabled="busy === 'share'" @click="revokeLink">关闭链接</button>
            </div>
          </template>
          <button v-else class="btn btn-primary" :disabled="busy === 'share' || !store.currentId" @click="createLink">
            {{ busy === 'share' ? '生成中…' : '生成分享链接' }}
          </button>
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
