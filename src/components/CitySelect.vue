<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { COMMON_CITIES, CHINA_CITIES } from '../constants'
import * as mapSvc from '../services/map'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const open = ref(false)
const q = ref('')
const root = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const searching = ref(false)
const remoteResults = ref<Array<{ name: string; sub?: string }>>([])
let timer = 0
let seq = 0

// 本地快速前缀/包含过滤
const localMatches = computed(() => {
  const kw = q.value.trim()
  if (!kw) {
    return COMMON_CITIES.map((c) => ({ name: c, sub: '' }))
  }
  const prefix: Array<{ name: string; sub?: string }> = []
  const contains: Array<{ name: string; sub?: string }> = []
  for (const c of CHINA_CITIES) {
    if (c === kw) {
      prefix.unshift({ name: c })
    } else if (c.startsWith(kw)) {
      prefix.push({ name: c })
    } else if (c.includes(kw)) {
      contains.push({ name: c })
    }
  }
  return [...prefix, ...contains]
})

// 合并本地与高德远程检索结果
const displayList = computed(() => {
  const kw = q.value.trim()
  if (!kw) return localMatches.value

  const list: Array<{ name: string; sub?: string }> = []
  const seen = new Set<string>()

  // 优先高德精确检索结果
  for (const r of remoteResults.value) {
    if (!seen.has(r.name)) {
      seen.add(r.name)
      list.push(r)
    }
  }

  // 补充本地全国城市库匹配
  for (const l of localMatches.value) {
    if (!seen.has(l.name)) {
      seen.add(l.name)
      list.push(l)
    }
  }

  return list
})

function onSearchInput() {
  window.clearTimeout(timer)
  const kw = q.value.trim()
  if (!kw) {
    remoteResults.value = []
    searching.value = false
    return
  }

  // 防抖并发调用高德地图实时城市/区县搜索
  timer = window.setTimeout(async () => {
    const id = ++seq
    searching.value = true
    try {
      const res = await mapSvc.searchCities(kw)
      if (id !== seq) return
      remoteResults.value = res.map((item) => ({
        name: item.name,
        sub: item.province ? item.province.replace(/省|市|自治区/g, '') : '',
      }))
    } catch {
      // 容错降级
    } finally {
      if (id === seq) searching.value = false
    }
  }, 200)
}

function choose(v: string) {
  emit('update:modelValue', v)
  open.value = false
}

function onDocClick(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}

watch(open, async (v) => {
  if (v) {
    document.addEventListener('click', onDocClick)
    await nextTick()
    searchInput.value?.focus()
  } else {
    document.removeEventListener('click', onDocClick)
    q.value = ''
    remoteResults.value = []
    searching.value = false
  }
})

onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="root" class="city-select">
    <button type="button" class="city-select-btn" :title="modelValue ? `当前城市：${modelValue}` : '不限城市'" @click="open = !open">
      <span>{{ modelValue || '不限城市' }}</span>
      <span class="city-caret">▾</span>
    </button>
    <div v-if="open" class="city-pop">
      <div class="city-search-wrap">
        <input
          ref="searchInput"
          v-model="q"
          class="city-search"
          placeholder="搜索城市 / 区县"
          autocomplete="off"
          @input="onSearchInput"
          @keydown.esc="open = false"
        />
        <span v-if="searching" class="city-search-spinner" title="高德实时搜索中">⚡</span>
      </div>
      <ul class="city-list">
        <li :class="{ active: !modelValue }" @click="choose('')">不限城市</li>
        <li
          v-for="c in displayList"
          :key="c.name"
          :class="{ active: c.name === modelValue }"
          @click="choose(c.name)"
        >
          <div class="city-item-main">
            <span class="city-name">{{ c.name }}</span>
            <span v-if="c.sub" class="city-sub">{{ c.sub }}</span>
          </div>
        </li>
        <li v-if="!displayList.length && !searching" class="muted city-empty">未找到城市</li>
      </ul>
    </div>
  </div>
</template>
