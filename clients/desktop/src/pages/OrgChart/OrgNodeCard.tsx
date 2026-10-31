import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { OrgNode, OrgMember } from './orgData'
import { LEVEL_COLORS } from './orgData'
import { OrgMemberCard } from './OrgMemberCard'

interface Props {
  node: OrgNode
  members: OrgMember[]
  children?: React.ReactNode
  depth?: number
  isLast?: boolean
}

export function OrgNodeCard({ node, members, children, depth = 0, isLast = true }: Props) {
  const [expanded, setExpanded] = useState(true)
  const color = LEVEL_COLORS[node.level]
  const hasChildren = !!children

  return (
    <div className="relative">
      {depth > 0 && (
        <div
          className="absolute left-0 top-0 w-px"
          style={{ backgroundColor: `${color}25`, height: isLast ? '28px' : '100%' }}
        />
      )}

      <div className="relative flex flex-col" style={{ paddingLeft: depth > 0 ? '24px' : '0' }}>
        {depth > 0 && (
          <div className="absolute top-7 left-0 h-px w-6" style={{ backgroundColor: `${color}35` }} />
        )}

        <div
          className="relative mb-2 rounded-xl border overflow-hidden transition-all duration-200"
          style={{ borderColor: `${color}20`, backgroundColor: `${color}06` }}
        >
          <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-xl" style={{ backgroundColor: color }} />

          <div className="pl-4 pr-3 py-3">
            <div className="flex items-center gap-2 mb-2.5">
              {hasChildren && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex h-5 w-5 items-center justify-center rounded-md transition-all hover:bg-[var(--glass-bg)] active:scale-90"
                  style={{ color }}
                >
                  <ChevronRight size={12} strokeWidth={1.6} className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
                </button>
              )}
              <h3 className="font-display text-[13px] font-semibold" style={{ color }}>
                {node.name}
              </h3>
              <span
                className="rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${color}18`, color: `${color}bb` }}
              >
                {node.memberCount} 人
              </span>
              {node.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md px-1.5 py-0.5 text-[10px]"
                  style={{ backgroundColor: `${color}10`, color: `${color}99` }}
                >
                  {tag}
                </span>
              ))}
            </div>

            {members.length > 0 && (
              <div className="flex flex-wrap gap-0.5 pt-2 border-t" style={{ borderColor: `${color}12` }}>
                {members.map((m) => (
                  <OrgMemberCard key={m.id} member={m} />
                ))}
              </div>
            )}
          </div>
        </div>

        {hasChildren && expanded && (
          <div className="relative ml-3 flex flex-col gap-0">
            {children}
          </div>
        )}
      </div>
    </div>
  )
}
