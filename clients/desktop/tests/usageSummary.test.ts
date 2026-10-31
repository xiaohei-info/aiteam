import assert from 'node:assert/strict'
import test from 'node:test'
import { lastDaysWindow, todayWindow, usageRangeWindow } from '../src/lib/usageWindow.ts'
import {
  describeResolution, describeUsageCost, formatTokenCount, groupParticipation, groupUsageRows,
  splitUsageRows, tallySegmentOutcomes, usageSuccessRate,
} from '../src/lib/usageSummary.ts'
import type { UsageOutcomes, UsageStatisticsGroup } from '../src/api/agent/observations.types.ts'
import type { ContextSegment } from '../src/api/agent/types.ts'
import type { GroupMember } from '../src/lib/groupRoster.ts'

const HOUR = 3_600_000
const now = new Date(2026, 9, 30, 14, 32, 10)
const localMidnight = (days = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime()

test('今日窗口：本地午夜向下取整到 UTC 整点，终点为当前时刻之后的下一个整点', () => {
  const window = todayWindow(now)
  const start = Date.parse(window.window_start)
  const end = Date.parse(window.window_end)
  assert.equal(start % HOUR, 0)
  assert.equal(end % HOUR, 0)
  assert.ok(start <= localMidnight() && localMidnight() - start < HOUR)
  assert.ok(end > now.getTime() && end - now.getTime() <= HOUR)
})

test('整点时刻也落在窗口内，不产生空窗', () => {
  const onHour = new Date(Math.floor(now.getTime() / HOUR) * HOUR)
  const end = Date.parse(todayWindow(onHour).window_end)
  assert.equal(end, onHour.getTime() + HOUR)
})

test('近 7 天包含今天，从 6 天前的本地午夜起算', () => {
  const window = lastDaysWindow(7, now)
  const start = Date.parse(window.window_start)
  assert.equal(start % HOUR, 0)
  assert.ok(start <= localMidnight(6) && localMidnight(6) - start < HOUR)
  assert.equal(window.window_end, todayWindow(now).window_end)
})

test('时间范围映射：全部不传时间窗', () => {
  assert.deepEqual(usageRangeWindow('today', now), todayWindow(now))
  assert.deepEqual(usageRangeWindow('week', now), lastDaysWindow(7, now))
  assert.deepEqual(usageRangeWindow('all', now), {})
})

test('Token 缩写', () => {
  assert.equal(formatTokenCount(0), '0')
  assert.equal(formatTokenCount(999), '999')
  assert.equal(formatTokenCount(128_400), '128.4K')
  assert.equal(formatTokenCount(2_500_000), '2.5M')
})

test('费用：已知显示金额，部分未定价显示 ≥ 已知小计，全部未定价不显示为 0', () => {
  assert.deepEqual(describeUsageCost({ pricing_status: 'known', cost_total: '0.420000000000', known_cost_total: '0.420000000000', unpriced_execution_count: 0 }),
    { value: '$0.42', note: null })
  assert.deepEqual(describeUsageCost({ pricing_status: 'known', cost_total: '0.000000000000', known_cost_total: '0.000000000000', unpriced_execution_count: 0 }),
    { value: '$0.00', note: null })
  assert.deepEqual(describeUsageCost({ pricing_status: 'partial', cost_total: null, known_cost_total: '0.404000000000', unpriced_execution_count: 3 }),
    { value: '≥$0.40', note: '3 次执行未定价' })
  assert.deepEqual(describeUsageCost({ pricing_status: 'unknown', cost_total: null, known_cost_total: '0.000000000000', unpriced_execution_count: 2 }),
    { value: '未定价', note: '模型未定价' })
})

test('成功率：执行为 0 时为空', () => {
  assert.equal(usageSuccessRate({ execution_count: 0, succeeded_count: 0 }), null)
  assert.equal(usageSuccessRate({ execution_count: 23, succeeded_count: 21 }), 91)
})

test('解决率：样本不足时显示已评估段数', () => {
  const base: UsageOutcomes = { scope: 'member_local', employee_id: 'e1', window_start: null, window_end: null, min_sample: 10, evaluated_count: 4, resolved_count: 3, unresolved_count: 1, resolution_rate: null, reasons: [] }
  assert.deepEqual(describeResolution(base), { value: '样本不足', detail: '4 段已评估，满 10 段后显示' })
  assert.deepEqual(describeResolution({ ...base, evaluated_count: 17, resolved_count: 14, resolution_rate: 14 / 17 }), { value: '82%', detail: '17 段已评估' })
})

const segment = (id: string, outcome: ContextSegment['outcome'], endedAt: string) => ({ segment_id: id, outcome, ended_at: endedAt }) as ContextSegment

test('群聊解决情况按段落结束时间落入时间窗统计，未评估不计入', () => {
  const segments = [
    segment('a', 'resolved', '2026-10-29T03:00:00.000Z'),
    segment('b', 'unresolved', '2026-10-30T03:00:00.000Z'),
    segment('c', 'resolved', '2026-10-30T04:00:00.000Z'),
    segment('d', null, '2026-10-30T05:00:00.000Z'),
  ]
  assert.deepEqual(tallySegmentOutcomes(segments, {}), { evaluated: 3, resolved: 2 })
  assert.deepEqual(tallySegmentOutcomes(segments, { window_start: '2026-10-30T00:00:00.000Z', window_end: '2026-10-30T04:00:00.000Z' }), { evaluated: 1, resolved: 0 })
})

const group = (employee_id: string, token_total: number, execution_count = 1, cost: string | null = '0.100000000000'): UsageStatisticsGroup => ({
  employee_id, execution_count, succeeded_count: execution_count, non_success_count: 0, input_tokens: token_total, output_tokens: 0, cache_tokens: 0,
  token_total, duration_ms_total: 0, currency: 'USD', cost_total: cost, known_cost_total: cost ?? '0.000000000000', cost_minor: null,
  pricing_status: cost === null ? 'unknown' : 'known', unpriced_execution_count: cost === null ? execution_count : 0,
})
const member = (id: string, name: string, planner = false): GroupMember => ({ employee_id: id, member_ref_id: id, member_id: id, display_name: name, is_system_planner: planner })

test('按成员拆分：主持人标签、已移出员工仍计入、未归属用量单独标注', () => {
  const members = [member('host', '小策', true), member('li', '小李')]
  const employees = new Map([['sun', { displayName: '小孙', avatarUrl: null }]])
  const rows = groupUsageRows([group('host', 600), group('sun', 300), group('unknown', 100, 1, null)], members, employees)
  assert.deepEqual(rows.map(row => [row.member.display_name, row.coordinator, row.removed, row.unattributed, row.share]), [
    ['小策', true, false, false, 60],
    ['小孙', false, true, false, 30],
    ['未归属', false, false, true, 10],
  ])
  assert.equal(rows[2].cost.value, '未定价')
  assert.equal(rows.reduce((sum, row) => sum + row.tokens, 0), 1000)
})

test('参与员工只数当前群成员中有执行记录的人', () => {
  const members = [member('host', '小策', true), member('li', '小李'), member('wang', '小王')]
  assert.equal(groupParticipation([group('host', 10), group('li', 0, 0), group('sun', 5)], members), 1)
})

test('成员超过 6 位时折叠为前 5 位 + 其他 N 位', () => {
  const six = [1, 2, 3, 4, 5, 6]
  assert.deepEqual(splitUsageRows(six, false), { visible: six, hidden: 0 })
  assert.deepEqual(splitUsageRows([...six, 7, 8], false), { visible: [1, 2, 3, 4, 5], hidden: 3 })
  assert.deepEqual(splitUsageRows([...six, 7], true), { visible: [...six, 7], hidden: 0 })
})
