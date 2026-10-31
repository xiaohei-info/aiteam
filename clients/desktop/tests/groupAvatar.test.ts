import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { GROUP_AVATAR_MAX_MEMBERS, resolveGroupAvatarItems } from '../src/lib/groupAvatar.ts'
import type { GroupMember } from '../src/lib/groupRoster.ts'

function member(
  employeeId: string,
  displayName: string,
  avatarUrl: string | null = null,
  profileAvailable = true,
): GroupMember {
  return {
    employee_id: employeeId,
    member_ref_id: employeeId,
    member_id: employeeId,
    display_name: displayName,
    profile_available: profileAvailable,
    avatar_url: avatarUrl,
  }
}

test('group avatar keeps real roster order, de-duplicates employees, and shows at most four', () => {
  const items = resolveGroupAvatarItems([
    member('employee-1', '甲'),
    member('employee-2', '乙'),
    member('employee-2', '重复乙'),
    member('employee-3', '丙'),
    member('employee-4', '丁'),
    member('employee-5', '戊'),
  ])

  assert.equal(items.length, GROUP_AVATAR_MAX_MEMBERS)
  assert.deepEqual(items.map((item) => item.employeeId), [
    'employee-1',
    'employee-2',
    'employee-3',
    'employee-4',
  ])
})

test('group avatar prefers real URL and otherwise falls back to a non-emoji name character', () => {
  const items = resolveGroupAvatarItems([
    member('employee-1', 'Alice', ' https://example.com/alice.png '),
    member('employee-2', '🤖小林'),
    member('employee-3', '不可用成员', null, false),
  ])

  assert.equal(items[0]?.avatarUrl, 'https://example.com/alice.png')
  assert.equal(items[0]?.fallback, 'A')
  assert.equal(items[1]?.avatarUrl, null)
  assert.equal(items[1]?.fallback, '小')
  assert.equal(items[2]?.fallback, '?')
  assert.doesNotMatch(items.map((item) => item.fallback).join(''), /🤖|👥/u)
})

test('group avatar uses equal square cells and centers the odd first row', () => {
  const css = readFileSync(
    new URL('../src/components/Chat/GroupAvatar.css', import.meta.url),
    'utf8',
  )
  const rule = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`)
    assert.notEqual(start, -1, `Missing CSS rule: ${selector}`)
    const body = css.slice(start + selector.length + 3)
    return body.slice(0, body.indexOf('}'))
  }

  assert.match(rule('.group-avatar'), /align-content: center/)
  assert.match(rule('.group-avatar'), /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/)
  assert.match(rule('.group-avatar'), /grid-template-rows: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(rule('.group-avatar.count-2'), /grid-template-rows: 50%/)
  assert.match(rule('.group-avatar-cell'), /grid-column: span 2/)
  assert.match(css, /\.group-avatar\.count-1,\s*\.group-avatar\.count-2\s*\{\s*grid-template-rows: 50%/)
  assert.match(css, /\.group-avatar\.count-1 \.group-avatar-cell:first-child,\s*\.group-avatar\.count-3 \.group-avatar-cell:first-child\s*\{\s*grid-column: 2 \/ span 2/)
  assert.match(rule('.group-avatar.count-3 .group-avatar-cell:first-child'), /grid-column: 2 \/ span 2/)
  assert.match(rule('.group-avatar.count-3 .group-avatar-cell:nth-child(2)'), /grid-column: 1 \/ span 2/)
  assert.match(rule('.group-avatar-cell'), /box-sizing: border-box/)
  assert.doesNotMatch(css, /grid-column: 1 \/ -1|border-(?:left|top)-width/)
})

test('group avatar is wired to the group list, group header, and group details', () => {
  const panelSource = readFileSync(
    new URL('../src/components/Layout/Panel.tsx', import.meta.url),
    'utf8',
  )
  const groupChatSource = readFileSync(
    new URL('../src/pages/GroupChat/index.tsx', import.meta.url),
    'utf8',
  )
  const detailSource = readFileSync(
    new URL('../src/components/Chat/GroupDetailPanel.tsx', import.meta.url),
    'utf8',
  )

  assert.match(panelSource, /<GroupAvatar[\s\S]*members=\{group\.members \?\? \[\]\}/)
  assert.match(panelSource, /rosterDescription=\{group\.rosterMessage\}/)
  assert.match(groupChatSource, /avatar=\{\([\s\S]*<GroupAvatar[\s\S]*members=\{group\.members \?\? \[\]\}/)
  assert.match(groupChatSource, /rosterDescription=\{group\.rosterMessage\}/)
  assert.match(detailSource, /<GroupAvatar[\s\S]*members=\{members\}/)
  assert.match(detailSource, /<GroupAvatar members=\{\[m\]\}/)
  assert.doesNotMatch(`${panelSource}\n${groupChatSource}`, /group\.emoji|convEmoji=\{group|\ud83d\udc65/u)
})
