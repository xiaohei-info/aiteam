import assert from 'node:assert/strict'
import test from 'node:test'
import {
  batchFailureSummary,
  canInstall,
  defaultPicked,
  installButtonLabel,
  normalizePicked,
  togglePicked,
} from '../src/lib/skillScanSelection.ts'
import type { CustomSkillScanItem } from '../src/api/agent/capabilities.ts'

/**
 * 「一个文件夹 / 一个 zip 下多个技能」的用例。
 * 数据形态取自 preview 的 scan 结果：包内每个含 SKILL.md 的目录一条，root 为相对包根的路径。
 */
const folderScan: CustomSkillScanItem[] = [
  { root: '01-weekly-report', name: 'weekly-report', description: '周报', file_count: 1, total_bytes: 64, ok: true },
  { root: '02-ppt-outline', name: 'ppt-outline', description: 'PPT 大纲', file_count: 2, total_bytes: 512, ok: true },
  { root: '03-broken', name: '', description: '', file_count: 1, total_bytes: 12, ok: false, reason: 'SKILL.md 缺少 name' },
]

test('扫描出多个技能时默认全选校验通过的，跳过不通过的', () => {
  assert.deepEqual(defaultPicked(folderScan), ['01-weekly-report', '02-ppt-outline'])
})

test('不通过的技能即使被塞进 picked 也不会进安装清单', () => {
  assert.deepEqual(normalizePicked(folderScan, ['01-weekly-report', '03-broken']), ['01-weekly-report'])
})

test('包根本身就是技能时 root 是空串，也要能选', () => {
  const single: CustomSkillScanItem[] = [
    { root: '', name: 'solo', description: '单技能', file_count: 1, total_bytes: 8, ok: true },
  ]
  assert.deepEqual(defaultPicked(single), [''])
  assert.deepEqual(normalizePicked(single, ['']), [''])
  // 空串是合法 root（包根本身就是技能）：选中后再点一次是取消，不是「没选中」。
  assert.deepEqual(togglePicked([], ''), [''])
})

test('勾选/取消勾选按 root 切换，重复勾选不产生重复项', () => {
  assert.deepEqual(togglePicked([], 'a'), ['a'])
  assert.deepEqual(togglePicked(['a'], 'a'), [])
  assert.deepEqual(togglePicked(['a', 'b'], 'a'), ['b'])
  // 不在清单里的 root（没勾过 / 校验不通过）会被剔除；重复项只保留一次。
  assert.deepEqual(normalizePicked(folderScan, ['01-weekly-report', '01-weekly-report']), ['01-weekly-report'])
  assert.deepEqual(normalizePicked(folderScan, ['01-weekly-report', 'nope']), ['01-weekly-report'])
})

test('安装按钮：0 个不能点，多个时文案带数量', () => {
  assert.equal(canInstall(0, false), false)
  assert.equal(canInstall(0, null), false)
  assert.equal(canInstall(2, false), true)
  assert.equal(canInstall(2, true), false, '进行中不能重复点')
  assert.equal(installButtonLabel(1, false), '安装所选')
  assert.equal(installButtonLabel(3, false), '安装所选 3 个')
  assert.equal(installButtonLabel(3, true), '正在安装…')
})

test('批量安装有失败时给出已装/失败汇总', () => {
  const summary = batchFailureSummary([
    { root: '01-weekly-report', name: 'weekly-report', ok: true },
    { root: '03-broken', name: '', ok: false, reason: 'SKILL.md 缺少 name' },
  ])
  assert.equal(summary, '已装 1 个，1 个失败：03-broken（SKILL.md 缺少 name）')

  assert.equal(batchFailureSummary([{ root: '', name: 'solo', ok: true }]), '', '全部成功不给提示')
  // 包根失败时显示「包根」，不要显示空白路径
  assert.match(batchFailureSummary([{ root: '', name: '', ok: false, reason: '加载失败' }]), /包根（加载失败）/)
})
