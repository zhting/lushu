import type { StopKind } from './types'

export interface SamplePoi {
  name: string
  address: string
  lng: number
  lat: number
  kind?: StopKind
  stay?: number
}

export const SAMPLE_TITLE = '示例 · 京北草原 3 日大环线'

export const SAMPLE_DAYS: {
  departTime: string
  start?: SamplePoi
  waypoints?: SamplePoi[]
  end?: SamplePoi
}[] = [
  // Day 1: 北京 -> 八达岭长城 -> 野狐岭（草原天路西入口） -> 张北草原
  {
    departTime: '08:00',
    start: {
      name: '天安门广场',
      address: '北京市东城区东长安街',
      lng: 116.397428,
      lat: 39.90923,
      kind: 'waypoint',
    },
    waypoints: [
      {
        name: '八达岭长城',
        address: '北京市延庆区G6京藏高速58号出口',
        lng: 116.024067,
        lat: 40.354188,
        kind: 'scenic',
        stay: 150,
      },
      {
        name: '野狐岭要塞旅游区',
        address: '河北省张家口市张北县野狐岭（草原天路西入口）',
        lng: 114.968,
        lat: 41.088,
        kind: 'scenic',
        stay: 90,
      },
    ],
    end: {
      name: '张北草原（住宿）',
      address: '河北省张家口市张北县兴和西路',
      lng: 114.715,
      lat: 41.156,
      kind: 'hotel',
    },
  },
  // Day 2: 横贯草原天路 -> 桦皮岭 -> 沽源闪电湖 -> 丰宁大滩草原
  {
    departTime: '08:30',
    waypoints: [
      {
        name: '桦皮岭景区',
        address: '河北省张家口市崇礼区与张北县交界（草原天路东入口）',
        lng: 115.352,
        lat: 41.025,
        kind: 'scenic',
        stay: 90,
      },
      {
        name: '闪电湖湿地公园',
        address: '河北省张家口市沽源县城北菇南线',
        lng: 115.765,
        lat: 41.745,
        kind: 'scenic',
        stay: 90,
      },
      {
        name: '大汗行宫景区',
        address: '河北省承德市丰宁满族自治县大滩镇扎拉营村',
        lng: 116.035,
        lat: 41.608,
        kind: 'scenic',
        stay: 90,
      },
    ],
    end: {
      name: '丰宁大滩草原（住宿）',
      address: '河北省承德市丰宁满族自治县大滩镇草原路',
      lng: 116.012,
      lat: 41.579,
      kind: 'hotel',
    },
  },
  // Day 3: 南下白河峡谷风景大道 -> 怀柔雁栖湖 -> 奥林匹克森林公园 -> 回到北京天安门（环线闭环）
  {
    departTime: '08:30',
    waypoints: [
      {
        name: '雁栖湖风景区',
        address: '北京市怀柔区怀北镇雁水路3号',
        lng: 116.678,
        lat: 40.395,
        kind: 'scenic',
        stay: 120,
      },
      {
        name: '奥林匹克森林公园',
        address: '北京市朝阳区科荟路33号',
        lng: 116.391,
        lat: 40.016,
        kind: 'scenic',
        stay: 60,
      },
    ],
    end: {
      name: '天安门广场（环线终点）',
      address: '北京市东城区东长安街',
      lng: 116.397428,
      lat: 39.90923,
      kind: 'waypoint',
    },
  },
]
