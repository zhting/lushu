<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { useAuthStore } from '../stores/auth'
import { api, type AiPlan } from '../services/api'
import * as mapSvc from '../services/map'
import { haversineKm, todayStr } from '../services/geo'
import { online } from '../services/pwa'
import { KIND_META, KIND_OPTIONS } from '../constants'
import type { Poi, StopKind } from '../types'

/**
 * AI 生成路书：
 * 1. 粘贴攻略文字 / 上传截图 / 写一句需求 → 服务端调大模型整理成按天的地点
 * 2. 前端用地图搜索逐个匹配真实地点（可换候选、改名重搜、删除）
 * 3. 用户确认后生成路书
 */
const emit = defineEmits<{ close: [] }>()
const store = useTripStore()
const auth = useAuthStore()

type Step = 'input' | 'thinking' | 'matching' | 'review'
const step = ref<Step>('input')
const text = ref('')
const hints = ref('')
const startDate = ref(todayStr())
const images = ref<{ url: string; name: string }[]>([])
const error = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

interface Row {
  key: string
  name: string // AI 给的名称（可改后重搜）
  city: string
  kind: StopKind
  stayMinutes: number | null
  note: string
  candidates: Poi[]
  pick: number // -1 = 未匹配
  searching: boolean
}

const plan = ref<AiPlan | null>(null)
const title = ref('')
const days = ref<Row[][]>([])
const progress = ref({ done: 0, total: 0 })

const canSubmit = computed(() => !!text.value.trim() || images.value.length > 0)
const matchedCount = computed(() => days.value.flat().filter((r) => r.pick >= 0).length)
const unmatchedCount = computed(() => days.value.flat().filter((r) => r.pick < 0).length)

const MAX_IMAGES = 4

/** 压缩截图：长边不超过 1600px，转 JPEG，减小上传体积 */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * scale)
      c.height = Math.round(img.height * scale)
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`无法读取图片「${file.name}」`))
    }
    img.src = url
  })
}

async function onFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  for (const f of files) {
    if (images.value.length >= MAX_IMAGES) {
      store.notify(`最多上传 ${MAX_IMAGES} 张截图`, 'error')
      break
    }
    if (!f.type.startsWith('image/')) continue
    try {
      images.value.push({ url: await compressImage(f), name: f.name })
    } catch (err: any) {
      store.notify(err?.message || '图片读取失败', 'error')
    }
  }
}

