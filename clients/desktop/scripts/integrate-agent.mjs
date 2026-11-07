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

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const run = (command, commandArgs) => execFileSync(command, commandArgs, { cwd: root, stdio: 'inherit' })

run(process.execPath, [path.join(root, 'scripts/import-agent.mjs'), path.resolve(inputs[0])])
const quarantined = listQuarantined(path.join(root, 'src-tauri/resources/agent'))
if (quarantined.length > 0) throw new Error(`Imported Agent still has ${quarantined.length} quarantined file(s), e.g. ${quarantined[0]}`)
console.log('[agent-integrate] 隔离标记已清除')
run(pnpm, ['agent:check'])
run(pnpm, ['check:agent-package'])

if (start) {
  const child = spawn(pnpm, ['tauri', 'dev'], { cwd: root, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
}
