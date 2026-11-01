import assert from 'node:assert/strict'
import test from 'node:test'
import { crateFor, findMismatches, parseCargoLock } from '../scripts/check-tauri-versions.mjs'

const lock = `
[[package]]
name = "tauri"
version = "2.12.5"

[[package]]
name = "tauri-plugin-store"
version = "2.5.1"

[[package]]
name = "tauri-plugin-store"
version = "2.4.0"
`

test('npm Tauri packages map to their crates; other packages are ignored', () => {
  assert.equal(crateFor('@tauri-apps/api'), 'tauri')
  assert.equal(crateFor('@tauri-apps/plugin-notification'), 'tauri-plugin-notification')
  assert.equal(crateFor('@tauri-apps/cli'), null)
  assert.equal(crateFor('react'), null)
})

test('matching major.minor passes, patch differences are fine', () => {
  const crates = parseCargoLock(lock)
  assert.deepEqual(crates.get('tauri-plugin-store'), ['2.5.1', '2.4.0'])
  assert.deepEqual(findMismatches(new Map([['@tauri-apps/api', '2.12.4'], ['@tauri-apps/plugin-store', '2.5.0']]), crates), [])
})

test('the 2026-10-31 mismatch (api 2.11 vs tauri 2.12) and a missing crate are reported', () => {
  const problems = findMismatches(new Map([['@tauri-apps/api', '2.11.0'], ['@tauri-apps/plugin-dialog', '2.8.4']]), parseCargoLock(lock))
  assert.equal(problems.length, 2)
  assert.match(problems[0], /@tauri-apps\/api 2\.11\.0 与 tauri 2\.12\.5/)
  assert.match(problems[1], /没有 tauri-plugin-dialog/)
})
