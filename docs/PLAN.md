# Web 版自驾路书 · 项目规划文档

> 状态：M1 原型已实现（本仓库）。已支持双地图数据源：开源（Leaflet + OSM + OSRM + Nominatim，免 Key，用于测试）与高德（正式模式），坐标随数据源为 WGS-84 / GCJ-02，切换时自动重算。M2 起按本规划推进。

## 一、核心概念

路书按三层组织：

- **路书（Trip）**：一次完整的自驾行程，包含名称、出发日期、天数、同行人、车辆信息。
- **日程（Day）**：每天一段，有起点、终点、途经点。每天的终点通常就是当晚住宿，因此「设置终点」和「选择住宿」合并为一个动作——这是这类产品体验上的关键点。
- **地点（Stop）**：每天路线上的点，分为途经点、景点、住宿、加油/充电、餐饮等类型，带计划到达时间和停留时长。

## 二、功能范围

**MVP（第一版）**

1. 创建路书：名称、出发日期、天数，天数可随时增减。
2. 逐日设置起点和终点，自动继承前一天的终点。
3. 添加途经点并拖拽排序，路线实时重算。
4. 路线计算：每天的里程、预计驾驶时长、过路费，汇总成全程统计。
5. 地图展示：全程总览（每天一种颜色）和单日详情两种视图。
6. 地点搜索：按关键词搜索景点和住宿，一键加入当天。
7. 每日时间轴：出发时间加上驾驶和停留时长，推算每个点的到达时间，驾驶超过阈值（默认 8 小时）时提醒。
8. ~~账号与云端保存~~（M1 以 localStorage + JSON 导入导出过渡，账号云同步在 M2 实现）

**第二版**

- 分享只读链接，导出 PDF 或图片版路书
- 多人协作编辑
- 一键跳转高德或百度 App 导航（按天或按段）
- 沿途加油站、充电桩（电车续航规划）
- 天气预报、备注、费用记账
- PWA 离线查看已保存的路书

## 三、主要用户流程

```
新建路书 → 设定出发日期/天数
   ↓
Day 1：选起点（定位/搜索）→ 选终点（搜索酒店或城市）
   ↓ 自动计算路线，地图展示
添加途经景点（搜索 / 地图点选）→ 拖拽排序
   ↓
Day 2：起点自动继承 → 重复
   ↓
总览：全程地图 + 每日里程/时长表 → 分享/导出/导航
```

## 四、数据模型

当前实现（前端）：

```
Trip(title, startDate, policy, driveWarnMinutes, days[])
Day(id, departTime, startAuto, start: Stop|null, end: Stop|null, waypoints: Stop[], note)
Stop(id, type[start|end|waypoint], kind[waypoint|scenic|hotel|food|fuel],
     name, lng, lat, address, stayMinutes, note)
RouteMeta(day → status, hash, distanceM, durationS, tolls)   # 内存 + localStorage
pathCache(hash → polyline)                                    # 折线按 hash 缓存，不进响应式
```

规划中的服务端模型（M2）：

```
User(id, name, phone/email)
Trip(id, owner_id, title, start_date, day_count, vehicle_type, cover, share_token)
Day(id, trip_id, day_index, date, depart_time, note)
Stop(id, day_id, order, type, name, lng, lat, address, poi_id, stay_minutes, note)
RouteCache(day_id, stops_hash, distance_m, duration_s, tolls, polyline, strategy)
```

`RouteCache` 用当天所有点的坐标和顺序算哈希，点没变就不重复调用地图 API——该策略已在 M1 前端实现，M2 平移到服务端即可。

