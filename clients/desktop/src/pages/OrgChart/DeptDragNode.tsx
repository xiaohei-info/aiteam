import { forwardRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpDown, Ban, Building2, CornerDownRight, GripVertical, ListEnd, Move, Pencil, Trash2 } from 'lucide-react'
import { useDraggable } from '@dnd-kit/core'
import { ROOT_DROP_ID, type DropIntent, type DropMarkStyle } from './dropIntent'

const DRAG_ID_PREFIX = 'dept:'
const deptDragId = (departmentId: string) => `${DRAG_ID_PREFIX}${departmentId}`
export const departmentIdFromDrag = (dragId: string | number) => String(dragId).slice(DRAG_ID_PREFIX.length)

interface Props {
  departmentId: string
  name: string
  /** 有写权限且是真实部门：可拖动、可作为放置目标，并显示重命名/删除。 */
  enabled: boolean
  /** 正在保存上一次调整：暂时不能拖，按钮照常显示，避免卡片闪动。 */
  locked?: boolean
  className: string
  /** 拖动中指针指着这张卡片时的高亮方式。 */
  mark?: DropMarkStyle | null
  /** 键盘拖动时当前选中的目标（即使此刻松手不会移动，也要让人看到选在哪）。 */
  aimed?: boolean
  saving?: boolean
  justMoved?: boolean
  children: ReactNode
  onRename?: () => void
  onDelete?: () => void
}

// 部门名称卡片：可拖动；拖动时也是放置目标（data-org-drop="head"），上部＝放入，下沿＝同级。
// 键盘：Tab 聚焦后空格拿起，上下方向键选目标，右键放入、左键同级，空格放下，Esc 取消。
export function DeptDragNode({ departmentId, name, enabled, locked = false, className, mark, aimed, saving, justMoved, children, onRename, onDelete }: Props) {
  const drag = useDraggable({
    id: deptDragId(departmentId),
    disabled: !enabled || locked,
    attributes: { roleDescription: '可拖动的部门' },
  })
  const classes = [
    className,
    enabled && !locked && 'oc-draggable',
    drag.isDragging && 'is-drag-origin',
    saving && 'is-saving',
    justMoved && 'is-just-moved',
  ].filter(Boolean).join(' ')
  return (
    <div
      ref={drag.setNodeRef}
      className={classes}
      data-dept-id={departmentId}
      data-org-drop={enabled ? 'head' : undefined}
      data-drop={mark ?? undefined}
      data-aim={aimed ? '' : undefined}
      aria-busy={saving || undefined}
      {...(enabled ? drag.listeners : {})}
      {...(enabled ? drag.attributes : {})}
      {...(enabled ? { 'aria-label': `${name}，可拖动调整部门层级` } : {})}
    >
      {enabled && !locked && <GripVertical className="oc-dept-grip" size={10} strokeWidth={2} aria-hidden="true" />}
      {children}
      {enabled && onRename && (
        <button
          type="button"
          className="oc-dept-rename"
          aria-label={`重命名部门「${name}」`}
          title="重命名"
          // 不让按钮上的按下/空格启动拖拽
          onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRename() }}
        >
          <Pencil size={12} strokeWidth={1.8} />
        </button>
      )}
      {enabled && onDelete && (
        <button
          type="button"
          className="oc-dept-rename oc-dept-delete"
          aria-label={`删除部门「${name}」`}
          title="删除"
          onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onDelete() }}
        >
          <Trash2 size={12} strokeWidth={1.8} />
        </button>
      )}
    </div>
  )
}

interface GhostProps {
  name: string
  meta: string
  color: string
  intent: DropIntent
  viaKeyboard: boolean
}

function intentIcon(intent: DropIntent) {
  if (intent.tone === 'blocked') return Ban
  if (intent.tone === 'swap') return ArrowUpDown
  if (intent.tone === 'idle' || !intent.mark) return Move
  if (intent.mark.id === ROOT_DROP_ID) return Building2
  return intent.mark.style === 'beside' ? ListEnd : CornerDownRight
}

// 跟随指针的拖动卡片：上面是被拖的部门，下面一行实时说明“此刻松手会怎样”。
// 挂到 body 上，不受画布缩放和滚动裁剪影响；位置由 useDeptDrag 直接写 transform，不经过 React 渲染。
export const DeptDragGhost = forwardRef<HTMLDivElement, GhostProps>(function DeptDragGhost({ name, meta, color, intent, viaKeyboard }, ref) {
  const Icon = intentIcon(intent)
  return createPortal(
    <div ref={ref} className={`oc-ghost oc-ghost--${intent.tone}`} aria-hidden="true">
      <div className="oc-ghost-card">
        <span className="oc-ghost-bar" style={{ background: color }} />
        <div className="oc-ghost-text">
          <div className="oc-ghost-name">{name}</div>
          <div className="oc-ghost-meta">{meta}</div>
        </div>
      </div>
      <div className="oc-ghost-intent">
        <Icon size={13} strokeWidth={2} />
        <span>{intent.text}</span>
      </div>
      {viaKeyboard && <div className="oc-ghost-keys">↑↓ 选部门 · → 放入 · ← 同级 · 空格放下 · Esc 取消</div>}
    </div>,
    document.body,
  )
})
