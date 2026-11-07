import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { listQuarantined, QUARANTINE_ATTRIBUTE, stripQuarantine } from '../scripts/quarantine.mjs'

const macOnly = { skip: process.platform !== 'darwin' && 'quarantine attributes only exist on macOS' }

function quarantinedTree() {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiteam-quarantine-test-'))
  mkdirSync(path.join(directory, 'runtime'))
  mkdirSync(path.join(directory, 'node_modules/native'), { recursive: true })
  const files = ['runtime/node', 'node_modules/native/addon.node', 'manifest.json'].map((name) => path.join(directory, name))
  for (const file of files) {
    writeFileSync(file, 'bytes')
    execFileSync('xattr', ['-w', QUARANTINE_ATTRIBUTE, '0083;00000000;Chrome;', file])
  }
  return { directory, files }
}

test('lists every quarantined file in a downloaded package tree', macOnly, () => {
  const { directory, files } = quarantinedTree()
  try {
    assert.deepEqual(listQuarantined(directory).sort(), files.sort())
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('strips quarantine from the whole tree so the Agent starts without first-launch assessment', macOnly, () => {
  const { directory } = quarantinedTree()
  try {
    stripQuarantine(directory)
    assert.deepEqual(listQuarantined(directory), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('fails loudly when quarantine cannot be removed', () => {
  const run = (command: string) => (command === 'find' ? '/pkg/runtime/node\n' : '')
  assert.throws(() => stripQuarantine('/pkg', { platform: 'darwin', run }), /1 file\(s\), e\.g\. \/pkg\/runtime\/node/)
})

test('is a no-op outside macOS', () => {
  const run = () => {
    throw new Error('must not run')
  }
  assert.deepEqual(listQuarantined('/pkg', { platform: 'win32', run }), [])
  assert.doesNotThrow(() => stripQuarantine('/pkg', { platform: 'linux', run }))
})
