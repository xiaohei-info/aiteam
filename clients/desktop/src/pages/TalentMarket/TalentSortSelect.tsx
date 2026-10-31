// A5.3 排序切换控件。放在列表区右上角。
// 用原生 select 而非自绘 dropdown:
//   1. 选项固定 4 个,交互路径极短,不值得为它引入 Portal / focus trap;
//   2. 与市场首页整体"轻筛选"定位一致,不喧宾夺主;
//   3. 通过 CSS 变量套上金色主题描边和 hover 态,已经足以融入毛玻璃风格。
import type { ChangeEvent } from 'react'
import { ArrowDownUp } from 'lucide-react'

// 排序键统一常量,index.tsx 里的 useMemo 排序函数按此 switch。
// - composite:推荐(默认),沿用原来的 recruit_count 降序精选逻辑
// - recruits:已招募次数(recruit_count)降序；不能当作员工调用次数
// - resolution:解决率降序，样本不足的排后（议题 7）
// - updated:模板最近更新时间降序
// - price-asc / price-desc:价格升/降序；只供 sortMarketAgents 使用，议题 7 不在界面提供
export type TalentSortKey = 'composite' | 'recruits' | 'resolution' | 'updated' | 'price-asc' | 'price-desc'

interface TalentSortSelectProps {
  value: TalentSortKey
  onChange: (next: TalentSortKey) => void
}

// 单独抽出常量,方便后续增删排序项或做 i18n
const SORT_OPTIONS: Array<{ value: TalentSortKey; label: string }> = [
  { value: 'composite', label: '推荐' },
  { value: 'recruits', label: '招募最多' },
  { value: 'resolution', label: '解决率最高' },
  { value: 'updated', label: '最近更新' },
]

export default function TalentSortSelect({ value, onChange }: TalentSortSelectProps) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onChange(event.target.value as TalentSortKey)
  }

  return (
    <label className="tm-sort-select">
      <ArrowDownUp size={13} strokeWidth={1.8} />
      <span className="tm-sort-select-label">排序</span>
      <select value={value} onChange={handleChange}>
        {SORT_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}
