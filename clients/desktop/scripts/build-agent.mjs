// 从本仓库 server/agent_service 源码构建随包 Agent，并导入 src-tauri/resources/agent。
// 随包 Agent 不入库：前后端在同一个提交里，打包时现场构建，版本自然一致。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostAgentTarget } from './agent-target.mjs'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(desktopRoot, '../..')
// The package bundles a native Node runtime and native modules, so it is built on the platform it ships for.
const target = hostAgentTarget()

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
const agentPackageJson = path.join(repoRoot, 'server/agent_service/package.json')
let sourceVersion
try {
  sourceVersion = JSON.parse(readFileSync(agentPackageJson, 'utf8')).version
} catch (error) {
  throw new Error(`Cannot read the Agent version from ${agentPackageJson}: ${error.message}`, { cause: error })
}
// 版本带上源码提交号；Agent 或 Agent 前端有未提交改动时标 dirty，方便排查装的是哪份代码。
const dirty = git('status', '--porcelain', '--', 'server/agent_service', 'web') ? '.dirty' : ''
const version = `${sourceVersion}-src.${git('rev-parse', '--short=8', 'HEAD')}${dirty}`

const out = path.join(repoRoot, 'dist/agent-packages')
const passthrough = process.argv.slice(2) // 例如 --skip-build、--node-runtime <path>
execFileSync(process.execPath, [path.join(repoRoot, 'scripts/build-agent-package.mjs'), '--target', target, '--version', version, '--out', out, ...passthrough], { stdio: 'inherit' })
execFileSync(process.execPath, [path.join(desktopRoot, 'scripts/import-agent.mjs'), path.join(out, `aiteam-agent-${version}-${target}`)], { stdio: 'inherit' })
