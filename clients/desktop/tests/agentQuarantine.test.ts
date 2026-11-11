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

test('is a no-op on platforms without a download mark', () => {
  const run = () => {
    throw new Error('must not run')
  }
  assert.deepEqual(listQuarantined('/pkg', { platform: 'linux', run }), [])
  assert.doesNotThrow(() => stripQuarantine('/pkg', { platform: 'linux', run }))
})

type RunCall = { command: string; args: string[]; env?: Record<string, string | undefined> }

function windowsRunner(remainingAfterStrip: string) {
  const calls: RunCall[] = []
  let stripped = false
  const run = (command: string, args: readonly string[] = [], options: { env?: Record<string, string | undefined> } = {}) => {
    calls.push({ command, args: [...args], env: options.env })
    const script = args.at(-1) ?? ''
    if (script.includes('Unblock-File')) {
      stripped = true
      return ''
    }
    return stripped ? remainingAfterStrip : 'C:\\pkg\\runtime\\node.exe\r\nC:\\pkg\\manifest.json\r\n'
  }
  return { calls, run }
}

test('Windows lists files still carrying the Zone.Identifier download mark', () => {
  const { calls, run } = windowsRunner('')
  assert.deepEqual(listQuarantined('C:\\pkg', { platform: 'win32', run }), ['C:\\pkg\\runtime\\node.exe', 'C:\\pkg\\manifest.json'])
  assert.equal(calls[0].command, 'powershell.exe')
  assert.match(calls[0].args.at(-1) ?? '', /-Stream Zone\.Identifier/)
})

test('Windows unblocks the whole tree and passes the path through the environment, not the script', () => {
  const target = "C:\\Users\\a'; Remove-Item -Recurse C:\\ ;'\\pkg"
  const { calls, run } = windowsRunner('')
  stripQuarantine(target, { platform: 'win32', run })
  assert.equal(calls.length, 2, 'unblock, then verify')
  for (const call of calls) {
    assert.equal(call.command, 'powershell.exe')
    assert.equal(call.env?.AITEAM_MARKED_ROOT, target)
    assert.ok(!(call.args.at(-1) ?? '').includes(target), 'the package path must never be interpolated into PowerShell code')
  }
  assert.match(calls[0].args.at(-1) ?? '', /Unblock-File/)
})

test('Windows fails loudly when a Zone.Identifier mark survives', () => {
  const { run } = windowsRunner('C:\\pkg\\runtime\\node.exe\r\n')
  assert.throws(() => stripQuarantine('C:\\pkg', { platform: 'win32', run }), /Zone\.Identifier from 1 file\(s\), e\.g\. C:\\pkg\\runtime\\node\.exe/)
})
