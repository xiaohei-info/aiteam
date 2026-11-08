import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { agentRuntimePath, extractArchive, hostAgentTarget, unpackAgentArtifact } from '../scripts/agent-target.mjs'

test('host target covers the macOS ARM and Windows x64 desktop builds only', () => {
  assert.equal(hostAgentTarget({ platform: 'darwin', arch: 'arm64' }), 'darwin-arm64')
  assert.equal(hostAgentTarget({ platform: 'win32', arch: 'x64' }), 'win32-x64')
  assert.throws(() => hostAgentTarget({ platform: 'linux', arch: 'x64' }), /this host is linux-x64/)
  assert.throws(() => hostAgentTarget({ platform: 'darwin', arch: 'x64' }), /darwin-x64/)
})

test('each target launches its own bundled Node executable', () => {
  assert.equal(agentRuntimePath('darwin-arm64'), 'runtime/node')
  assert.equal(agentRuntimePath('win32-x64'), 'runtime/node.exe')
  assert.throws(() => agentRuntimePath('win32-arm64'), /Unsupported/)
})

test('Windows extracts with System32 bsdtar, never unzip or a PATH tar', () => {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const run = (command: string, args: readonly string[] = []) => {
    calls.push({ command, args })
    return ''
  }
  extractArchive('C:\\dl\\a.zip', 'C:\\tmp\\x', { platform: 'win32', run })
  assert.match(calls[0].command, /System32[\\/]tar\.exe$/i)
  assert.deepEqual(calls[0].args, ['-xf', 'C:\\dl\\a.zip', '-C', 'C:\\tmp\\x'])
  extractArchive('/dl/a.zip', '/tmp/x', { platform: 'darwin', run })
  extractArchive('/dl/a.tar.gz', '/tmp/x', { platform: 'darwin', run })
  assert.deepEqual(calls.slice(1).map((call) => call.command), ['unzip', 'tar'])
})

// Fake extractor: each archive name maps to the entries it "contains".
function fakeExtract(layout: Record<string, Array<{ name: string; directory?: boolean }>>) {
  return (archive: string, into: string) => {
    for (const entry of layout[path.basename(archive)] ?? []) {
      if (entry.directory) mkdirSync(path.join(into, entry.name))
      else writeFileSync(path.join(into, entry.name), '')
    }
  }
}

function withWork(fn: (work: string) => void) {
  const work = mkdtempSync(path.join(tmpdir(), 'aiteam-agent-target-test-'))
  try { fn(work) } finally { rmSync(work, { recursive: true, force: true }) }
}

test('CI artifact zip → Windows package zip → package directory', () => {
  withWork((work) => {
    const extract = fakeExtract({
      'aiteam-agent-win32-x64.zip': [{ name: 'aiteam-agent-0.1.0-win32-x64.zip' }],
      'aiteam-agent-0.1.0-win32-x64.zip': [{ name: 'aiteam-agent-0.1.0-win32-x64', directory: true }],
    })
    const directory = unpackAgentArtifact('/dl/aiteam-agent-win32-x64.zip', work, 'win32-x64', { extract })
    assert.equal(path.basename(directory), 'aiteam-agent-0.1.0-win32-x64')
  })
})

test('CI artifact zip → macOS package tar.gz → package directory, ignoring __MACOSX', () => {
  withWork((work) => {
    const extract = fakeExtract({
      'aiteam-agent-darwin-arm64.zip': [{ name: 'aiteam-agent-0.1.0-darwin-arm64.tar.gz' }, { name: '__MACOSX', directory: true }],
      'aiteam-agent-0.1.0-darwin-arm64.tar.gz': [{ name: 'aiteam-agent-0.1.0-darwin-arm64', directory: true }],
    })
    const directory = unpackAgentArtifact('/dl/aiteam-agent-darwin-arm64.zip', work, 'darwin-arm64', { extract })
    assert.equal(path.basename(directory), 'aiteam-agent-0.1.0-darwin-arm64')
  })
})

test('a package directory is used as is', () => {
  assert.equal(unpackAgentArtifact('/pkg/aiteam-agent-0.1.0-win32-x64', '/unused', 'win32-x64', { extract: () => assert.fail('must not extract') }), '/pkg/aiteam-agent-0.1.0-win32-x64')
})

test('an artifact built for another platform is rejected before import', () => {
  withWork((work) => {
    const extract = fakeExtract({ 'aiteam-agent-darwin-arm64.zip': [{ name: 'aiteam-agent-0.1.0-darwin-arm64.tar.gz' }] })
    assert.throws(() => unpackAgentArtifact('/dl/aiteam-agent-darwin-arm64.zip', work, 'win32-x64', { extract }), /Expected one win32-x64 Agent package/)
  })
})
