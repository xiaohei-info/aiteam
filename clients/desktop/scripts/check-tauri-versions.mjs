// `tauri build` 要求 npm 侧 @tauri-apps/api、@tauri-apps/plugin-* 与 Cargo.lock 里对应 crate 的
// major.minor 一致，否则直接拒绝打包。CI 平时只编译和测试、不打包，这里提前把不一致拦下来。
// 只比对已安装的 npm 包版本（和 tauri CLI 的判断口径一致），需要先 pnpm install。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @tauri-apps/api → tauri；@tauri-apps/plugin-x → tauri-plugin-x；其它包不参与比对。 */
export function crateFor(npmName) {
  if (npmName === '@tauri-apps/api') return 'tauri'
  if (npmName.startsWith('@tauri-apps/plugin-')) return npmName.replace('@tauri-apps/plugin-', 'tauri-plugin-')
  return null
}

/** Cargo.lock 里同名 crate 可能有多个版本，全部收集。 */
export function parseCargoLock(text) {
  const versions = new Map()
  for (const block of text.split('[[package]]').slice(1)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1]
    const version = block.match(/^version = "([^"]+)"$/m)?.[1]
    if (!name || !version) continue
    versions.set(name, [...(versions.get(name) ?? []), version])
  }
  return versions
}

const majorMinor = (version) => version.split('.').slice(0, 2).join('.')

/** 返回不一致的说明；空数组表示全部对齐。 */
export function findMismatches(npmVersions, crateVersions) {
  const problems = []
  for (const [npmName, npmVersion] of npmVersions) {
    const crate = crateFor(npmName)
    if (!crate) continue
    const candidates = crateVersions.get(crate) ?? []
    if (candidates.length === 0) {
      problems.push(`${npmName} ${npmVersion}: Cargo.lock 里没有 ${crate}`)
    } else if (!candidates.some((version) => majorMinor(version) === majorMinor(npmVersion))) {
      problems.push(`${npmName} ${npmVersion} 与 ${crate} ${candidates.join(' / ')} 的 major.minor 不一致`)
    }
  }
  return problems
}

function installedNpmVersions() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => crateFor(name))
  return new Map(names.map((name) => {
    const installed = JSON.parse(readFileSync(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'))
    return [name, installed.version]
  }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const npmVersions = installedNpmVersions()
  const crateVersions = parseCargoLock(readFileSync(path.join(repoRoot, 'src-tauri', 'Cargo.lock'), 'utf8'))
  const problems = findMismatches(npmVersions, crateVersions)
  if (problems.length) {
    console.error('Tauri npm 包与 Rust crate 版本不一致，tauri build 会拒绝打包：')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('请把两侧升级到相同的 major.minor（package.json + pnpm-lock.yaml，或 Cargo.toml + Cargo.lock）。')
    process.exit(1)
  }
  console.log(`Tauri 版本一致：${[...npmVersions].map(([name, version]) => `${name}@${version}`).join(', ')}`)
}
