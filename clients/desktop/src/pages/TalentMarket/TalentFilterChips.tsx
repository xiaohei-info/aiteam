// A5.2 已选筛选项 chip 展示条。放在列表区正上方,让用户一眼看到当前生效的筛选。
// 组件本身无状态,由父级 index.tsx 把已选值扁平化后传入,并提供"移除单个"和"清空全部"回调。
import { X } from 'lucide-react'

// 展示条的每一条 chip:label 是可读文案,onRemove 用于对应维度精确移除,而非重新算全量差集。
export interface ActiveFilterChip {
  // 唯一 key,避免同名跨维度 chip 冲突(如"数据分析"既可能是分类又可能是场景)
  key: string
  label: string
  onRemove: () => void
}

interface TalentFilterChipsProps {
  chips: ActiveFilterChip[]
  onClearAll: () => void
}

export default function TalentFilterChips({ chips, onClearAll }: TalentFilterChipsProps) {
  // 无任何筛选时整条隐藏,避免占用垂直空间。父级也可以做这个判断,这里再兜一次防御。
  if (chips.length === 0) return null

  return (
    <div className="tm-active-chips" role="group" aria-label="已选筛选项">
      {chips.map(chip => (
        <button
          key={chip.key}
          type="button"
          className="tm-active-chip"
          onClick={chip.onRemove}
          title={`移除筛选:${chip.label}`}
        >
          <span>{chip.label}</span>
          <X size={12} strokeWidth={2.2} />
        </button>
      ))}
      <button
        type="button"
        className="tm-active-chip-clear"
        onClick={onClearAll}
      >
        清空全部
      </button>
    </div>
  )
}
