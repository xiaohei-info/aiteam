import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { archiveAgentNode, restoreAgentNode } from '../scripts/agent-runtime.mjs'

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiteam-runtime-test-'))
  mkdirSync(path.join(directory, 'runtime'))
  const bytes = Buffer.from('published node executable bytes')
  const manifest = { files: [{ path: 'runtime/node', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
  const filename = path.join(directory, 'runtime/node')
  writeFileSync(filename, bytes)
  return { directory, bytes, manifest, filename }
}

test('repository runtime archive restores exact bytes and executable permissions', () => {
  const f = fixture()
  try {
    archiveAgentNode(f.directory, f.manifest)
    unlinkSync(f.filename)
    restoreAgentNode(f.directory, f.manifest)
    assert.deepEqual(readFileSync(f.filename), f.bytes)
    assert.equal(statSync(f.filename).mode & 0o777, 0o755)
    restoreAgentNode(f.directory, f.manifest)
    assert.deepEqual(readFileSync(f.filename), f.bytes)
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})

test('mismatched archive is rejected before creating a runtime executable', () => {
  const f = fixture()
  try {
    archiveAgentNode(f.directory, f.manifest)
    unlinkSync(f.filename)
    f.manifest.files[0].sha256 = '0'.repeat(64)
    assert.throws(() => restoreAgentNode(f.directory, f.manifest), /integrity/)
    assert.equal(existsSync(f.filename), false)
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})

test('a modified executable cannot be silently accepted or published', () => {
  const f = fixture()
  try {
    writeFileSync(f.filename, 'modified')
    assert.throws(() => restoreAgentNode(f.directory, f.manifest), /integrity/)
    assert.throws(() => archiveAgentNode(f.directory, f.manifest), /integrity/)
    assert.equal(existsSync(`${f.filename}.gz`), false)
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})
