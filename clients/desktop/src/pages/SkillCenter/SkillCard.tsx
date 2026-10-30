import { Activity, Star } from 'lucide-react'
import type { Skill } from './types'

const CATEGORY_ACCENT: Record<string, string> = {
  data: 'from-emerald-500/20 to-emerald-600/5 border-emerald-500/20',
  text: 'from-violet-500/20 to-violet-600/5 border-violet-500/20',
  code: 'from-sky-500/20 to-sky-600/5 border-sky-500/20',
  design: 'from-rose-500/20 to-rose-600/5 border-rose-500/20',
  research: 'from-amber-500/20 to-amber-600/5 border-amber-500/20',
}

const CATEGORY_TEXT: Record<string, string> = {
  data: 'text-emerald-400',
  text: 'text-violet-400',
  code: 'text-sky-400',
  design: 'text-rose-400',
  research: 'text-amber-400',
}

interface Props {
  skill: Skill
  index: number
}

export default function SkillCard({ skill, index }: Props) {
  const accent = CATEGORY_ACCENT[skill.category] ?? 'from-surface-3 to-surface-2 border-[var(--border)]'
  const textColor = CATEGORY_TEXT[skill.category] ?? 'text-brand-300'

  return (
    <div
      className="group relative flex flex-col rounded-[16px] border border-[var(--border)] bg-surface-1 p-5 transition-all duration-300 hover:border-[var(--border-hover)] hover:translate-y-[-2px] hover:shadow-[0_8px_32px_rgba(0,0,0,0.3)] animate-fade-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className={`absolute inset-0 rounded-[16px] bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-300 ${accent}`} />

      <div className="relative z-10">
        <div className="flex items-start justify-between mb-3">
          <div className={`flex h-11 w-11 items-center justify-center rounded-[12px] bg-surface-3 text-xl ${textColor} ring-1 ring-[var(--border)] group-hover:ring-[var(--border-hover)] transition-all`}>
            {skill.icon}
          </div>
          <div className="flex items-center gap-1 text-[11px] text-txt-muted">
            <Star size={12} fill="currentColor" className="text-brand-400" />
            <span className="font-medium text-txt-secondary">{skill.rating}</span>
          </div>
        </div>

        <h3 className="font-display text-[14px] font-semibold text-txt-primary mb-1.5 group-hover:text-txt-primary transition-colors">
          {skill.name}
        </h3>
        <p className="text-[12px] text-txt-secondary leading-relaxed mb-4 line-clamp-2">
          {skill.description}
        </p>

        <div className="flex flex-wrap gap-1.5 mb-4">
          {skill.tags.slice(0, 3).map(tag => (
            <span
              key={tag}
              className="rounded-md bg-surface-3/80 px-2 py-0.5 text-[10px] font-medium text-txt-secondary ring-1 ring-[var(--border)]"
            >
              {tag}
            </span>
          ))}
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-[var(--border)]">
          <div className="flex items-center gap-1.5 text-[11px] text-txt-muted">
            <Activity size={12} strokeWidth={1.6} />
            <span>{skill.usageCount.toLocaleString()} 次调用</span>
          </div>
          <span className="text-[11px] text-txt-muted">{skill.author}</span>
        </div>
      </div>
    </div>
  )
}
