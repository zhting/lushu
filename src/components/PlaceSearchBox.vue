<script setup lang="ts">
import { ref, watch } from 'vue'
import { searchPlaces } from '../services/map'
import type { Poi } from '../types'

const props = defineProps<{ placeholder?: string }>()
const emit = defineEmits<{ (e: 'select', poi: Poi): void }>()

const kw = ref('')
const searching = ref(false)
const results = ref<Poi[]>([])
const error = ref('')
const done = ref(false)

let timer = 0

watch(kw, () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(doSearch, 400) // 防抖，节省配额
})

async function doSearch() {
  const q = kw.value.trim()
  if (q.length < 2) {
    results.value = []
    error.value = ''
    done.value = false
    return
  }
  searching.value = true
  error.value = ''
  try {
    results.value = await searchPlaces(q)
    done.value = true
  } catch (e: any) {
    results.value = []
    error.value = e?.message || '搜索失败'
  } finally {
    searching.value = false
  }
}
</script>

<template>
  <div class="search-box">
    <input v-model="kw" :placeholder="props.placeholder || '输入名称搜索地点…'" autocomplete="off" />
    <div v-if="searching" class="search-status">搜索中…</div>
    <div v-else-if="error" class="search-status error-text">{{ error }}</div>
    <div v-else-if="done && !results.length" class="search-status">无结果，换个关键词试试</div>
    <ul v-if="results.length" class="results">
      <li v-for="p in results" :key="`${p.lng},${p.lat},${p.name}`" @click="emit('select', p)">
        <div class="r-name">{{ p.name }}</div>
        <div class="r-addr">{{ p.address || p.district }}</div>
      </li>
    </ul>
  </div>
</template>
