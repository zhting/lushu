import type { StopKind } from './types'

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

// 选点页城市下拉：'' 表示不限城市
export const COMMON_CITIES = [
  '北京', '上海', '广州', '深圳', '天津', '杭州', '南京', '苏州', '成都', '重庆',
  '西安', '武汉', '长沙', '郑州', '济南', '青岛', '大连', '哈尔滨', '沈阳', '长春',
  '厦门', '福州', '昆明', '贵阳', '桂林', '三亚', '海口', '西宁', '兰州', '乌鲁木齐',
  '拉萨', '呼和浩特', '太原', '石家庄', '合肥', '南昌', '南宁', '宁波', '无锡', '珠海',
]
