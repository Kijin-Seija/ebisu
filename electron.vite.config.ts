import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [vue()],
    // 固定本地开发页面的端口；被占用时直接报错，避免悄悄切换到其他端口。
    server: { port: 4175, strictPort: true }
  }
})
