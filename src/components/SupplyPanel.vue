<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { bestInsertIndex, searchAlong, SUPPLY_META, type AlongResult, type SupplyKind } from '../services/along'

/** 沿途补给：终点附近住宿、沿线加油 / 充电 / 服务区，一键插入当天路线 */
const props = defineProps<{ dayId: string }>()
const store = useTripStore()

const active = ref<SupplyKind | null>(null)
const loading = ref(false)
const error = ref('')
const results = ref<AlongResult[]>([])
const added = ref<Set<string>>(new Set())
let seq = 0

const day = computed(() => store.trip?.days.find((d) => d.id === props.dayId) ?? null)

/** 燃油车先显示加油，电车先显示充电 */
const kinds = computed<SupplyKind[]>(() =>
  store.vehicle.energy === 'ev' ? ['hotel', 'charge', 'services', 'fuel'] : ['hotel', 'fuel', 'services', 'charge'],
)

function keyOf(r: AlongResult) {
  return `${r.poi.lng.toFixed(5)},${r.poi.lat.toFixed(5)}`
}

async function run(kind: SupplyKind) {
  if (active.value === kind && !loading.value) {
    active.value = null // 再点一次收起
    return
  }
  const d = day.value
  if (!d || !d.stops.length) return
  const id = ++seq
  active.value = kind
  loading.value = true
  error.value = ''
  results.value = []
  try {
    const list = await searchAlong({
      kind,
      stops: d.stops,
      path: store.legPaths[d.id],
      provider: store.mapCfg.provider,
      amapKey: store.mapCfg.key,
      amapSecurityJsCode: store.mapCfg.securityJsCode,
    })
    if (id !== seq) return
    results.value = list
    if (!list.length) error.value = kind === 'hotel' ? '终点附近没有找到住宿' : '沿线没有找到结果'
  } catch (e: any) {
    if (id !== seq) return
    error.value = e?.message || '搜索失败'
  } finally {
    if (id === seq) loading.value = false
  }
}

function add(r: AlongResult) {
  const d = day.value
  if (!d || !active.value) return
  // 插入位置在搜索后可能已变化（中途加过别的点），按当前节点重新计算更稳妥
  const kind = active.value
  const at = kind === 'hotel' ? d.stops.length : bestInsertIndex(d.stops, r.poi)
  store.insertStop(d.id, r.poi, SUPPLY_META[kind].stopKind, at)
  added.value = new Set(added.value).add(keyOf(r))
  store.notify(`已加入「${r.poi.name}」`)
}

function posText(r: AlongResult): string {
  if (active.value === 'hotel') return `距终点 ${r.offKm < 1 ? Math.round(r.offKm * 1000) + ' 米' : r.offKm.toFixed(1) + ' km'}`
  const off = r.offKm < 1 ? `${Math.round(r.offKm * 1000)} 米` : `${r.offKm.toFixed(1)} km`
  return `沿途第 ${Math.round(r.alongKm)} km · 离路线 ${off}`
}
</script>

<template>
  <div v-if="day && day.stops.length" class="supply-panel">
    <div class="supply-head">
      <span class="supply-title">沿途补给</span>
      <div class="chip-group">
        <button
          v-for="k in kinds"
          :key="k"
          type="button"
          class="chip"
          :class="{ 'chip-active': active === k }"
          :disabled="k !== 'hotel' && day.stops.length < 2"
          @click="run(k)"
        >
          {{ SUPPLY_META[k].icon }} {{ k === 'hotel' ? '终点住宿' : SUPPLY_META[k].label.replace('沿途', '') }}
        </button>
      </div>
    </div>

    <div v-if="active" class="supply-body">
      <div v-if="loading" class="supply-status muted">正在搜索{{ SUPPLY_META[active].label }}…</div>
      <div v-else-if="error" class="supply-status error-text">{{ error }}</div>
      <ul v-else class="supply-list">
        <li v-for="r in results" :key="keyOf(r)">
          <div class="supply-item-body">
            <div class="supply-name">{{ r.poi.name }}</div>
            <div class="supply-meta muted">{{ posText(r) }}<template v-if="r.poi.address"> · {{ r.poi.address }}</template></div>
          </div>
          <button
            type="button"
            class="btn btn-mini"
            :disabled="added.has(keyOf(r))"
            @click="add(r)"
          >
            {{ added.has(keyOf(r)) ? '已加入' : '＋ 加入' }}
          </button>
        </li>
      </ul>
      <p v-if="!loading && results.length" class="supply-foot muted">
        {{ active === 'hotel' ? '加入后放在当天最后，作为当晚住宿。' : '加入时自动插在绕路最少的两站之间。' }}
        <template v-if="store.mapCfg.provider !== 'amap'">数据来自 OpenStreetMap，国内覆盖不全，仅供参考。</template>
      </p>
    </div>
  </div>
</template>
