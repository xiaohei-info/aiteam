import type { CSSProperties } from 'react'
import { Ban, CheckCircle2, LoaderCircle, MessageCircle, Plus } from 'lucide-react'
import { useEnterpriseWrite } from '../../hooks/useEnterpriseWrite'
import { runAgentCardAction } from './agentCardActions'
import { RECRUITMENT_AVAILABLE } from './api'
import OutputTypeIcon from './OutputTypeIcon'
import {
  CARD_METRIC_SLOTS,
  CARD_OUTPUT_TYPE_LIMIT,
  CARD_TAG_LIMIT,
  OUTPUT_TYPE_LABELS,
  talentCardMetrics,
  talentTagline,
} from './talentProfile'
import type { MarketTemplate } from './types'

interface AgentCardProps {
  agent: MarketTemplate
  index: number
  recruiting: boolean
  recruited: boolean
  canStartChat: boolean
  /** 已招募但当前不能对话的原因（缺授权、暂停、下架等）。 */
  chatBlockedReason?: string
  onClick: () => void
  onRecruit: () => void
  onStartChat: () => void
}

function rowStyle(index: number): CSSProperties {
  return {
    '--tm-index': index,
  } as CSSProperties
}

export default function AgentCard({
  agent,
  index,
  recruiting,
  recruited,
  canStartChat,
  chatBlockedReason,
  onClick,
  onRecruit,
  onStartChat,
}: AgentCardProps) {
  // 后端可能返回 null 的字段做兜底,避免 length 在 null 上崩溃
  const tags = agent.tags ?? []
  const skills = agent.skills ?? []
  const labels = tags.length ? tags : skills
  const displayTags = labels.slice(0, CARD_TAG_LIMIT)
  const hiddenTagCount = labels.length - displayTags.length
  const outputTypes = agent.profile.output_types.slice(0, CARD_OUTPUT_TYPE_LIMIT)
  const tagline = talentTagline(agent.profile.tagline, agent.description)
  // 固定 3 格：按 解决率 → 招募 → 计价 → 技能 → 模型 取有数据的，不足的格子留空，卡片高度不变。
  const stats = talentCardMetrics({
    profile: agent.profile,
    recruit_count: agent.recruit_count,
    skills_count: agent.skills_count,
    model: agent.default_model_ref?.model,
  })
  const emptySlots = Math.max(0, CARD_METRIC_SLOTS - stats.length)
  // 桌面端未接通招募接口时，未招募人才只能浏览，按钮禁用并引导去企业后台；已招募的走 handleStartChat 直接聊。
  const permission = useEnterpriseWrite()
  const chatBlocked = canStartChat && Boolean(chatBlockedReason)
  const recruitActionText = chatBlocked ? '暂不可对话' : canStartChat ? '开始对话' : RECRUITMENT_AVAILABLE ? '招募' : '请在企业后台招募'
  const recruitDisabled = recruiting || chatBlocked || (!canStartChat && (!RECRUITMENT_AVAILABLE || !permission.enabled))
  const showPrimaryAction = !recruited || canStartChat

  const handleRecruit = () => {
    runAgentCardAction('primary', canStartChat, {
      onDetail: onClick,
      onRecruit,
      onStartChat,
    })
  }

  return (
    <article
      className={`tm-agent-row ${recruited ? 'recruited' : ''}`}
      style={rowStyle(index)}
    >
      {recruited && (
        <span className="tm-agent-status">
          <CheckCircle2 size={13} strokeWidth={2} />
          已招募
        </span>
      )}

      <button
        type="button"
        className="tm-agent-summary"
        onClick={onClick}
        aria-label={`查看 ${agent.name} 详情`}
      >
        <span className="tm-agent-head">
          <span className="tm-agent-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</span>
          <span className="tm-agent-title-stack">
            <span className="tm-agent-name-row">
              <span className="tm-agent-name">{agent.name}</span>
            </span>
            <span className="tm-agent-role">{agent.category}</span>
          </span>
        </span>

        <span className="tm-agent-body">
          <span className="tm-agent-desc">{tagline}</span>
          <span className="tm-agent-meta-row">
            <span className="tm-agent-meta">
              {displayTags.map(tag => <span key={tag}>{tag}</span>)}
              {hiddenTagCount > 0 && <span>+{hiddenTagCount}</span>}
            </span>
            {outputTypes.length > 0 && (
              <span className="tm-agent-outputs" aria-label={`产出：${outputTypes.map(type => OUTPUT_TYPE_LABELS[type]).join('、')}`}>
                {outputTypes.map(type => (
                  <span key={type} title={OUTPUT_TYPE_LABELS[type]}><OutputTypeIcon type={type} /></span>
                ))}
              </span>
            )}
          </span>
        </span>

        <span className="tm-agent-stats" aria-label="人才数据">
          {stats.map(stat => (
            <span key={stat.label} className="tm-agent-stat">
              <span>{stat.label}</span>
              <strong title={stat.value} data-tone={stat.tone}>{stat.value}</strong>
            </span>
          ))}
          {Array.from({ length: emptySlots }, (_, slot) => (
            <span key={`empty-${slot}`} className="tm-agent-stat empty" aria-hidden="true" />
          ))}
        </span>
      </button>

      {showPrimaryAction && (
        <span className="tm-agent-actions">
          <button
            className="tm-agent-recruit"
            disabled={recruitDisabled}
            onClick={handleRecruit}
            type="button"
            title={chatBlocked ? chatBlockedReason : canStartChat ? undefined : RECRUITMENT_AVAILABLE ? permission.reason : '桌面端暂不支持招募，请在企业后台招募后再来对话'}
          >
            {recruiting && <LoaderCircle size={14} strokeWidth={2} className="spinning" />}
            {chatBlocked && !recruiting && <Ban size={14} strokeWidth={2} />}
            {canStartChat && !chatBlocked && !recruiting && <MessageCircle size={14} strokeWidth={2} />}
            {!canStartChat && !recruiting && <Plus size={14} strokeWidth={2} />}
            {recruitActionText}
          </button>
          {chatBlocked && <span className="tm-agent-blocked-reason" title={chatBlockedReason}>{chatBlockedReason}</span>}
        </span>
      )}
    </article>
  )
}