## 五、技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | Vue 3 + Vite + TypeScript | 一套响应式代码适配 PC 和移动端（已采用） |
| UI | Tailwind 风格自写样式 | M1 未引入组件库，保持轻量；后续可评估 Element Plus / Vant |
| 状态 | Pinia | 编辑时本地乐观更新，异步持久化（已采用） |
| 地图 | 高德地图 JS API 2.0 + Web 服务 API | 驾车路径规划、POI 搜索、周边搜索、逆地理编码（已采用） |
| 后端 | Node.js（NestJS）或 Go | M2：代理地图 Web 服务、鉴权、缓存 |
| 数据库 | PostgreSQL（可加 PostGIS） | 行程数据是结构化的，关系型最合适 |
| 部署 | 前端 CDN + 后端容器 | 国内上线需要 ICP 备案 |

> 起步阶段也可先用 Supabase / 云开发类 BaaS，功能稳定后再迁移自建后端。

**地图与坐标系**：主要面向国内自驾，选高德。国内地图使用 GCJ-02 坐标，与 GPS 的 WGS-84 混用会偏移；本项目所有存储坐标统一 GCJ-02，导入 GPX 等外部轨迹时先做转换。

## 六、地图集成要点

1. **Key 安全**：JS API 的 Key 在前端使用，需配置安全密钥（securityJsCode）或走代理；路径规划、POI 搜索等 Web 服务调用在 M2 移到后端代理，不暴露 Key。
2. **路线计算**：每天调用一次驾车路径规划，传入起点、终点和途经点（上限 16 个）。策略：最快 / 最短 / 少收费（JS API 支持），不走高速等更多策略在 Web 服务版开放。
3. **路线展示**：折线按天着色，`setFitView` 自动适配视野；总览合并显示所有天。
4. **景点与住宿定位**：关键词搜索（M1 已有）；终点周边搜酒店、沿途搜索（沿折线每隔若干公里取点做周边搜索、结果去重）在 M3 实现。
5. **配额控制**：搜索防抖、路线结果缓存、拖拽结束才请求——均已在 M1 落地。

## 七、PC 与移动端布局

- **PC**：左右分栏。左侧日程列表（按天切换，内含可拖拽的地点卡片），右侧大地图。点击某天，地图聚焦到那天。
- **移动端**：地图在上（44vh），下方日程面板滚动；顶栏显示全程统计。
- **通用**：地点支持搜索 / 地图点选 / 定位三种添加方式；导航按钮（URI 唤起高德/百度 App）在 M3 添加。

## 八、核心接口（M2 服务端）

```
POST   /trips                     创建路书
GET    /trips/:id                 获取路书（含 days、stops、路线缓存）
PATCH  /trips/:id/days/:dayId     修改当天信息
PUT    /days/:dayId/stops         批量保存当天地点及顺序
POST   /days/:dayId/route         计算或刷新当天路线（先查缓存）
GET    /places/search?kw=&city=   POI 搜索（代理）
GET    /places/around?lng=&lat=&type=hotel   周边搜索（代理）
POST   /trips/:id/share           生成分享链接
```

## 九、里程碑（1～2 名开发者估算）

| 阶段 | 周期 | 交付 | 状态 |
|---|---|---|---|
| M1 原型 | 1 周 | 地图接入（开源+高德双数据源），多天起终点、途经点排序、路线计算与展示、时间轴、本地存储、响应式 | ✅ 已完成（开源模式全流程实测通过） |
| M2 MVP | 3～4 周 | 账号与云端保存、POI 代理与周边搜索、时间轴分段精确化、分享链接 | 待启动 |
| M3 完善 | 2～3 周 | 全程总览增强、导出 PDF/图片、App 导航跳转、沿途推荐 | 待启动 |
| M4 增强 | 按需 | 协作编辑、充电规划、天气、PWA 离线 | 待启动 |

## 十、主要风险

- **地图 API 配额和商用授权**：上线前确认所选服务商的个人或企业配额和商用条款，以官网最新说明为准。
- **沿途搜索调用量大**：采样点不要太密，结果要缓存。
- **移动端性能**：长路线折线点很多，展示前要抽稀（当前折线存缓存层、不进响应式，已缓解一部分）。
- **坐标系混用**：从第三方导入 GPX 等轨迹时要做 WGS-84 → GCJ-02 转换。
