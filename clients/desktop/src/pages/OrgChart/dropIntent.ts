import type { ApiDepartment } from './api'
import { findDepartment, moveDepartment, parentOf, isAncestor } from './orgTree.ts'

/** 公司根节点在高亮列表里的 id。 */
export const ROOT_DROP_ID = '__org_root__'

/**
 * 指针当前指在哪里（只描述位置，不做业务判断）：
 * - root：公司根节点；
 * - department：某个部门。onHeader 表示指在名称卡片上（含卡片下面那条空隙），
 *   zone 为 beside 表示指在卡片下沿，意思是“放在它旁边，与它同级”；
 *   指在部门的成员或空白处时 onHeader 为 false，zone 固定为 into。
 */
export type DropHover =
  | { kind: 'root' }
  | { kind: 'department'; id: string; zone: 'into' | 'beside'; onHeader: boolean }

/** 高亮方式：into 放入、beside 同级、swap 互换位置、blocked 不允许。 */
export type DropMarkStyle = 'into' | 'beside' | 'swap' | 'blocked'
/** 提示标签的色调：idle 没有目标或无需移动，ok 可放，swap 互换，blocked 不允许。 */
export type DropTone = 'idle' | 'ok' | 'swap' | 'blocked'

export interface DropAction {
  /** 新的上级部门 id，null 表示顶级。 */
  parentId: string | null
  /** 被升为上级的下级部门 id；有值时走“升为上级”接口而不是“移动”。 */
  promoted?: string
  /** 先在页面上呈现的新部门树。 */
  departments: ApiDepartment[]
  /** 保存成功后的提示。 */
  success: string
}

export interface DropIntent {
  tone: DropTone
  /** 跟随指针的标签第二行，也是给读屏的说明。 */
  text: string
  /** 需要高亮的目标；没有目标时为 null。 */
  mark: { id: string; style: DropMarkStyle } | null
  /** 此刻松手会执行的移动；idle 和 blocked 时为 null。 */
  action: DropAction | null
}

export const IDLE_DROP_TEXT = '放在部门上＝成为下级，放在卡片下沿＝同级'

/** 名称卡片从上往下这个比例之后（含卡片下面的空隙）算“下沿”。 */
const BESIDE_ZONE_RATIO = 0.6

/** 指针在名称卡片的哪一部分：上部为 into，下沿及卡片下面的空隙为 beside。 */
export function headerZone(rect: { top: number; height: number }, y: number): 'into' | 'beside' {
  return y >= rect.top + rect.height * BESIDE_ZONE_RATIO ? 'beside' : 'into'
}

/**
 * 松手后被拖部门将归属到哪里，用来给那个部门整块铺底色：上级部门 id，顶级为 ROOT_DROP_ID。
 * 互换位置或此刻松手不会移动时为 null。
 */
export function landingOf(intent: DropIntent | null): string | null {
  const action = intent?.action
  if (!action || action.promoted) return null
  return action.parentId ?? ROOT_DROP_ID
}

export function sameHover(a: DropHover | null, b: DropHover | null): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'root' || b.kind === 'root') return true
  return a.id === b.id && a.zone === b.zone && a.onHeader === b.onHeader
}

/**
 * 根据指针所在位置，算出此刻松手会发生什么。纯函数：不读 DOM，不修改入参。
 *
 * 规则：
 * - 放在部门上（名称卡片的主体或它的成员区）= 成为它的下级；
 * - 放在名称卡片下沿 = 与它同级（成为它上级部门的下级，上级为空则是顶级）；
 *   当前所在的上级部门，整张卡片都表示“与它同级”，因为再放进去不会有变化；
 * - 放在公司根节点上 = 设为顶级部门；
 * - 放在自己的下级部门的名称卡片上 = 互换位置：那个下级升为上级。
 */
export function describeDrop(
  departments: readonly ApiDepartment[],
  draggedId: string,
  hover: DropHover | null,
): DropIntent {
  const idle = (text = IDLE_DROP_TEXT): DropIntent => ({ tone: 'idle', text, mark: null, action: null })
  const blocked = (markId: string | null, text: string): DropIntent => ({
    tone: 'blocked',
    text,
    mark: markId ? { id: markId, style: 'blocked' } : null,
    action: null,
  })
  const dragged = findDepartment(departments, draggedId)?.department
  if (!dragged || !hover) return idle()

  const currentParent = parentOf(departments, draggedId) ?? null
  // 用 moveDepartment 做层数、防环等校验并得到新部门树；通过后才给出可执行的动作。
  const plan = (
    parentId: string | null,
    mark: { id: string; style: DropMarkStyle },
    text: string,
    success: string,
  ): DropIntent => {
    const result = moveDepartment(departments, draggedId, parentId)
    if (!result.ok) return blocked(mark.id, result.reason)
    return {
      tone: result.promoted ? 'swap' : 'ok',
      text,
      mark,
      action: { parentId, promoted: result.promoted, departments: result.departments, success },
    }
  }

  if (hover.kind === 'root') {
    if (currentParent === null) return idle('已是顶级部门')
    return plan(null, { id: ROOT_DROP_ID, style: 'into' }, '设为顶级部门（直属公司）', `已将「${dragged.name}」设为顶级部门`)
  }

  if (hover.id === draggedId) return idle()
  const target = findDepartment(departments, hover.id)?.department
  if (!target) return idle()

  // 指在自己的下级部门上：只有指在名称卡片上才表示“让它升为上级”，指在成员区只是路过。
  if (isAncestor(departments, draggedId, hover.id)) {
    if (!hover.onHeader) return idle('要让下级升为上级，请放在它的名称卡片上')
    return plan(
      hover.id,
      { id: hover.id, style: 'swap' },
      `「${target.name}」升为上级，「${dragged.name}」成为它的下级`,
      `已让「${target.name}」升为上级，「${dragged.name}」成为它的下级`,
    )
  }

  const targetParent = parentOf(departments, hover.id) ?? null
  const beside = hover.zone === 'beside' || (hover.onHeader && currentParent === hover.id)
  if (beside) {
    if (targetParent === currentParent) return idle(targetParent === null ? '已是顶级部门' : `已与「${target.name}」同级`)
    return plan(
      targetParent,
      { id: hover.id, style: 'beside' },
      targetParent === null ? `设为顶级部门，与「${target.name}」同级` : `与「${target.name}」同级`,
      targetParent === null ? `已将「${dragged.name}」设为顶级部门` : `已将「${dragged.name}」调整为与「${target.name}」同级`,
    )
  }

  if (currentParent === hover.id) return idle(`已在「${target.name}」下面`)
  return plan(
    hover.id,
    { id: hover.id, style: 'into' },
    `放入「${target.name}」，成为它的下级`,
    `已将「${dragged.name}」放入「${target.name}」`,
  )
}
