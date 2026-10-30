import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

function verify(bytes, manifest) {
  const entry = manifest.files.find(file => file.path === 'runtime/node')
  if (!entry || bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error('Agent Node integrity check failed; restore the matching runtime/node.gz and manifest.json')
  }
}

// Gitee's current repository does not support LFS. Store a lossless gzip under
// its single-file limit and restore the exact published executable before use.
export function restoreAgentNode(directory, manifest) {
  const filename = path.join(directory, 'runtime/node')
  if (existsSync(filename)) {
    verify(readFileSync(filename), manifest)
    chmodSync(filename, 0o755)
    return
  }
  const entry = manifest.files.find(file => file.path === 'runtime/node')
  if (!entry || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error('Invalid Agent Node manifest entry')
  const bytes = gunzipSync(readFileSync(`${filename}.gz`), { maxOutputLength: entry.size })
  verify(bytes, manifest)
  const temporary = `${filename}.restoring-${process.pid}`
  writeFileSync(temporary, bytes, { mode: 0o755 })
  renameSync(temporary, filename)
}

export function archiveAgentNode(directory, manifest) {
  const filename = path.join(directory, 'runtime/node')
  const bytes = readFileSync(filename)
  verify(bytes, manifest)
  writeFileSync(`${filename}.gz`, gzipSync(bytes, { level: 9 }))
}
