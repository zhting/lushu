import type { StopKind } from './types'

export interface SamplePoi {
  name: string
  address: string
  lng: number
  lat: number
  kind?: StopKind
  stay?: number
}

export const SAMPLE_TITLE = '示例 · 京北草原 3 日自驾'

export const SAMPLE_DAYS: {
  departTime: string
  start?: SamplePoi
  waypoints?: SamplePoi[]
  end?: SamplePoi
}[] = [
  {
    departTime: '08:00',
    start: { name: '天安门广场', address: '北京市东城区东长安街', lng: 116.397428, lat: 39.90923 },
    waypoints: [
      {
        name: '八达岭长城',
        address: '北京市延庆区京藏高速58号出口',
        lng: 116.024067,
        lat: 40.354188,
        kind: 'scenic',
        stay: 150,
      },
    ],
    end: { name: '张家口市（住宿）', address: '河北省张家口市桥西区', lng: 114.884, lat: 40.824, kind: 'hotel' },
  },
  {
    departTime: '08:30',
    waypoints: [
      {
        name: '野狐岭要塞旅游区',
        address: '河北省张家口市张北县',
        lng: 114.968,
        lat: 41.088,
        kind: 'scenic',
        stay: 90,
      },
    ],
    end: { name: '锡林浩特市（住宿）', address: '内蒙古锡林郭勒盟锡林浩特市', lng: 116.087, lat: 43.944, kind: 'hotel' },
  },
  {
    departTime: '08:00',
    waypoints: [
      {
        name: '达里诺尔湖',
        address: '内蒙古赤峰市克什克腾旗',
        lng: 116.76,
        lat: 43.281,
        kind: 'scenic',
        stay: 120,
      },
    ],
    end: { name: '西乌珠穆沁旗（住宿）', address: '内蒙古锡林郭勒盟西乌珠穆沁旗', lng: 117.61, lat: 44.59, kind: 'hotel' },
  },
]
