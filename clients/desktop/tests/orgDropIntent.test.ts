import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IDLE_DROP_TEXT,
  ROOT_DROP_ID,
  describeDrop,
  headerZone,
  landingOf,
  sameHover,
  type DropHover,
} from '../src/pages/OrgChart/dropIntent.ts'
import type { ApiDepartment } from '../src/pages/OrgChart/api.ts'

const dept = (id: string, children: ApiDepartment[] = []): ApiDepartment =>
  ({ department_id: id, name: id, children, members: [] })
const head = (id: string, zone: 'into' | 'beside' = 'into'): DropHover => ({ kind: 'department', id, zone, onHeader: true })
const body = (id: string): DropHover => ({ kind: 'department', id, zone: 'into', onHeader: false })

// a 下面有 b，b 下面有 c；d 是另一个顶级部门
const tree = () => [dept('a', [dept('b', [dept('c')])]), dept('d')]

test('名称卡片上部为放入，下沿（含卡片下面的空隙）为同级', () => {
  const rect = { top: 100, height: 40 }
  assert.equal(headerZone(rect, 101), 'into')
  assert.equal(headerZone(rect, 123), 'into')
  assert.equal(headerZone(rect, 124), 'beside')
  assert.equal(headerZone(rect, 146), 'beside')
})

test('放在部门卡片上或它的成员区：成为它的下级，落点是那个部门', () => {
  for (const hover of [head('d'), body('d')]) {
    const intent = describeDrop(tree(), 'b', hover)
    assert.equal(intent.tone, 'ok')
    assert.deepEqual(intent.mark, { id: 'd', style: 'into' })
    assert.equal(intent.action?.parentId, 'd')
    assert.equal(intent.action?.promoted, undefined)
    assert.equal(landingOf(intent), 'd')
  }
})

test('放在卡片下沿：与它同级；目标是顶级部门时设为顶级', () => {
  const intent = describeDrop(tree(), 'b', head('d', 'beside'))
  assert.equal(intent.tone, 'ok')
  assert.deepEqual(intent.mark, { id: 'd', style: 'beside' })
  assert.equal(intent.action?.parentId, null)
  assert.match(intent.text, /设为顶级部门，与「d」同级/)
  assert.equal(landingOf(intent), ROOT_DROP_ID)

  const nested = describeDrop([dept('a', [dept('b'), dept('x', [dept('y')])])], 'y', head('b', 'beside'))
  assert.equal(nested.action?.parentId, 'a')
  assert.equal(nested.text, '与「b」同级')
})

test('当前上级部门的整张卡片都表示“与它同级”，成员区不移动', () => {
  const onHeader = describeDrop(tree(), 'b', head('a'))
  assert.deepEqual(onHeader.mark, { id: 'a', style: 'beside' })
  assert.equal(onHeader.action?.parentId, null)

  const onBody = describeDrop(tree(), 'b', body('a'))
  assert.equal(onBody.tone, 'idle')
  assert.equal(onBody.action, null)
  assert.equal(onBody.text, '已在「a」下面')
})

test('放在公司根节点：设为顶级部门；已是顶级则不移动', () => {
  const intent = describeDrop(tree(), 'b', { kind: 'root' })
  assert.deepEqual(intent.mark, { id: ROOT_DROP_ID, style: 'into' })
  assert.equal(intent.action?.parentId, null)
  assert.equal(landingOf(intent), ROOT_DROP_ID)

  const already = describeDrop(tree(), 'a', { kind: 'root' })
  assert.equal(already.tone, 'idle')
  assert.equal(already.text, '已是顶级部门')
  assert.equal(describeDrop(tree(), 'a', head('d', 'beside')).text, '已是顶级部门')
})

test('放在自己的下级部门名称卡片上：互换位置；指在下级的成员区只是路过', () => {
  const swap = describeDrop(tree(), 'b', head('c'))
  assert.equal(swap.tone, 'swap')
  assert.deepEqual(swap.mark, { id: 'c', style: 'swap' })
  assert.equal(swap.action?.promoted, 'c')
  assert.equal(landingOf(swap), null)

  const passing = describeDrop(tree(), 'b', body('c'))
  assert.equal(passing.tone, 'idle')
  assert.equal(passing.action, null)
})

test('超过层数上限时标为不允许，给出原因且不产生动作', () => {
  const chain = dept('n1', [dept('n2', [dept('n3', [dept('n4')])])])
  const intent = describeDrop([chain, dept('p', [dept('q')])], 'p', head('n4'))
  assert.equal(intent.tone, 'blocked')
  assert.deepEqual(intent.mark, { id: 'n4', style: 'blocked' })
  assert.equal(intent.action, null)
  assert.match(intent.text, /最多 5 层/)
  assert.equal(landingOf(intent), null)
})

test('没有目标、指着自己或找不到部门时保持原位，且不修改入参', () => {
  const departments = tree()
  const snapshot = structuredClone(departments)
  assert.deepEqual(describeDrop(departments, 'b', null), { tone: 'idle', text: IDLE_DROP_TEXT, mark: null, action: null })
  assert.equal(describeDrop(departments, 'b', head('b')).action, null)
  assert.equal(describeDrop(departments, 'b', head('missing')).action, null)
  assert.equal(describeDrop(departments, 'missing', head('d')).action, null)
  describeDrop(departments, 'b', head('d'))
  describeDrop(departments, 'b', head('c'))
  assert.deepEqual(departments, snapshot)
})

test('sameHover 只在位置真正变化时返回 false，避免拖动中重复渲染', () => {
  assert.equal(sameHover(null, null), true)
  assert.equal(sameHover({ kind: 'root' }, { kind: 'root' }), true)
  assert.equal(sameHover(head('a'), head('a')), true)
  assert.equal(sameHover(head('a'), head('a', 'beside')), false)
  assert.equal(sameHover(head('a'), body('a')), false)
  assert.equal(sameHover(head('a'), null), false)
})
