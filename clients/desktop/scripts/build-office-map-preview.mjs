/**
 * 打包地图预览页（public/office-map-preview.js）。
 * 用法：node scripts/build-office-map-preview.mjs
 * 用 vite 的 build API，避免额外依赖；产物只用于本地核对渲染效果。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  await build({
    configFile: false,
    root,
    publicDir: false,
    logLevel: 'warn',
    resolve: { alias: { '@': path.join(root, 'src') } },
    build: {
      outDir: 'public/office-preview',
      emptyOutDir: true,
      minify: false,
      target: 'es2022',
      lib: {
        entry: path.join(root, 'src/scene/office/officeMap/preview.ts'),
        formats: ['es'],
        fileName: () => 'office-map-preview.js',
      },
      rollupOptions: { output: { entryFileNames: 'office-map-preview.js' } },
    },
  })
  console.log('Built public/office-preview/office-map-preview.js')
} catch (error) {
  console.error(`预览页打包失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
