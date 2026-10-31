/**
 * 知识库视图切换按钮（segmented control）。
 *
 * @description 内容区右上角的“列表 / 网格”切换器，选中态用金色主题色。
 *   仅负责展示与回调，视图状态与持久化由父组件维护。
 * @events onChange 当用户点击某一项时触发
 */
import { LayoutGrid, List } from 'lucide-react'

// 视图模式类型：列表或网格，持久化到 localStorage
export type KbViewMode = 'list' | 'grid'

interface KbViewToggleProps {
  value: KbViewMode
  onChange: (mode: KbViewMode) => void
  ariaLabel?: string
}

export default function KbViewToggle({ value, onChange, ariaLabel = '切换知识库视图' }: KbViewToggleProps) {
  return (
    <div className="kb-view-toggle" role="group" aria-label={ariaLabel}>
      {/* 列表视图按钮：选中态使用金色，未选中态使用 txt-secondary */}
      <button
        type="button"
        className={`kb-view-toggle-item ${value === 'list' ? 'active' : ''}`}
        onClick={() => onChange('list')}
        aria-pressed={value === 'list'}
        aria-label="列表视图"
        title="列表视图"
      >
        <List size={14} strokeWidth={1.8} />
      </button>
      {/* 网格视图按钮 */}
      <button
        type="button"
        className={`kb-view-toggle-item ${value === 'grid' ? 'active' : ''}`}
        onClick={() => onChange('grid')}
        aria-pressed={value === 'grid'}
        aria-label="网格视图"
        title="网格视图"
      >
        <LayoutGrid size={14} strokeWidth={1.8} />
      </button>
    </div>
  )
}
