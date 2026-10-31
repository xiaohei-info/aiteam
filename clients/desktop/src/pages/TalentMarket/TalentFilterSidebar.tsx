// A5(设计 §5.5.2)左侧 220px 筛选栏。5 个维度:岗位分类、技能、价格、职级、应用场景。
// 组件本身是纯受控组件,所有状态由父级 index.tsx 持有,方便顶部"已选 chip"和"清空"按钮共享。
// 命名遵循项目规范:扁平状态类(.selected/.active),不使用 BEM;金色变量来自全局 --brand 系列。
import type { CSSProperties } from 'react'
import { RotateCcw } from 'lucide-react'
import type { MarketplaceOutputType, MarketplacePricingMode } from '../../api/agent/types'

// A5:筛选栏对应的多维数据结构。所有字段独立存储,便于"已选 chip"与"清空"按钮统一处理。
// 价格是 min-max 区间,其它维度均为多选数组(空数组代表不筛选)。
export interface TalentFilters {
  categories: string[]
  skills: string[]
  levels: string[]
  tags: string[]
  priceMin: number
  priceMax: number
  /** 议题 7：产出类型多选、计价方式多选、只看无需外部系统的人才。 */
  outputTypes: MarketplaceOutputType[]
  pricingModes: MarketplacePricingMode[]
  noExternalSystems: boolean
}

// A5:筛选栏的可选项来源(facets),由 index.tsx 从员工/模板数据派生;
// 若某个维度真实数据为空,index.tsx 会填入 fallback 常量,并加注释说明。
export interface TalentFacets {
  categories: string[]
  skills: string[]
  levels: string[]
  tags: string[]
}

interface TalentFilterSidebarProps {
  filters: TalentFilters
  facets: TalentFacets
  // 价格滑块的绝对上下界；当前按设计 §5.5.2 使用 ¥0–100。
  priceMin: number
  priceMax: number
  priceStep?: number
  priceAvailable: boolean
  onChange: (next: TalentFilters) => void
  onClear: () => void
  // 是否存在任意维度激活。true 时"清空"按钮点亮为金色,否则灰化。
  canClear: boolean
}

// 数组中切换单个值(存在则移除,不存在则追加)。多选 chip 的通用操作。
function toggleValue(arr: string[], value: string): string[] {
  return arr.includes(value) ? arr.filter(item => item !== value) : [...arr, value]
}

interface ChipGroupProps {
  title: string
  options: string[]
  selected: string[]
  onToggle: (value: string) => void
  emptyHint?: string
}

// 通用 chip 分区,复用于岗位分类、技能、职级、场景。价格滑块不走这条通道。
function ChipGroup({ title, options, selected, onToggle, emptyHint }: ChipGroupProps) {
  return (
    <div className="tm-filter-section">
      <div className="tm-filter-title">{title}</div>
      {options.length === 0 ? (
        <div className="tm-filter-empty">{emptyHint ?? '暂无可选'}</div>
      ) : (
        <div className="tm-filter-chips">
          {options.map(opt => {
            const active = selected.includes(opt)
            return (
              <button
                key={opt}
                type="button"
                className={`tm-filter-chip ${active ? 'selected' : ''}`}
                onClick={() => onToggle(opt)}
                aria-pressed={active}
              >
                {opt}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function TalentFilterSidebar({
  filters,
  facets,
  priceMin,
  priceMax,
  priceStep = 10,
  priceAvailable,
  onChange,
  onClear,
  canClear,
}: TalentFilterSidebarProps) {
  // 价格滑块的两个 range input 会各自触发 change,拖动时可能出现 min > max 的瞬时状态,
  // 因此这里 clamp 到另一端的当前值,保证区间恒定合法。
  const handlePriceMinChange = (raw: number) => {
    const next = Math.min(raw, filters.priceMax)
    onChange({ ...filters, priceMin: next })
  }
  const handlePriceMaxChange = (raw: number) => {
    const next = Math.max(raw, filters.priceMin)
    onChange({ ...filters, priceMax: next })
  }

  // 双 range 轨道的填充位置通过 CSS 变量传给 background 渐变,让选中区间显示金色。
  // 分母做防御:priceMax === priceMin 时,直接给 0/100 避免 NaN。
  const span = priceMax - priceMin || 1
  const rangeStyle: CSSProperties = {
    '--tm-range-start': `${((filters.priceMin - priceMin) / span) * 100}%`,
    '--tm-range-end': `${((filters.priceMax - priceMin) / span) * 100}%`,
  } as CSSProperties

  return (
    <aside className="tm-filter-sidebar" aria-label="人才筛选">
      <div className="tm-filter-header">
        <span className="tm-filter-brand">筛选</span>
        <button
          type="button"
          className={`tm-filter-reset ${canClear ? 'active' : ''}`}
          onClick={onClear}
          disabled={!canClear}
        >
          <RotateCcw size={12} strokeWidth={2} />
          清空
        </button>
      </div>

      <ChipGroup
        title="岗位分类"
        options={facets.categories}
        selected={filters.categories}
        onToggle={value => onChange({ ...filters, categories: toggleValue(filters.categories, value) })}
      />

      <ChipGroup
        title="技能"
        options={facets.skills}
        selected={filters.skills}
        onToggle={value => onChange({ ...filters, skills: toggleValue(filters.skills, value) })}
        emptyHint="技能名称待服务端提供"
      />

      <div className="tm-filter-section">
        <div className="tm-filter-title">价格</div>
        {priceAvailable ? (
          <>
            {/* 双 range 叠加实现 min-max 滑块。 */}
            <div className="tm-filter-price">
              <div className="tm-filter-price-track" style={rangeStyle} aria-hidden="true" />
              <input
                className="tm-filter-price-range"
                type="range"
                min={priceMin}
                max={priceMax}
                step={priceStep}
                value={filters.priceMin}
                onChange={e => handlePriceMinChange(Number(e.target.value))}
                aria-label="价格下限"
              />
              <input
                className="tm-filter-price-range"
                type="range"
                min={priceMin}
                max={priceMax}
                step={priceStep}
                value={filters.priceMax}
                onChange={e => handlePriceMaxChange(Number(e.target.value))}
                aria-label="价格上限"
              />
            </div>
            <div className="tm-filter-price-labels">
              <span>¥ {filters.priceMin}</span>
              <span>¥ {filters.priceMax}</span>
            </div>
          </>
        ) : (
          <div className="tm-filter-empty">价格数据待服务端提供</div>
        )}
      </div>

      <ChipGroup
        title="职级"
        options={facets.levels}
        selected={filters.levels}
        onToggle={value => onChange({ ...filters, levels: toggleValue(filters.levels, value) })}
        emptyHint="职级数据待服务端提供"
      />

      <ChipGroup
        title="标签"
        options={facets.tags}
        selected={filters.tags}
        onToggle={value => onChange({ ...filters, tags: toggleValue(filters.tags, value) })}
        emptyHint="暂无模板标签"
      />
    </aside>
  )
}
