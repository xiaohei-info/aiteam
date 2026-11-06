import { execFileSync } from 'node:child_process'

export const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine'

// Files extracted from a downloaded artifact inherit the download's quarantine flag. macOS then assesses every
// flagged binary and native module on first launch, which delays the bundled Agent past the host's 30s readiness
// limit. Only macOS has the flag; other platforms have nothing to strip.
export function listQuarantined(target, { platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'darwin') return []
  const output = run('find', [target, '-xattrname', QUARANTINE_ATTRIBUTE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return output.split('\n').filter(Boolean)
}

export function stripQuarantine(target, { platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'darwin') return
  run('xattr', ['-dr', QUARANTINE_ATTRIBUTE, target])
  const remaining = listQuarantined(target, { platform, run })
  if (remaining.length > 0) {
    throw new Error(`Failed to remove ${QUARANTINE_ATTRIBUTE} from ${remaining.length} file(s), e.g. ${remaining[0]}`)
  }
}
