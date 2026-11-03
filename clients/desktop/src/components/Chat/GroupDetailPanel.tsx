import { useCallback, useEffect, useState, type AnimationEvent } from 'react'
import { Check, ChevronDown, LoaderCircle, Pencil, UserPlus, X } from 'lucide-react'
import './AgentDetailPanel.css'
import './GroupDetailPanel.css'
import { agentApi } from '../../api/agent'
import { NO_GROUP_EDITING, type GroupEditCapabilities, type GroupMembersUpdateResult } from '../../api/agent/customGroups'
import type { ConversationMetadata, ExpertProjection } from '../../api/agent/types'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { resolveGroupDetails, type ResolvedGroupDetails } from '../../lib/groupDetails'
import { describeGroupEditError, memberEditAvailability } from '../../lib/groupMemberChange'
import { memberSubtitle, participantRoster } from '../../lib/groupRoster'
import { useChatStore } from '../../stores/chat'
import GroupAvatar from './GroupAvatar'
import GroupMembersDialog from './GroupMembersDialog'
import GroupOrchestrationCard from './GroupOrchestrationCard'
import GroupUsageCard from '../Usage/GroupUsageCard'

// 成员多于此数时先折叠，避免把编排规则和用量挤到很远的位置。
const COLLAPSED_MEMBER_COUNT = 6
// 约等于面板宽度下三行简介能放下的字数。
const DESCRIPTION_CLAMP_LENGTH = 60

const MODE_SUMMARY: Partial<Record<ResolvedGroupDetails['orchestrationMode'], string>> = {
  auto: '自动编排',
  custom: '自定义编排',
  fixed: '固定流程',
}

