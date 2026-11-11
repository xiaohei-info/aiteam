import { execFileSync } from 'node:child_process'

export const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine'
export const ZONE_IDENTIFIER_STREAM = 'Zone.Identifier'

// Files extracted from a downloaded artifact inherit the download's origin mark. macOS then assesses every flagged
// binary and native module on first launch, which delays the bundled Agent past the host's 30s readiness limit.
// Windows records the same fact as a Zone.Identifier alternate data stream (Mark of the Web) that SmartScreen and
// antivirus scanners act on; CopyFile carries the stream along, so it must be removed from the staged copy too.
// The package root is passed through the environment so PowerShell never parses it as code.
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command']
const MARKED_ROOT_ENV = 'AITEAM_MARKED_ROOT'
const LIST_ZONE_MARKED = `Get-ChildItem -LiteralPath $env:${MARKED_ROOT_ENV} -Recurse -File -Force | Where-Object { Get-Item -LiteralPath $_.FullName -Stream ${ZONE_IDENTIFIER_STREAM} -ErrorAction SilentlyContinue } | ForEach-Object { $_.FullName }`
const STRIP_ZONE_MARKS = `Get-ChildItem -LiteralPath $env:${MARKED_ROOT_ENV} -Recurse -File -Force | Unblock-File`

function powershell(script, target, run) {
  return run('powershell.exe', [...POWERSHELL_ARGS, script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, [MARKED_ROOT_ENV]: target },
  })
}

const lines = output => String(output ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)

/** Files under `target` that still carry a download mark. Platforms without such a mark return nothing. */
export function listQuarantined(target, { platform = process.platform, run = execFileSync } = {}) {
  if (platform === 'darwin') {
    return lines(run('find', [target, '-xattrname', QUARANTINE_ATTRIBUTE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  }
  if (platform === 'win32') return lines(powershell(LIST_ZONE_MARKED, target, run))
  return []
}

export function stripQuarantine(target, { platform = process.platform, run = execFileSync } = {}) {
  if (platform === 'darwin') run('xattr', ['-dr', QUARANTINE_ATTRIBUTE, target])
  else if (platform === 'win32') powershell(STRIP_ZONE_MARKS, target, run)
  else return
  const remaining = listQuarantined(target, { platform, run })
  if (remaining.length > 0) {
    const mark = platform === 'win32' ? ZONE_IDENTIFIER_STREAM : QUARANTINE_ATTRIBUTE
    throw new Error(`Failed to remove ${mark} from ${remaining.length} file(s), e.g. ${remaining[0]}`)
  }
}