async function generate() {
  error.value = ''
  step.value = 'thinking'
  try {
    const res = await api.aiParse({
      text: text.value.trim(),
      images: images.value.map((i) => i.url),
      startDate: startDate.value,
      hints: hints.value.trim(),
    })
    plan.value = res
    title.value = res.title
    let n = 0
    days.value = res.days.map((d) =>
      d.stops.map((st) => ({
        key: `r${n++}`,
        name: st.name,
        city: st.city,
        kind: st.kind,
        stayMinutes: st.stayMinutes,
        note: st.note,
        candidates: [],
        pick: -1,
        searching: false,
      })),
    )
    await matchAll()
    step.value = 'review'
  } catch (e: any) {
    error.value = e?.message || 'AI 生成失败'
    step.value = 'input'
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 搜索一个地点：先「名称 + 城市」，搜不到再只用名称 */
async function searchRow(r: Row, near: Poi | null) {
  r.searching = true
  try {
    let list = await mapSvc.searchPlaces(r.name, r.city).catch(() => [] as Poi[])
    if (!list.length && r.city) {
      if (store.mapCfg.provider === 'osm') await sleep(1100) // Nominatim 每秒 1 次
      list = await mapSvc.searchPlaces(r.name, '').catch(() => [] as Poi[])
    }
    r.candidates = list.slice(0, 5)
    r.pick = r.candidates.length ? 0 : -1
    // 同名地点：首选离上一个已匹配地点最近的候选
    if (near && r.candidates.length > 1) {
      let best = 0
      let bestD = Infinity
      r.candidates.forEach((c, i) => {
        const d = haversineKm(c, near)
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      if (haversineKm(r.candidates[0], near) > 300) r.pick = best
    }
  } finally {
    r.searching = false
  }
}

/** 逐个匹配全部地点（开源地图有频率限制，按顺序慢慢查） */
async function matchAll() {
  step.value = 'matching'
  await mapSvc.loadMapLib(store.mapCfg.key, store.mapCfg.securityJsCode).catch(() => {})
  const rows = days.value.flat()
  progress.value = { done: 0, total: rows.length }
  let near: Poi | null = null
  for (const r of rows) {
    await searchRow(r, near)
    if (r.pick >= 0) near = r.candidates[r.pick]
    progress.value.done++
    if (store.mapCfg.provider === 'osm') await sleep(1100)
  }
}

function prevMatched(r: Row): Poi | null {
  const rows = days.value.flat()
  for (let i = rows.indexOf(r) - 1; i >= 0; i--) {
    if (rows[i].pick >= 0) return rows[i].candidates[rows[i].pick]
  }
  return null
}

async function retry(r: Row) {
  if (!r.name.trim()) return
  await searchRow(r, prevMatched(r))
  if (r.pick < 0) store.notify(`没找到「${r.name}」，换个更具体的名称试试`, 'error')
}

function removeRow(di: number, r: Row) {
  days.value[di] = days.value[di].filter((x) => x !== r)
}

function create() {
  const out = days.value
    .map((rows) => ({
      stops: rows
        .filter((r) => r.pick >= 0)
        .map((r) => ({ poi: r.candidates[r.pick], kind: r.kind, stayMinutes: r.stayMinutes, note: r.note })),
    }))
    .filter((d) => d.stops.length)
  if (!out.length) {
    store.notify('还没有匹配到任何地点', 'error')
    return
  }
  store.createTripFromPlan(title.value.trim() || 'AI 生成的路书', startDate.value, out)
  store.notify(`已生成路书：${out.length} 天、${out.reduce((a, d) => a + d.stops.length, 0)} 个地点，车程正在计算`)
  emit('close')
}

/** 从第二天起，首站与前一天末站是同一地点：生成时会变成自动接续出发 */
function isContinuation(di: number, r: Row): boolean {
  if (di === 0 || r.pick < 0 || days.value[di][0] !== r) return false
  const prev = [...days.value[di - 1]].reverse().find((x) => x.pick >= 0)
  if (!prev) return false
  const a = prev.candidates[prev.pick]
  const b = r.candidates[r.pick]
  return Math.abs(a.lng - b.lng) < 5e-4 && Math.abs(a.lat - b.lat) < 5e-4
}

function addrOf(p: Poi): string {
  return p.address || p.district || `${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`
}
</script>

<template>
  <div class="modal-backdrop" @click="step === 'input' || step === 'review' ? emit('close') : null">
    <div class="modal-card ai-modal" @click.stop>
      <div class="modal-head">
        <h3>✨ AI 生成路书</h3>
        <button class="modal-close-btn" :disabled="step === 'thinking' || step === 'matching'" @click="emit('close')">✕</button>
      </div>

      <!-- 未配置 / 离线 -->
      <div v-if="!store.hasAi || !online" class="modal-body">
        <p v-if="!online">AI 生成需要联网，请联网后再试。</p>
        <template v-else>
          <p>管理员还没有配置 AI 服务。</p>
          <p v-if="auth.user?.isAdmin" class="muted">
            在「管理后台 → AI 生成路书」里填写接口地址、模型和 API Key 后即可使用。
            <button class="btn-text-action" @click="emit('close'); store.adminOpen = true">去配置</button>
          </p>
          <p v-else class="muted">请联系管理员在后台开启。</p>
        </template>
      </div>

      <!-- 第 1 步：输入 -->
      <div v-else-if="step === 'input'" class="modal-body ai-body">
        <p class="muted ai-desc">
          粘贴小红书 / 公众号攻略、行程单、聊天记录<template v-if="store.aiVision">，或上传截图</template>，AI 会整理成按天的地点；
          也可以只写一句需求，比如「北京出发 5 天内蒙古草原自驾，带老人，每天开车别太久」。
        </p>
        <textarea v-model="text" class="ai-textarea" rows="8" maxlength="12000" placeholder="粘贴攻略内容或描述你的需求…"></textarea>
        <div v-if="store.aiVision" class="ai-images">
          <div v-for="(img, i) in images" :key="i" class="ai-thumb">
            <img :src="img.url" :alt="img.name" />
            <button class="ai-thumb-del" title="移除" @click="images.splice(i, 1)">✕</button>
          </div>
          <button v-if="images.length < MAX_IMAGES" class="ai-add-img" @click="fileInput?.click()">＋ 截图</button>
          <input ref="fileInput" type="file" accept="image/*" multiple style="display: none" @change="onFiles" />
        </div>
        <div class="row2">
          <div class="field">
            <label>出发日期</label>
            <input v-model="startDate" type="date" />
          </div>
          <div class="field">
            <label>补充要求（可选）</label>
            <input v-model="hints" maxlength="300" placeholder="如：从天津出发、只玩 3 天" />
          </div>
        </div>
        <p v-if="error" class="error-text ai-error">{{ error }}</p>
      </div>

      <!-- 第 2 步：等待 -->
      <div v-else-if="step === 'thinking' || step === 'matching'" class="modal-body ai-wait">
        <div class="spinner-ring ai-spinner"></div>
        <template v-if="step === 'thinking'">
          <p>AI 正在阅读和整理行程…</p>
          <p class="muted">通常需要 10~60 秒，请不要关闭页面</p>
        </template>
        <template v-else>
          <p>正在地图上匹配地点 {{ progress.done }} / {{ progress.total }}</p>
          <p v-if="store.mapCfg.provider === 'osm'" class="muted">开源地图搜索每秒只能查一次，请稍候</p>
        </template>
      </div>

      <!-- 第 3 步：核对 -->
      <div v-else class="modal-body ai-body ai-review">
        <div class="field">
          <label>路书名称</label>
          <input v-model="title" maxlength="40" />
        </div>
        <p v-if="plan?.mode === 'plan'" class="ai-plan-warn">
          这是 AI 根据你的需求规划的路线，仅供参考：请核对每个地点是否合适，生成后再看每天的车程是否太长。
        </p>
        <p v-if="plan?.notes" class="muted ai-notes">AI 备注：{{ plan.notes }}</p>

        <div v-for="(rows, di) in days" :key="di" class="ai-day">
          <div class="ai-day-title">第 {{ di + 1 }} 天 <span class="muted">{{ rows.length }} 个地点</span></div>
          <div v-if="!rows.length" class="muted ai-empty">这一天的地点都删掉了，生成时会跳过</div>
          <div v-for="r in rows" :key="r.key" class="ai-row" :class="{ 'ai-row-miss': r.pick < 0 }">
            <select v-model="r.kind" class="ai-kind" :title="KIND_META[r.kind].label">
              <option v-for="k in KIND_OPTIONS" :key="k" :value="k">{{ KIND_META[k].emoji }} {{ KIND_META[k].label }}</option>
            </select>
            <div class="ai-row-main">
              <template v-if="r.pick >= 0">
                <select v-if="r.candidates.length > 1" v-model="r.pick" class="ai-cand">
                  <option v-for="(c, ci) in r.candidates" :key="ci" :value="ci">{{ c.name }} · {{ addrOf(c) }}</option>
                </select>
                <div v-else class="ai-cand-one">{{ r.candidates[0].name }}</div>
                <div v-if="isContinuation(di, r)" class="ai-row-sub ai-row-cont">与前一天终点相同，会自动接续出发</div>
                <div v-else class="ai-row-sub muted">
                  {{ addrOf(r.candidates[r.pick]) }}
                  <template v-if="r.candidates[r.pick].name !== r.name"> · AI 原文「{{ r.name }}」</template>
                </div>
              </template>
              <template v-else>
                <div class="ai-miss-line">
                  <input v-model="r.name" class="ai-miss-input" @keyup.enter="retry(r)" />
                  <button class="btn btn-mini" :disabled="r.searching" @click="retry(r)">{{ r.searching ? '搜索中' : '重搜' }}</button>
                </div>
                <div class="ai-row-sub error-text">地图上没找到，改个更具体的名称重搜，或删掉</div>
              </template>
              <div v-if="r.note" class="ai-row-note muted">{{ r.note }}</div>
            </div>
            <button class="ai-row-del" title="删除这个地点" @click="removeRow(di, r)">✕</button>
          </div>
        </div>
      </div>

      <div v-if="store.hasAi && online && (step === 'input' || step === 'review')" class="modal-foot">
        <template v-if="step === 'input'">
          <button class="btn btn-secondary" @click="emit('close')">取消</button>
          <button class="btn btn-primary" :disabled="!canSubmit" @click="generate">开始生成</button>
        </template>
        <template v-else>
          <span v-if="unmatchedCount" class="muted ai-foot-note">{{ unmatchedCount }} 个没匹配上的地点不会加入</span>
          <button class="btn btn-secondary" @click="step = 'input'">返回修改</button>
          <button class="btn btn-primary" :disabled="!matchedCount" @click="create">生成路书（{{ matchedCount }} 个地点）</button>
        </template>
      </div>
    </div>
  </div>
</template>
