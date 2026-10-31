import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import type { ApiDepartment } from './api'
import { departmentIdFromDrag } from './DeptDragNode'
import { describeDrop, headerZone, sameHover, type DropHover, type DropIntent } from './dropIntent'
import { findDepartment } from './orgTree'

type Zone = 'into' | 'beside'
interface Point { x: number; y: number }

// 5px 之内按点击处理，避免影响点开员工菜单
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } }
// 指针贴近画布边缘时才自动滚动，避免在画布中部拖动时页面乱跑
const AUTO_SCROLL = { threshold: { x: 0.1, y: 0.1 } }
const GHOST_MARGIN = 8
// Tab 切走焦点时取消而不是放下，避免无意中提交一次移动。
const KEYBOARD_CODES = { start: ['Space', 'Enter'], cancel: ['Escape', 'Tab'], end: ['Space', 'Enter'] }

const DROP_TARGET_SELECTOR = '[data-org-drop]'
const KEYBOARD_TARGET_SELECTOR = '[data-org-drop="root"], [data-org-drop="head"]'

function hoverOfTarget(node: HTMLElement, zone: Zone, onHeader: boolean): DropHover | null {
  if (node.dataset.orgDrop === 'root') return { kind: 'root' }
  const id = node.dataset.deptId
  return id ? { kind: 'department', id, zone, onHeader } : null
}

// 指针下面是什么：公司根节点、部门名称卡片（区分上部与下沿），或某个部门的成员/空白区。
// 直接按页面实际布局命中，缩放和滚动都不需要换算。
function readHoverAt(container: HTMLElement | null, { x, y }: Point): DropHover | null {
  const node = document.elementFromPoint(x, y)?.closest<HTMLElement>(DROP_TARGET_SELECTOR)
  if (!node || !container?.contains(node)) return null
  if (node.dataset.orgDrop === 'head') return hoverOfTarget(node, headerZone(node.getBoundingClientRect(), y), true)
  return hoverOfTarget(node, 'into', false)
}

