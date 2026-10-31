import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
try {
  await mkdir(new URL('../assets/runtime/', import.meta.url), { recursive: true })
  const spineSource = await readFile(new URL('../node_modules/@esotericsoftware/spine-pixi-v8/dist/Spine.js', import.meta.url), 'utf8')
  const license = spineSource.slice(0, spineSource.indexOf('*/') + 2)
  if (!license.includes('Spine Runtimes License Agreement')) throw new Error('Spine runtime license header missing')
  await writeFile(new URL('../assets/runtime/SPINE-LICENSE.txt', import.meta.url), license + '\n')
  await build({ absWorkingDir: root, entryPoints: ['src/employee-runtime.js'], outfile: 'assets/runtime/employees.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline', banner: { js: license } })
  console.log('Built local Pixi/Spine employee runtime, preserving the Spine license notice.')
} catch (error) {
  console.error(`Employee runtime build failed: ${error.message}`)
  process.exitCode = 1
}
