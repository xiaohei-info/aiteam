import assert from 'node:assert/strict'
import test from 'node:test'
import { groupSkillStates, hasSkillProblems } from '../src/lib/skillReadiness.ts'

test('技能分三类：可用 / 企业已移除 / 暂时不可用（带原因）', () => {
  const groups = groupSkillStates([
    { ref: 'weekly@1', status: 'ready' },
    { ref: 'gone', status: 'blocked', reason: 'skill_removed' },
    { ref: 'off', status: 'blocked', reason: 'skill_disabled' },
    { ref: 'wip', status: 'blocked', reason: 'skill_unfinished' },
    { ref: 'new', status: 'blocked', reason: 'skill_missing' },
    { ref: 'odd', status: 'blocked', reason: 'skill_invalid' },
    { ref: 'weekly@1', status: 'ready' },
  ], [{ ref: 'weekly@1', display_name: '周报整理' }])
  assert.deepEqual(groups.available, ['周报整理'])
  assert.deepEqual(groups.removed, ['gone'])
  assert.deepEqual(groups.unavailable, [
    { name: 'off', why: '企业已停用' },
    { name: 'wip', why: '企业还没配置完成' },
    { name: 'new', why: '还没同步到本机，请稍后刷新' },
    { name: 'odd', why: '暂时不可用' },
  ])
  assert.equal(hasSkillProblems(groups), true)
})

test('全部可用或没有数据时不提示', () => {
  assert.equal(hasSkillProblems(groupSkillStates([{ ref: 'a', status: 'ready' }])), false)
  assert.equal(hasSkillProblems(groupSkillStates(undefined)), false)
})
