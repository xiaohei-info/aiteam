import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendMemoryPage, describeHiddenMemories, describeMemoryDeleteError, describeMemoryProblem, describeMemorySummary,
  formatMemoryTime, groupMemories, isLongMemory, memoryEntryLabel, memoryImportanceStars, memoryTimeLabel,
  normalizeMemoryKeyword, MAX_MEMORY_KEYWORD_CHARS,
} from '../src/lib/employeeMemory.ts'
import type { EmployeeMemory, EmployeeMemorySummary } from '../src/api/agent/employeeMemories.ts'

const now = new Date(2026, 9, 30, 14, 32)
const at = (days: number, hours = 10, minutes = 21) => new Date(2026, 9, 30 - days, hours, minutes).toISOString()

const memory = (id: string, createdAt: string | null, overrides: Partial<EmployeeMemory> = {}): EmployeeMemory => ({
  memory_id: id, employee_id: 'employee-1', content: '用户偏好周报用表格形式。', category: 'world', importance: 0.75,
  source: 'context_reset', created_at: createdAt, last_used_at: null, state: 'valid',
  contributor_member_id: 'member-1', contributor_display_name: '张三', is_mine: true, ...overrides,
})

const summary = (overrides: Partial<EmployeeMemorySummary> = {}): EmployeeMemorySummary => ({
  employee_id: 'employee-1', scope: 'mine', total_count: 42, own_count: 42, others_count: 0, unattributed_count: 0,
  recent_count: 6, latest_used_at: null, truncated: false, ...overrides,
})

test('错误文案：旧版 Agent 的 404 隐藏入口，员工不存在的 404 不当成旧版本', () => {
  assert.equal(describeMemoryProblem({ status: 404, code: 'not_found' }).kind, 'unsupported')
  assert.equal(describeMemoryProblem({ status: 404 }).kind, 'unsupported')
  assert.deepEqual(describeMemoryProblem({ status: 404, code: 'memory_employee_not_found' }),
    { kind: 'disabled', text: '这位员工不在企业服务中，暂时无法查看记忆。', retry: false })
  assert.equal(describeMemoryProblem({ status: 404, code: 'employee_not_found' }).kind, 'disabled')
})

test('错误文案：未开启记忆、未授权、服务不可用、其他失败', () => {
  assert.deepEqual(describeMemoryProblem({ status: 403, code: 'memory_forbidden' }), { kind: 'disabled', text: '这位员工没有开启记忆', retry: false })
  assert.equal(describeMemoryProblem({ status: 403, code: 'employee_not_authorized' }).text, '你还没有获得这位员工的使用授权。')
  assert.deepEqual(describeMemoryProblem({ status: 503, code: 'memory_unavailable' }), { kind: 'unavailable', text: '记忆服务暂不可用', retry: true })
  assert.equal(describeMemoryProblem({ status: 503, code: 'manager_unavailable' }).text, '企业服务暂不可用')
  assert.deepEqual(describeMemoryProblem({ status: 0, code: 'network_error' }), { kind: 'failed', text: '记忆加载失败', retry: true })
  assert.equal(describeMemoryProblem(new Error('boom')).kind, 'failed')
  assert.equal(describeMemoryProblem(null).kind, 'failed')
})

test('删除失败文案：只能删除自己贡献的', () => {
  assert.equal(describeMemoryDeleteError({ status: 403, code: 'memory_not_contributor' }), '只能删除由你的对话产生的记忆。')
  assert.equal(describeMemoryDeleteError({ status: 403, code: 'memory_forbidden' }), '没有权限删除这条记忆。')
  assert.equal(describeMemoryDeleteError({ status: 503, code: 'memory_unavailable' }), '记忆服务暂不可用，请稍后重试。')
  assert.equal(describeMemoryDeleteError({ status: 500 }), '删除失败，请重试。')
})

test('关键词：去空白、空串不传、按字符截到上限', () => {
  assert.equal(normalizeMemoryKeyword('  周报 '), '周报')
  assert.equal(normalizeMemoryKeyword('   '), undefined)
  const long = '记'.repeat(MAX_MEMORY_KEYWORD_CHARS + 5)
  assert.equal([...normalizeMemoryKeyword(long)!].length, MAX_MEMORY_KEYWORD_CHARS)
})

