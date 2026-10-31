/**
 * 知识库卡片，展示图标、名称、文档数量、更新时间和向量化进度条。
 *
 * @注意 纯展示组件，不包含业务逻辑。
 * @events onClick 点击卡片时触发（可选）
 */
import type { KnowledgeBase } from './types'

interface Props {
  item: KnowledgeBase
  onClick?: () => void
}

export default function KnowledgeBaseCard({ item, onClick }: Props) {
  return (
    <div onClick={onClick} className="glass-panel rounded-[14px] p-4 flex flex-col gap-3 hover:border-[var(--border-active)] transition-colors duration-150 cursor-pointer">
      <div className="text-[28px]">{item.icon}</div>
      <div>
        <div className="text-[14px] font-medium text-txt-primary">{item.name}</div>
        <div className="mt-1 text-[11px] text-txt-muted">{item.docCount} 文档 · 更新于{item.updatedAt}</div>
      </div>
      <div className="h-[3px] w-full rounded-full bg-surface-4 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600"
          style={{ width: `${item.progress}%` }}
        />
      </div>
    </div>
  )
}
