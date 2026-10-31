import { CodeXml, FileText, Plug, Presentation, Table2, type LucideIcon } from 'lucide-react'
import type { MarketplaceOutputType } from '../../api/agent/types'

const OUTPUT_TYPE_ICONS: Record<MarketplaceOutputType, LucideIcon> = {
  document: FileText,
  spreadsheet: Table2,
  code: CodeXml,
  presentation: Presentation,
  system_operation: Plug,
}

/** 产出类型图标：14px，名称由外层 title 提供。 */
export default function OutputTypeIcon({ type, size = 14 }: { type: MarketplaceOutputType; size?: number }) {
  const Icon = OUTPUT_TYPE_ICONS[type]
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />
}
