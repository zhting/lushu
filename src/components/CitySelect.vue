<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { COMMON_CITIES } from '../constants'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const open = ref(false)
const q = ref('')
const root = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

const filtered = computed(() => {
  const kw = q.value.trim()
  if (!kw) return COMMON_CITIES
  return COMMON_CITIES.filter((c) => c.includes(kw))
})

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
      <input ref="searchInput" v-model="q" class="city-search" placeholder="搜索城市" autocomplete="off" @keydown.esc="open = false" />
      <ul class="city-list">
        <li :class="{ active: !modelValue }" @click="choose('')">不限城市</li>
        <li v-for="c in filtered" :key="c" :class="{ active: c === modelValue }" @click="choose(c)">{{ c }}</li>
        <li v-if="!filtered.length" class="muted city-empty">未找到城市</li>
      </ul>
    </div>
  </div>
</template>