function placeGhost(ghost: HTMLElement, left: number, top: number) {
  const maxLeft = window.innerWidth - ghost.offsetWidth - GHOST_MARGIN
  const maxTop = window.innerHeight - ghost.offsetHeight - GHOST_MARGIN
  const x = Math.max(GHOST_MARGIN, Math.min(left, maxLeft))
  const y = Math.max(GHOST_MARGIN, Math.min(top, maxTop))
  ghost.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`
}

// 放在指针右下方；右边或下边放不下就翻到指针另一侧，始终不挡住指针所指的位置。
function placeGhostAtPointer(ghost: HTMLElement, { x, y }: Point) {
  const left = x + 16 + ghost.offsetWidth > window.innerWidth - GHOST_MARGIN ? x - ghost.offsetWidth - 12 : x + 16
  const top = y + 18 + ghost.offsetHeight > window.innerHeight - GHOST_MARGIN ? y - ghost.offsetHeight - 12 : y + 18
  placeGhost(ghost, left, top)
}

// 键盘拖动没有指针：放在目标卡片右侧，放不下就放到它下方。
function placeGhostBeside(ghost: HTMLElement, rect: DOMRect) {
  if (rect.right + 12 + ghost.offsetWidth <= window.innerWidth - GHOST_MARGIN) placeGhost(ghost, rect.right + 12, rect.top)
  else placeGhost(ghost, rect.left, rect.bottom + 8)
}

interface Options {
  departments: ApiDepartment[]
  /** 画布元素：只在它里面找放置目标。 */
  canvasRef: RefObject<HTMLElement | null>
  onStart?: () => void
  /** 松手时调用（取消不调用），带上此刻的判断结果，由页面决定保存、提示或忽略。 */
  onDrop: (departmentId: string, intent: DropIntent, viaKeyboard: boolean) => void
}

/**
 * 部门拖拽会话：拖动时不往页面里插任何占位或提示块，布局保持不动。
 * 指针在哪张卡片、卡片的哪一部分，直接决定松手后的结果（规则见 describeDrop），
 * 结果实时显示在跟随指针的卡片上，并通过 intent.mark 高亮目标。
 */
export function useDeptDrag({ departments, canvasRef, onStart, onDrop }: Options) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [viaKeyboard, setViaKeyboard] = useState(false)
  const [hover, setHover] = useState<DropHover | null>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  // 拖动中高频变化的值放在 ref 里，只有指向的目标变了才重新渲染页面。
  const session = useRef<{ id: string; viaKeyboard: boolean } | null>(null)
  const hoverRef = useRef<DropHover | null>(null)
  const pointRef = useRef<Point | null>(null)
  const keyboardRef = useRef<{ index: number; zone: Zone; node: HTMLElement | null }>({ index: 0, zone: 'into', node: null })
  const latest = useRef({ departments, onStart, onDrop })
  useLayoutEffect(() => {
    latest.current = { departments, onStart, onDrop }
  })

  const updateHover = useCallback((next: DropHover | null) => {
    if (sameHover(hoverRef.current, next)) return
    hoverRef.current = next
    setHover(next)
  }, [])

  const keyboardTargets = useCallback(
    () => Array.from(canvasRef.current?.querySelectorAll<HTMLElement>(KEYBOARD_TARGET_SELECTOR) ?? []),
    [canvasRef],
  )

  const aimKeyboard = useCallback((node: HTMLElement | undefined, zone: Zone) => {
    keyboardRef.current.node = node ?? null
    if (!node) return
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    updateHover(hoverOfTarget(node, zone, true))
  }, [updateHover])

  // 键盘拖动不按像素挪动，而是在“公司根节点 + 各部门名称卡片”之间按页面顺序跳：
  // 上下键换目标，右键＝放入（成为下级），左键＝同级。
  const keyboardCoordinates = useCallback<KeyboardCoordinateGetter>((event) => {
    const targets = keyboardTargets()
    if (!session.current || targets.length === 0) return
    let { index, zone } = keyboardRef.current
    switch (event.code) {
      case 'ArrowDown': index = Math.min(targets.length - 1, index + 1); break
      case 'ArrowUp': index = Math.max(0, index - 1); break
      case 'ArrowRight': zone = 'into'; break
      case 'ArrowLeft': zone = 'beside'; break
      default: return
    }
    event.preventDefault()
    keyboardRef.current = { index, zone, node: targets[index] ?? null }
    aimKeyboard(targets[index], zone)
    // 不返回坐标：位置由我们自己管理，dnd-kit 不需要移动任何东西。
  }, [keyboardTargets, aimKeyboard])

  const keyboardOptions = useMemo(() => ({ coordinateGetter: keyboardCoordinates, keyboardCodes: KEYBOARD_CODES }), [keyboardCoordinates])
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, keyboardOptions),
  )

  // 指针拖动：跟踪指针，每帧最多命中一次；画布自动滚动时指针没动，但指针下面的内容变了，也要重新命中。
  useEffect(() => {
    if (!draggingId || viaKeyboard) return
    let frame = 0
    const sync = () => {
      frame = 0
      const point = pointRef.current
      if (!point) return
      if (ghostRef.current) placeGhostAtPointer(ghostRef.current, point)
      updateHover(readHoverAt(canvasRef.current, point))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync) }
    const onMove = (event: PointerEvent) => {
      pointRef.current = { x: event.clientX, y: event.clientY }
      schedule()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('scroll', schedule, true)
    // 整个窗口保持“抓取”光标，指针经过按钮、文字时不会闪成别的样子。
    document.body.classList.add('oc-body-dragging')
    sync()
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('scroll', schedule, true)
      document.body.classList.remove('oc-body-dragging')
    }
  }, [draggingId, viaKeyboard, canvasRef, updateHover])

  // 说明文字变了，拖动卡片的尺寸也会变，渲染后按新尺寸重新摆放。
  useLayoutEffect(() => {
    const ghost = ghostRef.current
    if (!draggingId || !ghost) return
    if (viaKeyboard) {
      const node = keyboardRef.current.node
      if (node) placeGhostBeside(ghost, node.getBoundingClientRect())
    } else if (pointRef.current) {
      placeGhostAtPointer(ghost, pointRef.current)
    }
  }, [draggingId, viaKeyboard, hover])

  const reset = () => {
    session.current = null
    hoverRef.current = null
    pointRef.current = null
    keyboardRef.current = { index: 0, zone: 'into', node: null }
    setDraggingId(null)
    setViaKeyboard(false)
    setHover(null)
  }

  const handleDragStart = (event: DragStartEvent) => {
    const id = departmentIdFromDrag(event.active.id)
    const activator = event.activatorEvent
    const keyboard = Boolean(activator?.type.startsWith('key'))
    session.current = { id, viaKeyboard: keyboard }
    hoverRef.current = null
    setHover(null)
    setViaKeyboard(keyboard)
    setDraggingId(id)
    latest.current.onStart?.()
    if (keyboard) {
      const targets = keyboardTargets()
      const index = targets.findIndex(node => node.dataset.orgDrop === 'head' && node.dataset.deptId === id)
      keyboardRef.current = { index: Math.max(0, index), zone: 'into', node: targets[index] ?? null }
      aimKeyboard(targets[index], 'into')
    } else if (activator && 'clientX' in activator) {
      const { clientX, clientY } = activator as PointerEvent
      pointRef.current = { x: clientX, y: clientY }
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const current = session.current
    const id = current?.id ?? departmentIdFromDrag(event.active.id)
    const keyboard = current?.viaKeyboard ?? false
    // 以松手那一刻指针下面的目标为准，不依赖上一帧的结果。
    const point = pointRef.current
    const finalHover = !keyboard && point ? readHoverAt(canvasRef.current, point) : hoverRef.current
    reset()
    latest.current.onDrop(id, describeDrop(latest.current.departments, id, finalHover), keyboard)
  }

  const intent = useMemo(
    () => (draggingId ? describeDrop(departments, draggingId, hover) : null),
    [departments, draggingId, hover],
  )

  const accessibility = useMemo(() => ({
    screenReaderInstructions: {
      draggable: '按空格或回车拿起部门。拿起后用上下方向键选择目标部门，右方向键表示放入、成为它的下级，左方向键表示与它同级；再按空格或回车放下，按 Esc 取消。',
    },
    announcements: {
      onDragStart: ({ active }: { active: { id: string | number } }) => {
        const name = findDepartment(latest.current.departments, departmentIdFromDrag(active.id))?.department.name
        return `已拿起部门${name ? `「${name}」` : ''}。`
      },
      // 指向哪里、松手结果由页面自己的提示区播报，这里不重复。
      onDragOver: () => undefined,
      onDragEnd: () => undefined,
      onDragCancel: () => '已取消拖动，部门位置没有变化。',
    },
  }), [])

  return {
    draggingId,
    viaKeyboard,
    hover,
    intent,
    ghostRef,
    dndContextProps: {
      sensors,
      autoScroll: AUTO_SCROLL,
      accessibility,
      onDragStart: handleDragStart,
      onDragEnd: handleDragEnd,
      onDragCancel: reset,
    },
  }
}
