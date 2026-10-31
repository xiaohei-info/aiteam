import type { OrgMember } from './orgData'

export function OrgMemberCard({ member }: { member: OrgMember }) {
  return (
    <div className="group relative flex items-center gap-1.5 rounded-lg px-2 py-1 transition-all hover:bg-[var(--glass-bg)] cursor-default">
      <div className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-surface-3 text-[11px]">
        {member.emoji}
      </div>
      <span className="text-[11px] text-txt-secondary group-hover:text-txt-primary transition-colors whitespace-nowrap">
        {member.name}
      </span>
    </div>
  )
}
