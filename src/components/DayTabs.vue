<script setup lang="ts">
import { useTripStore } from '../stores/trip'
import { DAY_COLORS } from '../constants'
import { dateOfDay, fmtDate } from '../services/geo'

const store = useTripStore()

function statusMark(dayId: string): string {
  const r = store.routes[dayId]
  if (!r) return ''
  if (r.status === 'pending') return '⏳'
  if (r.status === 'error') return '❗'
  if (store.overDrive(dayId)) return '⚠️'
  if (r.status === 'done') return '✓'
  return ''
}
</script>

<template>
  <div v-if="store.trip" class="tabs">
    <button class="tab" :class="{ active: store.view === 'overview' }" @click="store.view = 'overview'">
      📊 总览
    </button>
    <button
      v-for="(d, i) in store.trip.days"
      :key="d.id"
      class="tab"
      :class="{ active: store.view === d.id }"
      @click="store.view = d.id"
    >
      <span class="dot" :style="{ background: DAY_COLORS[i % DAY_COLORS.length] }"></span>
      D{{ i + 1 }}
      <span v-if="statusMark(d.id)" class="warn-dot">{{ statusMark(d.id) }}</span>
      <span v-else class="muted" style="font-size: 11px">{{ fmtDate(dateOfDay(store.trip!.startDate, i)).slice(0, 5) }}</span>
    </button>
    <button
      class="tab"
      title="增加一天"
      @click="store.setDayCount(store.trip!.days.length + 1)"
    >＋</button>
  </div>
</template>