test('摘要卡片入口：有条数显示条数，加载失败只显示「查看全部 →」', () => {
  assert.equal(memoryEntryLabel(summary()), '查看全部 42 条 →')
  assert.equal(memoryEntryLabel(summary({ total_count: 0 })), '查看全部 0 条 →')
  assert.equal(memoryEntryLabel(null), '查看全部 →')
})

test('顶部统计：近 7 天新增与最近被用到', () => {
  assert.equal(describeMemorySummary(summary(), now), '近 7 天新增 6')
  assert.equal(describeMemorySummary(summary({ latest_used_at: at(0) }), now), '近 7 天新增 6 · 最近被用到 今天 10:21')
  assert.equal(describeMemorySummary(summary({ latest_used_at: at(3) }), now), '近 7 天新增 6 · 最近被用到 10/27')
})

test('其他成员与来源未知的记忆只显示数量，都为 0 时不显示', () => {
  assert.equal(describeHiddenMemories(summary()), null)
  assert.equal(describeHiddenMemories(summary({ others_count: 32 })), '另有 32 条来自其他同事的对话，仅管理员可见')
  assert.equal(describeHiddenMemories(summary({ others_count: 32, unattributed_count: 5 })), '另有 32 条来自其他同事的对话，来源未知 5 条，仅管理员可见')
  assert.equal(describeHiddenMemories(summary({ unattributed_count: 5 })), '来源未知 5 条，仅管理员可见')
})

test('时间：今天 HH:mm，今年 M/D，更早带年份，无效为 null', () => {
  assert.equal(formatMemoryTime(at(0, 9, 5), now), '09:05')
  assert.equal(formatMemoryTime(at(3), now), '10/27')
  assert.equal(formatMemoryTime(new Date(2025, 11, 31, 8).toISOString(), now), '2025/12/31')
  assert.equal(formatMemoryTime(null, now), null)
  assert.equal(formatMemoryTime('not-a-date', now), null)
  assert.equal(memoryTimeLabel({ created_at: at(3), last_used_at: at(0) }, now), '10:21 被用到')
  assert.equal(memoryTimeLabel({ created_at: at(3), last_used_at: null }, now), '10/27 保存')
  assert.equal(memoryTimeLabel({ created_at: null, last_used_at: null }, now), null)
})

test('重要度换算为 4 档星，未知不显示', () => {
  assert.equal(memoryImportanceStars(null), null)
  assert.equal(memoryImportanceStars(Number.NaN), null)
  assert.equal(memoryImportanceStars(0), 1)
  assert.equal(memoryImportanceStars(0.25), 1)
  assert.equal(memoryImportanceStars(0.5), 2)
  assert.equal(memoryImportanceStars(0.75), 3)
  assert.equal(memoryImportanceStars(0.76), 4)
  assert.equal(memoryImportanceStars(1.4), 4)
})

test('长正文折叠：超过约 90 字或 3 行', () => {
  assert.equal(isLongMemory('短'), false)
  assert.equal(isLongMemory('字'.repeat(91)), true)
  assert.equal(isLongMemory('a\nb\nc'), false)
  assert.equal(isLongMemory('a\nb\nc\nd'), true)
})

test('按写入时间分组：今天 / 近 7 天 / 更早，组内保持服务端顺序，时间未知归入更早', () => {
  const items = [memory('a', at(0)), memory('b', at(8)), memory('c', at(2)), memory('d', null), memory('e', at(0, 1)), memory('f', at(6, 0, 1))]
  const groups = groupMemories(items, now)
  assert.deepEqual(groups.map((group) => [group.key, group.items.map((item) => item.memory_id)]),
    [['today', ['a', 'e']], ['week', ['c', 'f']], ['earlier', ['b', 'd']]])
  assert.deepEqual(groupMemories([memory('x', at(10))], now).map((group) => group.key), ['earlier'])
  assert.deepEqual(groupMemories([], now), [])
})

test('加载更多：追加下一页并按 memory_id 去重', () => {
  const merged = appendMemoryPage([memory('a', null), memory('b', null)], [memory('b', null), memory('c', null)])
  assert.deepEqual(merged.map((item) => item.memory_id), ['a', 'b', 'c'])
})
