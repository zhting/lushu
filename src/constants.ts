import type { RoutePolicy, StopKind } from './types'

export const KIND_META: Record<StopKind, { label: string; emoji: string; stay: number }> = {
  waypoint: { label: '途经', emoji: '📍', stay: 0 },
  scenic: { label: '景点', emoji: '🏞️', stay: 120 },
  hotel: { label: '住宿', emoji: '🏨', stay: 0 },
  food: { label: '餐饮', emoji: '🍜', stay: 60 },
  fuel: { label: '加油/充电', emoji: '⛽', stay: 20 },
}

export const KIND_OPTIONS: StopKind[] = ['waypoint', 'scenic', 'food', 'fuel', 'hotel']

// 每天一条路线一种颜色
export const DAY_COLORS = [
  '#2563eb', '#d97706', '#059669', '#dc2626', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5',
]

// 单日节点上限（高德驾车途经点 ≤16、OSRM 演示服务同样适用）
export const MAX_STOPS = 16

export const POLICY_OPTIONS: { value: RoutePolicy; label: string }[] = [
  { value: 'fastest', label: '速度最快' },
  { value: 'shortest', label: '距离最短' },
  { value: 'leastFee', label: '少收费' },
]

export const DEFAULT_DRIVE_WARN_MINUTES = 480 // 8 小时