export default function GroupDetailPanel() {
  const { activeGroupId, groups, groupDetailOpen, groupSolutions } = useChatStore()
  const [visible, setVisible] = useState(groupDetailOpen)
  const [closing, setClosing] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [nameSaving, setNameSaving] = useState(false)
  const [nameStatus, setNameStatus] = useState('')
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [descriptionSaving, setDescriptionSaving] = useState(false)
  const [descriptionStatus, setDescriptionStatus] = useState('')
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  // null：尚在探测服务能力；探测结果是服务级的，切换群不需要重置。
  const [editCaps, setEditCaps] = useState<GroupEditCapabilities | null>(null)
  const [membersDialogOpen, setMembersDialogOpen] = useState(false)
  const [memberStatus, setMemberStatus] = useState('')
  const [membersExpanded, setMembersExpanded] = useState(false)
  const group = groups.find((g) => g.id === activeGroupId)
  const isCustomGroup = Boolean(group?.orchestration)
  const handleClose = useCallback(() => {
    useChatStore.setState({ groupDetailOpen: false })
  }, [])

  useGlobalShortcutClose({ active: groupDetailOpen, layer: 'panel', onClose: handleClose })

  useEffect(() => {
    if (groupDetailOpen) {
      setVisible(true)
      setClosing(false)
    } else if (visible) {
      setClosing(true)
    }
  }, [groupDetailOpen, visible])

  useEffect(() => {
    setEditingName(false)
    setNameDraft(group?.name ?? '')
    setNameSaving(false)
    setNameStatus('')
    setEditingDescription(false)
    setDescriptionDraft(group?.description ?? '')
    setDescriptionSaving(false)
    setDescriptionStatus('')
    setDescriptionExpanded(false)
  }, [group?.id, group?.name, group?.description])

  useEffect(() => {
    setMembersDialogOpen(false)
    setMemberStatus('')
    setMembersExpanded(false)
  }, [group?.id])

  // 成员与编排的写接口只在较新的 Agent 服务上存在，按 /openapi.json 探测，探测失败按不支持处理。
  useEffect(() => {
    if (!groupDetailOpen || !isCustomGroup) return undefined
    let cancelled = false
    agentApi.supportsGroupEditing()
      .then((capabilities) => { if (!cancelled) setEditCaps(capabilities) })
      .catch(() => { if (!cancelled) setEditCaps(NO_GROUP_EDITING) })
    return () => { cancelled = true }
  }, [groupDetailOpen, isCustomGroup, group?.id])

  if (!visible || !group) return null

  const handleAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
    if (event.currentTarget !== event.target) return
    if (closing) setVisible(false)
  }

  const members = group.members ?? []
  const details = resolveGroupDetails(group.solutionInstanceId, groupSolutions, group)
  const rawDescription = details.description?.trim() ?? ''
  const description = rawDescription === group.name ? '' : rawDescription
  const descriptionClamps = description.length > DESCRIPTION_CLAMP_LENGTH || description.split('\n').length > 3
  const heroMeta = [
    group.memberCount === null ? null : `${group.memberCount} 位成员`,
    MODE_SUMMARY[details.orchestrationMode],
  ].filter(Boolean).join(' · ')
  const visibleMembers = membersExpanded ? members : members.slice(0, COLLAPSED_MEMBER_COUNT)
  const hiddenMemberCount = members.length - visibleMembers.length
  const memberEdit = memberEditAvailability({
    isCustomGroup: Boolean(group.orchestration),
    rosterLoaded: group.rosterStatus === 'loaded',
    capabilities: editCaps,
  })

  const handleStartDescriptionEdit = () => {
    setDescriptionDraft(group.description ?? '')
    setDescriptionStatus('')
    setEditingDescription(true)
  }

  const handleCancelDescriptionEdit = () => {
    if (descriptionSaving) return
    setDescriptionDraft(group.description ?? '')
    setDescriptionStatus('')
    setEditingDescription(false)
  }

  const handleSaveDescription = async () => {
    const descriptionValue = descriptionDraft.trim()
    if (descriptionValue.length > 4000 || descriptionSaving) return
    if (descriptionValue === (group.description ?? '').trim()) {
      setEditingDescription(false)
      return
    }
    setDescriptionSaving(true)
    setDescriptionStatus('')
    try {
      const updated = await agentApi.updateConversation(group.id, { description: descriptionValue || null })
      useChatStore.setState((state) => ({
        groups: state.groups.map((item) => item.id === group.id ? { ...item, description: updated.description !== undefined ? updated.description : (descriptionValue || null) } : item),
      }))
      setEditingDescription(false)
      setDescriptionStatus('群简介已保存。')
    } catch (error) {
      setDescriptionStatus(describeGroupEditError(error, '群简介保存失败，请重试。'))
    } finally {
      setDescriptionSaving(false)
    }
  }

  const handleStartNameEdit = () => {
    setNameDraft(group.name)
    setNameStatus('')
    setEditingName(true)
  }

  const handleCancelNameEdit = () => {
    if (nameSaving) return
    setNameDraft(group.name)
    setNameStatus('')
    setEditingName(false)
  }

  const handleSaveName = async () => {
    const title = nameDraft.trim()
    if (!title || title.length > 200 || nameSaving) return
    if (title === group.name) {
      setEditingName(false)
      return
    }

    setNameSaving(true)
    setNameStatus('')
    try {
      const updated = await agentApi.updateConversation(group.id, { title })
      const nextName = updated.title?.trim() || title
      useChatStore.setState((state) => ({
        groups: state.groups.map((item) => item.id === group.id ? { ...item, name: nextName } : item),
      }))
      setNameDraft(nextName)
      setEditingName(false)
      setNameStatus('群名称已保存。')
    } catch {
      setNameStatus('群名称保存失败，请重试。')
    } finally {
      setNameSaving(false)
    }
  }

  const handleMembersSaved = (result: GroupMembersUpdateResult, experts: ExpertProjection[]) => {
    const roster = participantRoster(
      { conversation_id: group.id, participants: result.participants, employee_count: result.employee_count },
      experts,
    )
    useChatStore.setState((state) => ({
      groups: state.groups.map((item) => item.id === group.id ? {
        ...item,
        members: roster.members,
        memberCount: roster.memberCount,
        rosterStatus: roster.status,
        rosterMessage: roster.message,
        description: result.conversation.description !== undefined ? result.conversation.description : item.description,
        orchestration: result.conversation.orchestration ?? item.orchestration,
      } : item),
    }))
    setMembersDialogOpen(false)
    setMemberStatus('群成员已更新，下一轮对话生效。')
  }

  const handleOrchestrationSaved = (updated: ConversationMetadata) => {
    useChatStore.setState((state) => ({
      groups: state.groups.map((item) => item.id === group.id ? {
        ...item,
        orchestration: updated.orchestration ?? item.orchestration,
        description: updated.description !== undefined ? updated.description : item.description,
      } : item),
    }))
  }

  return (
    <aside className={`adp gdp${closing ? ' closing' : ''}`} aria-label="群聊详情" onAnimationEnd={handleAnimationEnd}>
      <div className="adp-inner">
        <div className="adp-header">
          <span className="adp-title">群聊详情</span>
          <button
            className="adp-close"
            onClick={handleClose}
            aria-label="关闭"
            aria-keyshortcuts="Meta+W Control+W"
            title="关闭群聊详情（⌘W / Ctrl+W）"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        <div className="adp-body">
          <header className="gdp-hero">
            <GroupAvatar
              members={members}
              label={`${group.name}群头像`}
              size="large"
              rosterDescription={group.rosterMessage}
            />
            {editingName ? (
              <form
                className="gdp-name-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleSaveName()
                }}
              >
                <input
                  autoFocus
                  className="gdp-name-input"
                  value={nameDraft}
                  maxLength={200}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    handleCancelNameEdit()
                  }}
                  aria-label="群名称"
                  disabled={nameSaving}
                />
                <button
                  type="submit"
                  className="gdp-icon-action save"
                  aria-label="保存群名称"
                  disabled={!nameDraft.trim() || nameSaving}
                  title="保存群名称"
                >
                  {nameSaving
                    ? <LoaderCircle className="gdp-spinner" size={14} aria-hidden="true" />
                    : <Check size={14} aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="gdp-icon-action"
                  onClick={handleCancelNameEdit}
                  aria-label="取消修改群名称"
                  disabled={nameSaving}
                  title="取消"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </form>
            ) : (
              <h2 className="gdp-name">
                <span>{group.name}</span>
                <button
                  type="button"
                  className="gdp-icon-action gdp-name-edit"
                  onClick={handleStartNameEdit}
                  aria-label="修改群名称"
                  title="修改群名称"
                >
                  <Pencil size={12} aria-hidden="true" />
                </button>
              </h2>
            )}
            {heroMeta && <p className="gdp-hero-meta">{heroMeta}</p>}
            {nameStatus && <p className="gdp-status" role="status">{nameStatus}</p>}
          </header>

          <section className="gdp-section" aria-label="群简介">
            <div className="gdp-section-header">
              <h3 className="gdp-section-title">群简介</h3>
              {isCustomGroup && !editingDescription && (
                <button type="button" className="gdp-action" onClick={handleStartDescriptionEdit}>
                  <Pencil size={12} aria-hidden="true" />编辑
                </button>
              )}
            </div>
            {editingDescription ? (
              <form className="gdp-editor" onSubmit={(event) => { event.preventDefault(); void handleSaveDescription() }}>
                <textarea value={descriptionDraft} maxLength={4000} onChange={(event) => setDescriptionDraft(event.target.value)} aria-label="群简介" autoFocus disabled={descriptionSaving} />
                <div className="gdp-editor-actions">
                  <button type="button" onClick={handleCancelDescriptionEdit} disabled={descriptionSaving}>取消</button>
                  <button type="submit" className="primary" disabled={descriptionSaving}>{descriptionSaving ? '保存中…' : '保存简介'}</button>
                </div>
              </form>
            ) : description ? (
              <div className={`gdp-description${descriptionExpanded ? ' expanded' : ''}`}>
                <p>{description}</p>
                {descriptionClamps && (
                  <button type="button" className="gdp-more" onClick={() => setDescriptionExpanded(value => !value)}>
                    {descriptionExpanded ? '收起' : '查看更多'}
                  </button>
                )}
              </div>
            ) : (
              <p className="gdp-placeholder">暂无群简介</p>
            )}
            {!isCustomGroup && <p className="gdp-note" role="note">该群不是自选成员群，简介、成员和编排规则暂不支持修改。</p>}
            {descriptionStatus && <p className="gdp-status" role="status">{descriptionStatus}</p>}
          </section>

          <section className="gdp-section" aria-label="群成员">
            <div className="gdp-section-header">
              <h3 className="gdp-section-title">
                群成员{group.memberCount !== null && <span className="gdp-section-count font-number">{group.memberCount}</span>}
              </h3>
              {isCustomGroup && (
                <button
                  type="button"
                  className="gdp-action"
                  disabled={!memberEdit.enabled}
                  title={memberEdit.enabled ? undefined : memberEdit.reason ?? '正在检测 Agent 能力…'}
                  onClick={() => { setMemberStatus(''); setMembersDialogOpen(true) }}
                >
                  <UserPlus size={12} aria-hidden="true" />管理
                </button>
              )}
            </div>
            {/* 成员来自后端 participants 接口；增减成员仅自选成员群且服务带 PATCH /participants 时可用。非自选成员群的原因已在群简介区说明，这里不重复。 */}
            {isCustomGroup && !memberEdit.enabled && memberEdit.reason && <p className="gdp-note" role="note">{memberEdit.reason}</p>}
            {members.length > 0 ? (
              <div className="gdp-member-list">
                {visibleMembers.map((m) => {
                  const subtitle = memberSubtitle(m)
                  return (
                    <div key={m.member_id} className="gdp-member-row">
                      <GroupAvatar members={[m]} label={`${m.display_name}头像`} size="small" />
                      <div className="gdp-member-info">
                        <span className="gdp-member-name">{m.display_name}</span>
                        {subtitle && <span className="gdp-member-role" title={subtitle}>{subtitle}</span>}
                      </div>
                      {m.is_system_planner && <span className="gdp-badge planner">主持人</span>}
                      {m.can_mention === false && <span className="gdp-badge unavailable">不可用</span>}
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="gdp-placeholder">当前没有可读取的群成员。</p>
            )}
            {hiddenMemberCount > 0 && (
              <button type="button" className="gdp-more" onClick={() => setMembersExpanded(true)}>
                查看全部 {members.length} 位<ChevronDown size={12} aria-hidden="true" />
              </button>
            )}
            {memberStatus && <p className="gdp-status" role="status">{memberStatus}</p>}
          </section>

          <GroupOrchestrationCard
            group={group}
            details={details}
            dedicatedEndpoint={editCaps?.orchestration ?? false}
            onSaved={handleOrchestrationSaved}
          />

          <GroupUsageCard groupId={group.id} members={members} memberCount={group.memberCount} />
        </div>
      </div>
      {membersDialogOpen && group.orchestration && (
        <GroupMembersDialog
          groupId={group.id}
          members={members}
          orchestration={group.orchestration}
          onClose={() => setMembersDialogOpen(false)}
          onSaved={handleMembersSaved}
        />
      )}
    </aside>
  )
}
