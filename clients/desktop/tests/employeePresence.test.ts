import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  EMPLOYEE_PRESENCE_UNAVAILABLE,
  resolveEmployeePresence,
} from '../src/lib/employeePresence.ts'

test('missing B1 presence fields are displayed as unavailable, never online or offline', () => {
  assert.deepEqual(resolveEmployeePresence(), EMPLOYEE_PRESENCE_UNAVAILABLE)
  assert.equal(resolveEmployeePresence().label, '在线状态未提供')
  assert.equal(resolveEmployeePresence().lastSeenLabel, '最后在线时间未提供')
})

test('lifecycle, readiness, and Office activity signals cannot impersonate presence', () => {
  const nonAuthoritative = {
    status: 'active',
    available: true,
    office_status: 'working',
    last_activity_at: '2026-09-08T08:00:00Z',
  }

  assert.deepEqual(resolveEmployeePresence(nonAuthoritative), EMPLOYEE_PRESENCE_UNAVAILABLE)
})

test('only explicit authoritative B1 fields produce a known presence display', () => {
  assert.deepEqual(resolveEmployeePresence({
    online_status: 'offline',
    last_seen_at: '2026-09-08T08:00:00Z',
  }), {
    known: true,
    label: '离线',
    lastSeenLabel: '最后在线：2026-09-08T08:00:00Z',
  })
})

test('employee surfaces consume authoritative presence and keep missing fields unavailable', () => {
  const chat = readFileSync(new URL('../src/pages/Chat/index.tsx', import.meta.url), 'utf8')
  const groupDetail = readFileSync(new URL('../src/components/Chat/GroupDetailPanel.tsx', import.meta.url), 'utf8')
  const groupCreate = readFileSync(new URL('../src/components/Chat/CreateGroupDialog.tsx', import.meta.url), 'utf8')
  const orgChart = readFileSync(new URL('../src/pages/OrgChart/index.tsx', import.meta.url), 'utf8')
  const officeMocks = readFileSync(new URL('../src/pages/OfficeStatus/constants.ts', import.meta.url), 'utf8')
  const chatStore = readFileSync(new URL('../src/stores/chat.ts', import.meta.url), 'utf8')

  assert.match(chat, /resolveEmployeePresence/)
  assert.doesNotMatch(groupDetail, /resolveEmployeePresence|presence\./)
  assert.doesNotMatch(groupDetail, /gdp-member-dot/)
  assert.doesNotMatch(groupCreate, /cgd-member-dot/)
  assert.doesNotMatch(orgChart, /isActive|oc-member-dot|oc-root-status-dot/)
  // 组织架构改为显示「能否发起对话」（后台状态 + 人才市场上架 + readiness），不再显示在线状态。
  assert.doesNotMatch(orgChart, /resolveEmployeePresence/)
  assert.match(orgChart, /resolveEmployeeChatStatus\(chatFacts\[emp\.employee_id\] \?\? \{\}\)/)
  assert.match(orgChart, /loadEmployeeMarketFacts\(ids\)/)
  // 服务端暂未提供权威在线字段/调动统计，统计卡先隐藏。
  assert.doesNotMatch(orgChart, /在线人数|今日调动/)
  assert.match(chatStore, /onlineStatus: e\.online_status/)
  assert.match(chatStore, /lastSeenAt: e\.last_seen_at/)
  assert.doesNotMatch(officeMocks, /在线Agent[^\n]*value:\s*'[1-9]/)
})
