import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  // Electron 运行在 sandbox preload 时不会替我们解析 app.asar 里的外部
  // CommonJS 依赖。将 preload 做成单文件 bundle，避免安装后出现
  // `Unable to load preload script` / `module not found`。
  preload: {
    build: {
      externalizeDeps: false,
      isolatedEntries: true
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      },
      dedupe: ['@codemirror/state', '@codemirror/view', 'codemirror']
    },
    plugins: [react(), tailwindcss()]
  }
})
