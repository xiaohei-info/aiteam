// One step from a downloaded Agent artifact to a running desktop app:
// import (quarantine stripped before the package enters the project) → verify → package checks → optional `tauri dev`.
// Usage: pnpm agent:integrate <artifact.zip | package.tar.gz | package-directory> [--start]
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listQuarantined } from './quarantine.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const start = args.includes('--start')
const inputs = args.filter((arg) => arg !== '--start')
if (inputs.length !== 1) throw new Error('Usage: pnpm agent:integrate <artifact.zip | package.tar.gz | package-directory> [--start]')

const windows = process.platform === 'win32'
const pnpm = windows ? 'pnpm.cmd' : 'pnpm'
// Node refuses to spawn .cmd files without a shell (CVE-2024-27980). Every pnpm argument below is a fixed literal,
// so the shell never sees user input.
const pnpmOptions = { cwd: root, stdio: 'inherit', shell: windows }
const run = (command, commandArgs, options = { cwd: root, stdio: 'inherit' }) => execFileSync(command, commandArgs, options)

run(process.execPath, [path.join(root, 'scripts/import-agent.mjs'), path.resolve(inputs[0])])
const quarantined = listQuarantined(path.join(root, 'src-tauri/resources/agent'))
if (quarantined.length > 0) throw new Error(`Imported Agent still has ${quarantined.length} download-marked file(s), e.g. ${quarantined[0]}`)
console.log(windows ? '[agent-integrate] 下载来源标记（Zone.Identifier）已清除' : '[agent-integrate] 隔离标记已清除')
run(pnpm, ['agent:check'], pnpmOptions)
run(pnpm, ['check:agent-package'], pnpmOptions)

if (start) {
  const child = spawn(pnpm, ['tauri', 'dev'], pnpmOptions)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
}
