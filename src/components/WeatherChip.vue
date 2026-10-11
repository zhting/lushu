<script setup lang="ts">
import { computed } from 'vue'
import { useTripStore } from '../stores/trip'
import { isBadWeather } from '../services/weather'

/** 当天终点天气（仅在今天起 16 天内的日期有数据） */
const props = defineProps<{ dayId: string; compact?: boolean }>()
const store = useTripStore()
const w = computed(() => store.dayWeather(props.dayId))
const place = computed(() => {
  const d = store.trip?.days.find((x) => x.id === props.dayId)
  return d?.stops[d.stops.length - 1]?.name ?? ''
})
</script>

<template>
  <span
    v-if="w"
    class="weather-chip"
    :class="{ 'weather-bad': isBadWeather(w.code), compact }"
    :title="`${place}：${w.text}，${w.tMin}~${w.tMax}℃${w.precipProb != null ? '，降水概率 ' + w.precipProb + '%' : ''}`"
  >
    <span class="weather-icon">{{ w.icon }}</span>
    <template v-if="!compact">{{ w.text }} </template>{{ w.tMin }}~{{ w.tMax }}℃
    <template v-if="!compact && w.precipProb != null && w.precipProb >= 30"> · 降水 {{ w.precipProb }}%</template>
  </span>
</template>
