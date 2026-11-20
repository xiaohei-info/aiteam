import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import path from 'node:path'

// Agent package targets the desktop app can bundle. Each target fixes the inner archive format produced by
// scripts/build-agent-package.mjs and the bundled Node executable the host launches (see src-tauri/src/agent.rs).
export const DESKTOP_AGENT_TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({ archive: 'tar.gz', runtime: 'runtime/node' }),
  'win32-x64': Object.freeze({ archive: 'zip', runtime: 'runtime/node.exe' }),
})

/** The target a package must have to run on this host. Throws on hosts the desktop app does not support. */
export function hostAgentTarget({ platform = process.platform, arch = process.arch } = {}) {
  const target = `${platform}-${arch}`
  if (!Object.hasOwn(DESKTOP_AGENT_TARGETS, target)) {
    throw new Error(`The desktop app bundles ${Object.keys(DESKTOP_AGENT_TARGETS).join(' or ')} Agent packages; this host is ${target}.`)
  }
  return target
}

export function agentTargetSpec(target) {
  if (!Object.hasOwn(DESKTOP_AGENT_TARGETS, target)) throw new Error(`Unsupported desktop Agent target: ${target}`)
  return DESKTOP_AGENT_TARGETS[target]
}

/** Path of the bundled Node executable inside a package, relative to the package root. */
export function agentRuntimePath(target) {
  return agentTargetSpec(target).runtime
}

/**
 * Extract one archive with the tools each host ships: Windows 10+ has bsdtar (tar.exe, reads zip) but no unzip.
 * The Agent zip ends with an empty-name entry and stores backslash-separated names, so bsdtar skips that entry and
 * exits 1 even though the extraction succeeded; Windows therefore expands through Windows PowerShell instead.
 */
export function extractArchive(
  archive,
  into,
  { platform = process.platform, run = execFileSync, systemRoot = process.env.SystemRoot ?? 'C:\\Windows' } = {},
) {
  if (platform === 'win32') {
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    // Autoload of Microsoft.PowerShell.Archive breaks when PSModulePath is polluted (for example by a
    // PowerShell 7 install), and Windows PowerShell honors a Restricted execution policy, so load the module
    // Windows ships explicitly and bypass the policy for this one call.
    const module = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules', 'Microsoft.PowerShell.Archive', 'Microsoft.PowerShell.Archive.psd1')
    const quote = value => `'${value.replaceAll("'", "''")}'`
    run(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Import-Module ${quote(module)} -Force; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(into)} -Force`,
    ])
  } else if (archive.endsWith('.zip')) {
    run('unzip', ['-q', archive, '-d', into])
  } else {
    run('tar', ['-xzf', archive, '-C', into])
  }
}

const isArchive = name => name.endsWith('.zip') || name.endsWith('.tar.gz')

/**
 * Turn the input of `agent:import` into an extracted package directory. Accepts a package directory, the package
 * archive (`aiteam-agent-<version>-<target>.tar.gz|zip`), or the CI artifact zip that wraps that archive. A package
 * built for another target is rejected here instead of failing later on a missing runtime.
 */
export function unpackAgentArtifact(source, workDirectory, target, { extract = extractArchive } = {}) {
  const spec = agentTargetSpec(target)
  let current = source
  for (let layer = 0; layer < 2 && isArchive(current); layer++) {
    const into = mkdtempSync(path.join(workDirectory, 'layer-'))
    extract(current, into)
    const entries = readdirSync(into, { withFileTypes: true }).filter(entry => entry.name !== '__MACOSX')
    const inner = entries.filter(entry => entry.isFile() && entry.name.endsWith(`-${target}.${spec.archive}`))
    const directories = entries.filter(entry => entry.isDirectory())
    if (directories.length === 1 && inner.length === 0) return path.join(into, directories[0].name)
    if (inner.length !== 1 || directories.length !== 0) {
      throw new Error(`Expected one ${target} Agent package (*-${target}.${spec.archive} or a package directory) inside ${path.basename(current)}`)
    }
    current = path.join(into, inner[0].name)
  }
  if (isArchive(current)) throw new Error(`Agent artifact is nested too deeply: ${path.basename(current)}`)
  return current
}
