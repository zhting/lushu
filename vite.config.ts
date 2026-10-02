import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    host: true,
    // 开发模式下后端 API 走本地 3000 端口
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
