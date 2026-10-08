import { DEFAULT_RENDERER_PORT } from "./src/shared/proxy-contract";
import { FONT_STYLES_ORIGIN, FONT_FILES_ORIGIN, FONT_STYLESHEET_URL } from "./src/shared/window-contract";
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
      license: { fileName: 'third-party-licenses.md' },
      externalizeDeps: false,
      isolatedEntries: true
    }
  },
  renderer: {
    build: { license: { fileName: 'third-party-licenses.md' } },
    css: {
      postcss: {
        plugins: [{
          postcssPlugin: 'electron-font-formats',
          Declaration: {
            src(declaration) {
              // Chromium supports WOFF2; retain every family, weight and unicode subset.
              if (declaration.parent?.type !== 'atrule' || declaration.parent.name !== 'font-face') return
              if (/format\(["']woff2(?:-variations)?["']\)/.test(declaration.value)) {
                declaration.value = declaration.value.replace(/,\s*url\([^)]*\)\s*format\(["'](?:woff|truetype|opentype)["']\)/g, '')
              }
            }
          }
        }]
      }
    },
    server: { port: DEFAULT_RENDERER_PORT },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      },
      dedupe: ['@codemirror/state', '@codemirror/view', 'codemirror']
    },
    plugins: [react(), tailwindcss(), {
      name: 'shared-font-endpoints',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html
          .replaceAll('__FONT_STYLES_ORIGIN__', FONT_STYLES_ORIGIN)
          .replaceAll('__FONT_FILES_ORIGIN__', FONT_FILES_ORIGIN)
          .replaceAll('__FONT_STYLESHEET_URL__', FONT_STYLESHEET_URL)
      }
    }]
  }
})
