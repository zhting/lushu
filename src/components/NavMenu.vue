<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { amapNavUrl, baiduNavUrl, type NavPoint } from '../services/nav'

/** 一键导航：from 为空时以手机当前位置为起点 */
const props = defineProps<{ from: NavPoint | null; to: NavPoint; label?: string }>()
const store = useTripStore()
const open = ref(false)

const amap = computed(() => amapNavUrl(props.from, props.to, store.mapCfg.provider))
const baidu = computed(() => baiduNavUrl(props.from, props.to, store.mapCfg.provider))

function toggle(e: MouseEvent) {
  e.stopPropagation()
  open.value = !open.value
  if (open.value) window.addEventListener('click', close, { once: true })
}

function close() {
  open.value = false
}

onBeforeUnmount(() => window.removeEventListener('click', close))
</script>

<template>
  <span class="nav-menu" @click.stop>
    <button type="button" class="nav-btn" :title="`导航到「${to.name}」`" @click="toggle">
      <svg viewBox="0 0 24 24" class="nav-btn-icon" fill="currentColor"><path d="M21.71 11.29l-9-9a1 1 0 00-1.42 0l-9 9a1 1 0 000 1.42l9 9a1 1 0 001.42 0l9-9a1 1 0 000-1.42zM14 14.5V12h-4v3H8v-4a1 1 0 011-1h5V7.5l3.5 3.5-3.5 3.5z"/></svg>
      {{ label ?? '导航' }}
    </button>
    <span v-if="open" class="dropdown-popover nav-popover">
      <a class="popover-item" :href="amap" target="_blank" rel="noopener" @click="close">高德地图</a>
      <a class="popover-item" :href="baidu" target="_blank" rel="noopener" @click="close">百度地图</a>
    </span>
  </span>
</template>
