import { archiveAgentNode } from './agent-runtime.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostAgentTarget, unpackAgentArtifact } from './agent-target.mjs'
import { checkAgentPackage } from './check-agent.mjs'
import { stripQuarantine } from './quarantine.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const input = process.argv[2]
if (!input) throw new Error('Usage: pnpm agent:import <artifact.zip | package.tar.gz | package-directory>')
const source = path.resolve(input)
const temporary = mkdtempSync(path.join(tmpdir(), 'aiteam-agent-import-'))
const destination = path.join(root, 'src-tauri/resources/agent')

try {
  // The imported runtime is launched on this machine, so only a package for this host is accepted.
  const target = hostAgentTarget()
  const packageDirectory = unpackAgentArtifact(source, temporary, target)
  const manifest = checkAgentPackage(packageDirectory, { target })
  for (const entry of manifest.files) {
    const filename = path.resolve(packageDirectory, entry.path)
    if (!filename.startsWith(`${packageDirectory}${path.sep}`)) throw new Error(`Invalid manifest path: ${entry.path}`)
    const bytes = readFileSync(filename)
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Agent package integrity check failed: ${entry.path}`)
    }
  }
  const staging = `${destination}.importing`
  if (existsSync(staging)) throw new Error(`Remove the previous incomplete import first: ${staging}`)
  cpSync(packageDirectory, staging, { recursive: true, dereference: false })
  // Only replace the disposable bundled runtime; user data is stored outside the project.
  archiveAgentNode(staging, manifest)
  // Downloaded artifacts mark every extracted file (macOS quarantine, Windows Zone.Identifier); the first launch
  // would then exceed the readiness limit.
  stripQuarantine(staging)
  rmSync(destination, { recursive: true, force: true })
  renameSync(staging, destination)
  console.log(`Imported Agent ${manifest.version} (${manifest.target}) to ${destination}`)
  // The artifact carries the production template, which neither starts nor passes check:agent-package. There is
  // currently a single environment, so bake the config `pnpm tauri dev` uses; otherwise every import would need a
  // manual agent:configure before the app can be built.
  if (!manifest.configured) {
    execFileSync(process.execPath, [path.join(root, 'scripts/configure-agent-package.mjs'), path.join(root, 'config/agent/taiyi-test.env')], { stdio: 'inherit' })
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
