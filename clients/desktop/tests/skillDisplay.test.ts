import assert from 'node:assert/strict'
import test from 'node:test'
import { skillDisplayName, skillDisplayNames } from '../src/lib/skillDisplay.ts'

test('skill display prefers signed display_name and falls back to the bare skill id', () => {
  const details = [{ ref: 'research@v1', display_name: '资料调研' }, { ref: 'review@2', display_name: null }]
  assert.equal(skillDisplayName('research@v1', details), '资料调研')
  assert.equal(skillDisplayName('review@2', details), 'review')
  assert.equal(skillDisplayName('plain'), 'plain')
  assert.equal(skillDisplayName('@scoped'), '@scoped')
  assert.deepEqual(skillDisplayNames(['research@v1', 'review@2', 'review@3'], details), ['资料调研', 'review'])
  assert.deepEqual(skillDisplayNames(undefined), [])
})
