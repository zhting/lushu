<script setup lang="ts">
import { ref } from 'vue'
import { useTripStore } from '../stores/trip'

const store = useTripStore()
const key = ref('')
const securityJsCode = ref('')

function useOsm() {
  store.applyProvider('osm')
}

function useAmap() {
  store.applyProvider('amap', key.value, securityJsCode.value)
}

function close() {
  store.gateOpen = false
}
</script>

<template>
  <div class="center-screen">
    <div class="gate-card">
      <h1>🚗 路书 · 自驾行程规划</h1>
      <p class="desc">选择地图数据源，之后可随时在顶栏「数据源」切换。</p>

      <div class="provider-cards">
        <div class="provider-card">
          <div class="p-title">🌍 开源地图 <span class="chip">推荐测试用</span></div>
          <p class="muted">Leaflet + OpenStreetMap 瓦片，POI 搜索用 Nominatim。</p>
          <ul class="p-list">
            <li>✅ 无需申请任何 Key，打开即用</li>
            <li>⚠️ 国内地点数据较稀疏，搜索结果有限</li>
          </ul>
          <button class="btn btn-primary" @click="useOsm">使用开源地图开始</button>
        </div>

        <div class="provider-card">
          <div class="p-title">🇨🇳 高德地图 <span class="chip">正式模式</span></div>
          <p class="muted">国内地点数据与搜索质量更好，结果更准确。</p>
          <div class="field">
            <label>高德 Key（类型须为「Web端(JS API)」）</label>
            <input v-model="key" placeholder="在 console.amap.com 申请" autocomplete="off" />
          </div>
          <div class="field">
            <label>安全密钥 securityJsCode（2021-12-02 后申请的 Key 必填）</label>
            <input v-model="securityJsCode" placeholder="与该 Key 配套的 jscode" autocomplete="off" />
          </div>
          <button class="btn" :disabled="!key.trim()" @click="useAmap">使用高德地图</button>
        </div>
      </div>

      <details class="steps">
        <summary>如何申请高德 Key？</summary>
        <ol>
          <li>打开 <a href="https://console.amap.com/dev/key/app" target="_blank" rel="noopener">console.amap.com</a> 并注册 / 实名认证；</li>
          <li>「应用管理 → 创建新应用」，然后点「添加 Key」；</li>
          <li>服务平台务必选择 <b>Web端(JS API)</b>；</li>
          <li>如系统生成了安全密钥 jscode，把它一并填到上面；</li>
          <li>正式上线前，在该 Key 的设置里配置域名白名单。</li>
        </ol>
      </details>

      <p class="muted" style="margin: 10px 0 0">
        ⚠️ 两种地图坐标系不同（开源 WGS-84 / 高德 GCJ-02），切换数据源后同一坐标可能显示偏移数百米，请勿混用。
      </p>
      <button class="btn btn-block" style="margin-top: 8px" @click="close">
        取消，返回当前地图
      </button>
    </div>
  </div>
</template>
