<script setup lang="ts">
import { ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { cityOfAddress, cnOrdinal, dateOfDay, fmtDate } from '../services/geo'
import DayEditor from './DayEditor.vue'

const store = useTripStore()
const activeMenuDayId = ref<string | null>(null)

/** 头部路线摘要：起点城市 → 终点城市（无地点时回退为日期） */
function routeLabel(i: number): string {
  const d = store.trip?.days[i]
  if (!d || !d.stops.length) return ''
  const a = cityOfAddress(d.stops[0].address)
  const b = cityOfAddress(d.stops[d.stops.length - 1].address)
  if (!a && !b) return ''
  if (!b || a === b) return a || b
  return `${a} → ${b}`
}

function toggleDay(id: string) {
  store.view = store.view === id ? '' : id
}

function toggleDayMenu(dayId: string, e: MouseEvent) {
  e.stopPropagation()
  activeMenuDayId.value = activeMenuDayId.value === dayId ? null : dayId
}

function handleAddDay() {
  if (!store.trip) return
  store.setDayCount(store.trip.days.length + 1)
}
</script>

<template>
  <div v-if="store.trip" class="days-container" @click="activeMenuDayId = null">
    <div class="day-cards-list">
      <section
        v-for="(d, i) in store.trip.days"
        :key="d.id"
        class="day-card"
        :class="{ 'day-card-open': store.view === d.id }"
      >
        <!-- 手风琴头部 -->
        <div
          class="day-card-header"
          :class="{ open: store.view === d.id }"
          role="button"
          @click="toggleDay(d.id)"
        >
          <!-- 装饰性山峦水墨底纹 -->
          <div class="day-header-deco">
            <img src="/images/day_landscape.jpg" alt="山水装饰" class="day-deco-img" />
          </div>

          <!-- 徽标：D1（正圆形亮蓝填充）, D2（灰色圆形） -->
          <div class="day-circle-badge" :class="{ 'day-circle-active': store.view === d.id }">
            D{{ i + 1 }}
          </div>

          <!-- 标题与日期：第一天 10-02 周五 -->
          <div class="day-title-info">
            <span class="day-title-text">第{{ cnOrdinal(i + 1) }}天</span>
            <span class="day-date-text">{{ fmtDate(dateOfDay(store.trip.startDate, i)) }}</span>
            <span v-if="routeLabel(i) && store.view !== d.id" class="day-route-summary">
              📍 {{ routeLabel(i) }}
            </span>
          </div>

          <div style="flex: 1"></div>

          <!-- 折叠小尖角（设计图清晰为向上/向下细线箭头） -->
          <div class="toggle-arrow" :class="{ 'arrow-up': store.view === d.id }">
            <svg class="chevron-svg" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clip-rule="evenodd" />
            </svg>
          </div>
        </div>

        <!-- 手风琴展开内容：DayEditor -->
        <div v-if="store.view === d.id" class="day-card-body">
          <DayEditor :day-id="d.id" />
        </div>
      </section>
    </div>

    <!-- 底部悬浮大胶囊按钮：「＋ 增加一天」 -->
    <div class="add-day-floating-wrap">
      <button class="floating-add-day-btn" @click="handleAddDay">
        <span class="plus-icon">＋</span>
        <span class="btn-label">增加一天</span>
      </button>
    </div>
  </div>
</template>
