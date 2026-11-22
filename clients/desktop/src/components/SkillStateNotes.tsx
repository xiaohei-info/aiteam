import { hasSkillProblems, type SkillStateGroups } from '../lib/skillReadiness'

/** 员工技能里有用不了的：分「企业已移除」「暂时不可用」两行说清楚；全部可用时什么都不显示。用 section 而不是 div：员工详情卡片的样式会把卡片的直接子 div 当成横排的标题栏。 */
export default function SkillStateNotes({ groups, className }: { groups: SkillStateGroups | null; className?: string }) {
  if (!groups || !hasSkillProblems(groups)) return null
  return (
    <section className={className ?? 'skill-state-notes'} role="note" aria-label="技能状态">
      {groups.available.length > 0 && <p>可用：{groups.available.join('、')}</p>}
      {groups.removed.length > 0 && <p>企业已移除：{groups.removed.join('、')}。员工用不了它们，其余能力不受影响。</p>}
      {groups.unavailable.length > 0 && <p>暂时不可用：{groups.unavailable.map(item => `${item.name}（${item.why}）`).join('、')}</p>}
    </section>
  )
}
