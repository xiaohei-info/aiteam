import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PORTALS, safePortalUrl } from '../src/lib/portals.ts'

test('portals expose the three fixed management entries', () => {
  assert.deepEqual(PORTALS.map(portal => portal.url), [
    'http://121.40.78.201:8781/',
    'http://121.40.78.201:8782/',
    'http://121.40.78.201:8783/',
  ])
})

test('safePortalUrl accepts known portals and rejects everything else', () => {
  for (const portal of PORTALS) assert.equal(safePortalUrl(portal.url), portal.url)
  assert.throws(() => safePortalUrl('http://evil.example/'))
  assert.throws(() => safePortalUrl('javascript:alert(1)'))
  assert.throws(() => safePortalUrl('http://user:pw@121.40.78.201:8781/'))
})

test('portal keys stay in sync with the native allowlist', () => {
  const rust = readFileSync(new URL('../src-tauri/src/external_links.rs', import.meta.url), 'utf8')
  for (const portal of PORTALS) assert.ok(rust.includes(`("${portal.key}", "${portal.url}")`), portal.key)
})
