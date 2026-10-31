import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Explicit local TEST configuration; never edits the imported release package.
// Keep production Agent configuration and its JWKS delivery independent.
if (process.platform !== 'darwin') throw new Error('This installer currently supports macOS only')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'config/agent/taiyi-test.env')
const destination = path.join(homedir(), 'Library/Application Support/com.aiteam.desktop/agent.env')
const contents = readFileSync(source, 'utf8')
mkdirSync(path.dirname(destination), { recursive: true })
if (existsSync(destination) && readFileSync(destination, 'utf8') !== contents) {
  const backup = `${destination}.backup-${Date.now()}`
  copyFileSync(destination, backup)
  console.log(`Previous config preserved: ${backup}`)
}
writeFileSync(destination, contents, { mode: 0o600 })
// The env references its public JWKS by a path relative to the config file.
const jwksName = /^AITEAM_AGENT_JWKS_PATH=(.+)$/mu.exec(contents)?.[1]?.trim()
if (jwksName) {
  if (path.isAbsolute(jwksName) || jwksName.split(/[\\/]/u).includes('..')) throw new Error('AITEAM_AGENT_JWKS_PATH must be a relative path inside the config directory')
  copyFileSync(path.join(path.dirname(source), jwksName), path.join(path.dirname(destination), jwksName))
}
console.log(`Installed local TEST config: ${destination}`)
console.log('Manager: http://121.40.78.201:8782; real Manager login, real JWT verification with the bundled public keys, no fake model.')
console.log('Restart AIFred to apply. This profile is not a production configuration.')
