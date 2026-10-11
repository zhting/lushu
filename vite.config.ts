import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    // PWA：可安装到桌面 / 主屏幕；应用外壳预缓存，离线也能打开。
    // 路书数据由前端自己存到本地（见 services/offline.ts），这里不缓存 /api。
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'images/logo.png'],
      manifest: {
        name: '小鹿路书 · 自驾行程规划',
        short_name: '小鹿路书',
        description: '按天规划自驾行程：地点、车程、到达时间、费用与地图',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f5f8fc',
        theme_color: '#1d68f5',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,jpg,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: '/index.html',
        // 接口与分享视频不走前端路由回退
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // 开源地图瓦片：只缓存看过的区域（OSM 瓦片使用政策不允许批量预下载）
            urlPattern: /^https:\/\/tile\.openstreetmap\.org\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: { maxEntries: 3000, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    // 开发模式下后端 API 走本地 3000 端口
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
