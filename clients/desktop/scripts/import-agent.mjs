import { archiveAgentNode } from './agent-runtime.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAgentPackage } from './check-agent.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const input = process.argv[2]
if (!input) throw new Error('Usage: pnpm agent:import <artifact.zip | package.tar.gz | package-directory>')
const source = path.resolve(input)
const temporary = mkdtempSync(path.join(tmpdir(), 'aiteam-agent-import-'))
const destination = path.join(root, 'src-tauri/resources/agent')

try {
  let packageDirectory = source
  if (source.endsWith('.zip')) {
    execFileSync('unzip', ['-q', source, '-d', temporary])
    const archives = readdirSync(temporary).filter((name) => name.endsWith('-darwin-arm64.tar.gz'))
    if (archives.length !== 1) throw new Error('Expected one darwin-arm64.tar.gz inside the artifact')
    packageDirectory = path.join(temporary, archives[0])
  }
  if (packageDirectory.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xzf', packageDirectory, '-C', temporary])
    const directories = readdirSync(temporary, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    if (directories.length !== 1) throw new Error('Expected one Agent package directory')
    packageDirectory = path.join(temporary, directories[0].name)
  }
  const manifest = checkAgentPackage(packageDirectory)
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
