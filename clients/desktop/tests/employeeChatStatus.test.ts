import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPLOYEE_CHAT_CHECKING,
  EMPLOYEE_CHAT_UNKNOWN,
  describeReadinessReason,
  loadEmployeeReadiness,
  resolveEmployeeChatStatus,
} from '../src/lib/employeeChatStatus.ts'

const ready = { available: true, reasons: [] }
const active = { status: 'active', revoked: false }

test('企业后台状态优先：未授权、下架、暂停、招募中、招募失败、模型不可用各有独立描述', () => {
  const label = (lifecycle: Parameters<typeof resolveEmployeeChatStatus>[0]['lifecycle']) =>
    resolveEmployeeChatStatus({ readiness: ready, lifecycle, listing: 'listed' }).label
  assert.equal(label(null), '未授权')
  assert.equal(label({ ...active, revoked: true }), '未授权')
  assert.equal(label({ status: 'archived' }), '已下架')
  assert.equal(label({ status: 'active', availability_reason: 'employee_unavailable' }), '已下架')
  assert.equal(label({ status: 'paused' }), '已暂停')
  assert.equal(label({ status: 'provisioning' }), '招募中')
  assert.equal(label({ status: 'draft' }), '招募中')
  assert.equal(label({ status: 'provisioning_failed' }), '招募失败')
  assert.equal(label({ status: 'active', availability_reason: 'employee_dependency_unavailable' }), '模型不可用')
  assert.equal(resolveEmployeeChatStatus({ readiness: ready, lifecycle: { status: 'paused' } }).tone, 'warn')
  assert.equal(resolveEmployeeChatStatus({ readiness: ready, lifecycle: { status: 'archived' } }).tone, 'off')
})

test('模板未上架排在 readiness 之前，并在说明里带上能否对话', () => {
  const unlisted = resolveEmployeeChatStatus({ readiness: ready, lifecycle: active, listing: 'unlisted' })
  assert.equal(unlisted.label, '模板未上架')
  assert.match(unlisted.detail, /仍可以发起对话/)
  const blocked = resolveEmployeeChatStatus({ readiness: { available: false, reasons: ['Pi runtime is not ready'] }, lifecycle: active, listing: 'unlisted' })
  assert.match(blocked.detail, /目前不能对话：本机运行环境未就绪/)
  // 系统主持人等不来自人才市场的员工不提示上架状态。
  assert.equal(resolveEmployeeChatStatus({ readiness: ready, lifecycle: active, listing: 'none' }).label, '可对话')
})

test('readiness 决定最后的可对话 / 未就绪 / 检查中 / 状态未知；后台事实缺失时只按 readiness 判断', () => {
  assert.deepEqual(resolveEmployeeChatStatus({ readiness: ready }), { state: 'available', tone: 'ok', label: '可对话', detail: '可以发起对话' })
  assert.deepEqual(resolveEmployeeChatStatus({
    readiness: { available: false, reasons: ['Required skill web-search: skill_missing', 'Required skill web-search: skill_missing'] },
    lifecycle: active,
    listing: 'listed',
  }), { state: 'not_ready', tone: 'warn', label: '未就绪', detail: '技能「web-search」未就绪' })
  assert.equal(resolveEmployeeChatStatus({}), EMPLOYEE_CHAT_CHECKING)
  assert.equal(resolveEmployeeChatStatus({ readiness: null }), EMPLOYEE_CHAT_UNKNOWN)
  assert.equal(resolveEmployeeChatStatus({ readiness: { available: false } }).detail, '员工尚未就绪')
  assert.equal(describeReadinessReason('something new'), 'something new')
})

test('批量查询 readiness 按员工去重，单个查询失败记为 null', async () => {
  const queried: string[] = []
  const readiness = await loadEmployeeReadiness(['a', 'b', 'a', 'c'], async (id) => {
    queried.push(id)
    if (id === 'c') throw new Error('network')
    return { available: id === 'a', reasons: [] }
  })
  assert.deepEqual(queried, ['a', 'b', 'c'])
  assert.deepEqual(readiness, { a: { available: true, reasons: [] }, b: { available: false, reasons: [] }, c: null })
})
