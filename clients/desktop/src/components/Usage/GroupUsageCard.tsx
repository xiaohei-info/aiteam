/**
 * 群聊详情「群聊用量」卡片：GET /api/agent/usage/statistics?conversation_id=…&group_by=employee，
 * 合计来自该会话已结算的工作记录；按成员拆分按 Token 从高到低。解决情况取本群段落评估。
 */
import { useEffect, useMemo, useState } from 'react'
import { useConversationSegments } from '../../hooks/useConversationSegments'
import { useUsageStatistics } from '../../hooks/useUsageStatistics'
import type { GroupMember } from '../../lib/groupRoster'
import { formatTokenCount, groupParticipation, groupUsageRows, splitUsageRows, tallySegmentOutcomes } from '../../lib/usageSummary'
import { usageRangeWindow, type UsageRange } from '../../lib/usageWindow'
import { useChatStore } from '../../stores/chat'
import { useOfficeMilestoneStore } from '../../stores/officeMilestones'
import GroupAvatar from '../Chat/GroupAvatar'
import UsageSummaryCard from './UsageSummaryCard'

// 群聊一般是项目型，「近 7 天」意义不大，只给两档。
const GROUP_RANGES: readonly UsageRange[] = ['today', 'all']

interface GroupUsageCardProps {
  groupId: string
  members: readonly GroupMember[]
  memberCount: number | null
}

export default function GroupUsageCard({ groupId, members, memberCount }: GroupUsageCardProps) {
  const [range, setRange] = useState<UsageRange>('today')
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { setRange('today'); setExpanded(false) }, [groupId])
  const scope = useMemo(() => ({ conversation_id: groupId, group_by: 'employee' as const }), [groupId])
  const { state, retry } = useUsageStatistics(scope, range)
  const usageVersion = useOfficeMilestoneStore((s) => s.usageVersion)
  const { byResetId } = useConversationSegments(groupId, usageVersion)
  const workbenchEmployees = useChatStore((s) => s.workbenchEmployees)
  const employees = useMemo(
    () => new Map(workbenchEmployees.map((employee) => [employee.employeeId, employee])),
    [workbenchEmployees],
  )
  const outcomes = tallySegmentOutcomes([...byResetId.values()], usageRangeWindow(range))

  return (
    <UsageSummaryCard
      title="群聊用量"
      ranges={GROUP_RANGES}
      range={range}
      onRangeChange={setRange}
      state={state}
      onRetry={retry}
      emptyText={range === 'today' ? '群里今天还没有员工执行记录' : '群里还没有员工执行记录'}
      execution={{ label: '员工执行', title: '员工执行次数，不是消息条数：一条群消息可能触发多位员工各执行一次' }}
      fourth={(data) => {
        const active = groupParticipation(data.groups ?? [], members)
        return {
          label: '参与员工',
          value: memberCount === null ? `${active}` : `${active} / ${memberCount}`,
          title: '时间范围内有执行记录的当前群成员 / 当前群成员数',
        }
      }}
      footnote="一条群消息可能触发多位员工各执行一次 · 仅统计你在这台设备上的使用"
    >
      {(data) => {
        const rows = groupUsageRows(data.groups ?? [], members, employees)
        const { visible, hidden } = splitUsageRows(rows, expanded)
        return (
          <>
            {rows.length > 0 && (
              <div className="usc-section">
                <span className="usc-section-title">按成员</span>
                {visible.map((row) => (
                  <div key={row.employeeId} className="usc-member" title={`${row.member.display_name} · ${row.tokens.toLocaleString('zh-CN')} Token · 占 ${row.share}%${row.cost.note ? ` · ${row.cost.note}` : ''}`}>
                    <GroupAvatar members={[row.member]} label={`${row.member.display_name}头像`} size="small" />
                    <span className="usc-member-name">
                      <span>{row.member.display_name}</span>
                      {row.coordinator && <span className="usc-member-tag planner">主持人</span>}
                      {row.removed && <span className="usc-member-tag">已移出</span>}
                    </span>
                    <span className={`usc-member-bar${row.coordinator ? ' planner' : ''}`}>
                      <span style={{ width: `${row.share}%` }} />
                    </span>
                    <span className="usc-member-value font-number">{formatTokenCount(row.tokens)}</span>
                    <span className="usc-member-value muted font-number">{row.cost.value}</span>
                  </div>
                ))}
                {hidden > 0 && <button type="button" className="usc-more" onClick={() => setExpanded(true)}>其他 {hidden} 位 ›</button>}
              </div>
            )}
            {outcomes.evaluated > 0 && (
              <div className="usc-resolution">
                <span>本群已评估 {outcomes.evaluated} 段</span>
                <strong>解决 {outcomes.resolved} 段</strong>
              </div>
            )}
          </>
        )
      }}
    </UsageSummaryCard>
  )
}
