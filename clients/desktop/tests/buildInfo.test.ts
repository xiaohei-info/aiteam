import assert from 'node:assert/strict'
import test from 'node:test'
import { describeBuildInfo, formatBuiltAt } from '../src/lib/buildInfoFormat.ts'

const base = { version: '0.1.0', commit: '936ce719', builtAt: '2026-11-10T06:59:00.000Z', dev: false }

test('installed build is labelled as package with build time', () => {
  const rows = describeBuildInfo(base)
  assert.deepEqual(rows.map(row => row.label), ['运行方式', '版本', '构建提交', '构建时间'])
  assert.equal(rows[0].value, '安装包')
  assert.equal(rows[2].value, '936ce719')
})

test('dev build is labelled as dev with start time', () => {
  const rows = describeBuildInfo({ ...base, dev: true, commit: '936ce719-dirty' })
  assert.match(rows[0].value, /开发模式/)
  assert.equal(rows[2].value, '936ce719-dirty')
  assert.equal(rows[3].label, '启动时间')
})

test('formatBuiltAt handles invalid input and formats valid dates', () => {
  assert.equal(formatBuiltAt('not-a-date'), '未知')
  assert.match(formatBuiltAt(base.builtAt), /^2026-11-1\d \d{2}:\d{2}$/)
})
