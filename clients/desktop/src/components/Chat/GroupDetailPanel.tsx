import { useCallback, useEffect, useState, type AnimationEvent } from 'react'
import { Check, LoaderCircle, Pencil, UserPlus, Users, X } from 'lucide-react'
import './AgentDetailPanel.css'
import { agentApi } from '../../api/agent'
import { NO_GROUP_EDITING, type GroupEditCapabilities, type GroupMembersUpdateResult } from '../../api/agent/customGroups'
import type { ConversationMetadata, ExpertProjection } from '../../api/agent/types'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { GROUP_TITLE_EDIT_OWNERSHIP_NOTE, resolveGroupDetails } from '../../lib/groupDetails'
import { describeGroupEditError, memberEditAvailability } from '../../lib/groupMemberChange'
import { participantRoster } from '../../lib/groupRoster'
import { useChatStore } from '../../stores/chat'
import GroupAvatar from './GroupAvatar'
import GroupMembersDialog from './GroupMembersDialog'
import GroupOrchestrationCard from './GroupOrchestrationCard'
import GroupUsageCard from '../Usage/GroupUsageCard'

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
  const description = details.description?.trim() ?? ''
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
    <aside className={`adp${closing ? ' closing' : ''}`} onAnimationEnd={handleAnimationEnd}>
      <div className="adp-inner">
        <div className="adp-header">
          <div className="adp-header-text">
            <span className="adp-title">详情</span>
            <span className="adp-subtitle">查看扩展信息。</span>
          </div>
          <button
            className="adp-close"
            onClick={handleClose}
            aria-label="关闭"
            aria-keyshortcuts="Meta+W Control+W"
            title="关闭群聊详情（⌘W / Ctrl+W）"
          >
            <X size={13} strokeWidth={1.8} />
          </button>
        </div>

        <div className="adp-body">
          {/* 群名 + 职责 */}
          <div className="adp-card adp-identity-card gdp-identity-card">
            <GroupAvatar
              members={members}
              label={`${group.name}群头像`}
              size="large"
              rosterDescription={group.rosterMessage}
            />
            <div className="adp-identity-info">
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
                    className="gdp-name-action save"
                    aria-label="保存群名称"
                    disabled={!nameDraft.trim() || nameSaving}
                    title="保存群名称"
                  >
                    {nameSaving
                      ? <LoaderCircle className="gdp-name-spinner" size={14} aria-hidden="true" />
                      : <Check size={14} aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="gdp-name-action"
                    onClick={handleCancelNameEdit}
                    aria-label="取消修改群名称"
                    disabled={nameSaving}
                    title="取消"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </form>
              ) : (
                <div className="gdp-name-row">
                  <span className="adp-user-name">{group.name}</span>
                  <button
                    type="button"
                    className="gdp-name-action"
                    onClick={handleStartNameEdit}
                    aria-label="修改群名称"
                    title="修改群名称"
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                </div>
              )}
              <span className="gdp-name-ownership" title={GROUP_TITLE_EDIT_OWNERSHIP_NOTE}>仅当前会话所有者可修改名称</span>
              {editingDescription ? (
                <form className="gdp-description-editor" onSubmit={(event) => { event.preventDefault(); void handleSaveDescription() }}>
                  <textarea value={descriptionDraft} maxLength={4000} onChange={(event) => setDescriptionDraft(event.target.value)} aria-label="群简介" autoFocus disabled={descriptionSaving} />
                  <div className="gdp-rule-actions">
                    <button type="button" onClick={handleCancelDescriptionEdit} disabled={descriptionSaving}>取消</button>
                    <button type="submit" className="primary" disabled={descriptionSaving}>{descriptionSaving ? '保存中…' : '保存'}</button>
                  </div>
                </form>
              ) : (
                <>
                  {description && description !== group.name && (
                    <div className={`gdp-description-wrap${descriptionExpanded ? ' expanded' : ''}`}>
                      <span className="adp-user-role gdp-description">{description}</span>
                      {description.length > 120 && <button type="button" className="gdp-expand-button" onClick={() => setDescriptionExpanded(value => !value)}>{descriptionExpanded ? '收起' : '查看更多'}</button>}
                    </div>
                  )}
                  <button type="button" className="gdp-inline-edit" disabled={!isCustomGroup} onClick={handleStartDescriptionEdit}><Pencil size={12} />编辑简介</button>
                </>
              )}
              <p className="gdp-field-note" role="note">
                {isCustomGroup
                  ? '群简介通过会话详情接口保存；成员和编排规则的修改在下一轮对话生效。'
                  : '该群不是自选成员群，简介、成员和编排规则暂不支持修改。'}
              </p>
              {descriptionStatus && <p className="gdp-name-status" role="status">{descriptionStatus}</p>}
              {nameStatus && <p className="gdp-name-status" role="status">{nameStatus}</p>}
            </div>
          </div>

          <GroupUsageCard groupId={group.id} members={members} memberCount={group.memberCount} />

          {/* 群成员 */}
          <div className="adp-card">
            <div className="adp-card-header">
              <Users size={13} strokeWidth={1.8} className="adp-card-icon" />
              <span className="adp-card-title">
                群成员{group.memberCount === null ? '' : ` · ${group.memberCount}`}
              </span>
              <button
                type="button"
                className="gdp-inline-edit gdp-card-action"
                disabled={!memberEdit.enabled}
                title={memberEdit.enabled ? undefined : memberEdit.reason ?? '正在检测 Agent 能力…'}
                onClick={() => { setMemberStatus(''); setMembersDialogOpen(true) }}
              >
                <UserPlus size={12} aria-hidden="true" />管理成员
              </button>
            </div>
            {/* 成员来自后端 participants 接口；增减成员仅自选成员群且服务带 PATCH /participants 时可用，其余情况入口置灰并说明原因。 */}
            {!memberEdit.enabled && memberEdit.reason && <p className="gdp-field-note" role="note">{memberEdit.reason}</p>}
            {members.length > 0 ? (
              <div className="gdp-member-list">
                {members.map((m) => (
                  <div key={m.member_id} className="gdp-member-row">
                    <GroupAvatar members={[m]} label={`${m.display_name}头像`} size="small" />
                    <div className="gdp-member-info">
                      <span className="gdp-member-name">{m.display_name}</span>
                      <span className="gdp-member-role">{m.department_name ?? (m.department_ids?.join(' / ') || '部门未设置')} · {m.role_name ?? '岗位未设置'}</span>
                    </div>
                    {m.is_system_planner && (
                      <span className="gdp-status-badge gdp-status-planner">主持人</span>
                    )}
                    {m.can_mention === false && (
                      <span className="gdp-status-badge gdp-status-unavailable">不可用</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <span className="adp-empty-text">当前没有可读取的群成员。</span>
            )}
            {memberStatus && <p className="gdp-name-status" role="status">{memberStatus}</p>}
          </div>

          {/* 编排规则 */}
          <GroupOrchestrationCard
            group={group}
            details={details}
            dedicatedEndpoint={editCaps?.orchestration ?? false}
            onSaved={handleOrchestrationSaved}
          />
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
