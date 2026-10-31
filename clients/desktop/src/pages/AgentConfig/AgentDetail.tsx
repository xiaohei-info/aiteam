/**
 * 智能体详情编辑页，支持修改基本配置、人才、记忆和行为设置。
 *
 * @注意 agent prop 当前为 any 类型，接入真实数据后需强类型化。
 *       编辑操作为本地状态管理，保存时通过回调传出结果。
 * @events onBack 返回；onRecruit(agentId) 招募该智能体；onDismiss(agentId) 解雇该智能体
 */
import { useState, useMemo, useCallback, useRef } from 'react'
import { ChevronLeft, Zap, Database, Plus, Trash2, UserPlus, X, Save, RotateCcw, Camera } from 'lucide-react'
import styles from './AgentDetail.module.css'
import { EMPLOYEE_PRESENCE_UNAVAILABLE } from '../../lib/employeePresence'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { KNOWLEDGE_BASE_WRITE_AVAILABILITY } from '../../lib/serviceWriteAvailability'

interface AgentDetailProps {
  agent?: any
  onBack: () => void
  onRecruit?: (agentId: string) => void
  onDismiss?: (agentId: string) => void
}

interface Talent {
  id: string
  name: string
  category: string
}

interface Memory {
  id: string
  title: string
  type: string
  content: string
}

interface BehaviorSettings {
  delegateTask: boolean
  shareContext: boolean
  archiveMemory: boolean
}

interface AgentFormState {
  avatar: string
  name: string
  role: string
  prompt: string
  behaviors: BehaviorSettings
  talents: Talent[]
  memories: Memory[]
}

const INITIAL_TALENTS: Talent[] = [
  { id: 'talent-1', name: '统计分析', category: '分析' },
  { id: 'talent-2', name: '数据可视化', category: '生成' },
  { id: 'talent-3', name: 'SQL 查询优化', category: '分析' },
  { id: 'talent-4', name: '机器学习建模', category: '分析' },
]

const INITIAL_MEMORIES: Memory[] = [
  { id: 'mem-1', title: '行业最佳实践', type: 'context', content: '了解主要行业标准和最佳实践' },
  { id: 'mem-2', title: '报告标准', type: 'instruction', content: '所有报告必须包含执行摘要和数据来源' },
  { id: 'mem-3', title: '分析流程', type: 'pattern', content: '始终验证数据质量然后进行分析' },
]

const ALL_TALENTS: Talent[] = [
  { id: 'talent-1', name: '统计分析', category: '分析' },
  { id: 'talent-2', name: '数据可视化', category: '生成' },
  { id: 'talent-3', name: 'SQL 查询优化', category: '分析' },
  { id: 'talent-4', name: '机器学习建模', category: '分析' },
  { id: 'talent-5', name: '自然语言处理', category: '分析' },
  { id: 'talent-6', name: '报告撰写', category: '生成' },
  { id: 'talent-7', name: 'A/B 测试设计', category: '分析' },
  { id: 'talent-8', name: '数据清洗', category: '处理' },
]

const AVATARS = ['🤖', '🧠', '👨‍💻', '📊', '🎨', '📝', '💬', '🔧', '🔬', '🎯', '⚡', '🛡️']

const INITIAL_FORM_STATE: AgentFormState = {
  avatar: '📊',
  name: '数据分析师',
  role: '数据科学家',
  prompt: '你是一名专业的数据分析师，擅长统计建模、数据可视化和商业智能。提供清晰、可行的数据见解。始终用结构化的格式输出分析结果，包含摘要、关键发现和建议行动。',
  behaviors: {
    delegateTask: true,
    shareContext: true,
    archiveMemory: false,
  },
  talents: INITIAL_TALENTS,
  memories: INITIAL_MEMORIES,
}

export default function AgentDetail({ agent, onBack, onRecruit, onDismiss }: AgentDetailProps) {
  const [activeSection, setActiveSection] = useState<'prompt' | 'talents' | 'knowledge' | 'memory'>('prompt')
  const [showRecruitModal, setShowRecruitModal] = useState(false)
  const [isRecruiting, setIsRecruiting] = useState(false)
  const [recruited, setRecruited] = useState(agent?.recruited ?? false)
  const [showDismissModal, setShowDismissModal] = useState(false)
  const [isDismissing, setIsDismissing] = useState(false)
  const [showTalentPicker, setShowTalentPicker] = useState(false)
  const [pendingTalentIds, setPendingTalentIds] = useState<string[]>([])
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [editingRole, setEditingRole] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isSaving, setIsSaving] = useState(false)

  const [savedState, setSavedState] = useState<AgentFormState>(INITIAL_FORM_STATE)
  const [formState, setFormState] = useState<AgentFormState>(INITIAL_FORM_STATE)

  useGlobalShortcutClose({
    active: showRecruitModal,
    onClose: () => { if (!isRecruiting) setShowRecruitModal(false) },
  })
  useGlobalShortcutClose({
    active: showDismissModal,
    onClose: () => { if (!isDismissing) setShowDismissModal(false) },
  })
  useGlobalShortcutClose({ active: showTalentPicker, onClose: () => setShowTalentPicker(false) })
  useGlobalShortcutClose({ active: showAvatarPicker, onClose: () => setShowAvatarPicker(false) })

  const isDirty = useMemo(() => JSON.stringify(formState) !== JSON.stringify(savedState), [formState, savedState])

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    await new Promise(r => setTimeout(r, 600))
    setSavedState(formState)
    setIsSaving(false)
  }, [formState])

  const handleDiscard = useCallback(() => {
    setFormState(savedState)
  }, [savedState])

  const updateBehavior = useCallback((key: keyof BehaviorSettings) => {
    setFormState(prev => ({
      ...prev,
      behaviors: { ...prev.behaviors, [key]: !prev.behaviors[key] },
    }))
  }, [])

  const removeTalent = useCallback((id: string) => {
    setFormState(prev => ({
      ...prev,
      talents: prev.talents.filter(s => s.id !== id),
    }))
  }, [])

  const addTalent = useCallback(( talent: Talent) => {
    setPendingTalentIds(prev =>
      prev.includes(talent.id) ? prev.filter(id => id !== talent.id) : [...prev, talent.id]
    )
  }, [])

  const openTalentPicker = useCallback(() => {
    setPendingTalentIds(formState.talents.map(s => s.id))
    setShowTalentPicker(true)
  }, [formState.talents])

  const confirmTalentPicker = useCallback(() => {
    setFormState(prev => ({
      ...prev,
      talents: ALL_TALENTS.filter(s => pendingTalentIds.includes(s.id)),
    }))
    setShowTalentPicker(false)
  }, [pendingTalentIds])

  const handleAvatarUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setFormState(prev => ({ ...prev, avatar: reader.result as string }))
      setShowAvatarPicker(false)
    }
    reader.readAsDataURL(file)
  }, [])

  const removeMemory = useCallback((id: string) => {
    setFormState(prev => ({
      ...prev,
      memories: prev.memories.filter(m => m.id !== id),
    }))
  }, [])

  const agentData = agent ?? {
    emoji: '📊', name: '数据分析师', role: '数据科学家',
    status: 'idle', model: 'claude-opus-5',
    description: '专注于复杂数据分析、统计建模和可执行的商业见解。'
  }

  const handleDismiss = async () => {
    setIsDismissing(true)
    await new Promise(r => setTimeout(r, 800))
    setRecruited(false)
    setIsDismissing(false)
    onDismiss?.(agentData.id)
    setTimeout(() => setShowDismissModal(false), 800)
  }

  const handleRecruit = async () => {
    setIsRecruiting(true)
    await new Promise(r => setTimeout(r, 1200))
    setRecruited(true)
    setIsRecruiting(false)
    onRecruit?.(agentData.id)
    setTimeout(() => setShowRecruitModal(false), 1600)
  }

  return (
    <div className={styles.ad}>
      {/* 左栏：档案卡 */}
      <aside className={styles.adProfile}>
        <button
          className={styles.adBack}
          onClick={onBack}
          aria-keyshortcuts="Meta+W Control+W"
          title="返回智能体列表（⌘W / Ctrl+W）"
        >
          <ChevronLeft size={16} />
          <span>返回</span>
        </button>

        <div className={`${styles.adAvatar} ${styles.adAvatarEditable}`} onClick={() => setShowAvatarPicker(true)}>
          {formState.avatar.startsWith('data:') ? (
            <img src={formState.avatar} alt="avatar" className={styles.adAvatarImg} />
          ) : (
            formState.avatar
          )}
          <div className={styles.adAvatarOverlay}><Camera size={16} /></div>
        </div>

        {editingName ? (
          <input
            className={styles.adNameInput}
            value={formState.name}
            onChange={e => setFormState(prev => ({ ...prev, name: e.target.value }))}
            onBlur={() => setEditingName(false)}
            onKeyDown={e => e.key === 'Enter' && setEditingName(false)}
            autoFocus
          />
        ) : (
          <h1 className={`${styles.adName} ${styles.adNameEditable}`} onClick={() => setEditingName(true)}>{formState.name}</h1>
        )}

        {editingRole ? (
          <input
            className={styles.adRoleInput}
            value={formState.role}
            onChange={e => setFormState(prev => ({ ...prev, role: e.target.value }))}
            onBlur={() => setEditingRole(false)}
            onKeyDown={e => e.key === 'Enter' && setEditingRole(false)}
            autoFocus
          />
        ) : (
          <span className={`${styles.adRole} ${styles.adRoleEditable}`} onClick={() => setEditingRole(true)}>{formState.role}</span>
        )}

        <div
          className={`${styles.adStatus} ${styles.adStatusIdle}`}
          title={EMPLOYEE_PRESENCE_UNAVAILABLE.lastSeenLabel}
        >
          <span className={styles.adStatusDot} />
          {EMPLOYEE_PRESENCE_UNAVAILABLE.label}
        </div>

        <p className={styles.adDesc}>{agentData.description}</p>

        <div className={styles.adMeta}>
          <div className={styles.adMetaRow}>
            <span className={styles.adMetaLabel}>模型</span>
            <span className={styles.adMetaValue}>{agentData.model}</span>
          </div>
          <div className={styles.adMetaRow}>
            <span className={styles.adMetaLabel}>人才</span>
            <span className={styles.adMetaValue}>{formState.talents.length} 项</span>
          </div>
          <div className={styles.adMetaRow}>
            <span className={styles.adMetaLabel}>知识库</span>
            <span className={styles.adMetaValue}>不可用</span>
          </div>
          <div className={styles.adMetaRow}>
            <span className={styles.adMetaLabel}>记忆</span>
            <span className={styles.adMetaValue}>{formState.memories.length} 条</span>
          </div>
        </div>

        <div className={styles.adProfileActions}>
          {!recruited ? (
            <button className={styles.adBtnRecruit} onClick={() => setShowRecruitModal(true)}>
              <UserPlus size={14} />
              招募加入
            </button>
          ) : (
            <button className={`${styles.adBtnIcon} ${styles.adBtnDanger} ${styles.adBtnFull}`} title="解雇" onClick={() => setShowDismissModal(true)}>
              <Trash2 size={14} />
              <span>解雇</span>
            </button>
          )}
        </div>
      </aside>

      {/* 右栏：配置区 */}
      <main className={styles.adMain}>
        <nav className={styles.adNav}>
          {(['prompt', 'talents', 'knowledge', 'memory'] as const).map(key => (
            <button
              key={key}
              className={`${styles.adNavItem} ${activeSection === key ? styles.adNavItemActive : ''}`}
              onClick={() => setActiveSection(key)}
            >
              {key === 'prompt' && '系统提示词'}
              {key === 'talents' && '人才'}
              {key === 'knowledge' && '知识库'}
              {key === 'memory' && '记忆'}
            </button>
          ))}
        </nav>

        <div className={styles.adSection}>
          {activeSection === 'prompt' && (
            <>
              <div className={styles.adSectionHeader}>
                <h2>系统提示词</h2>
                <span className={styles.adHint}>定义智能体的行为和沟通风格</span>
              </div>
              <div className={styles.adPromptBox}>
                <textarea
                  value={formState.prompt}
                  onChange={e => setFormState(prev => ({ ...prev, prompt: e.target.value }))}
                  rows={8}
                  placeholder="输入系统提示词..."
                />
              </div>

              <div className={styles.adSectionHeader} style={{ marginTop: 32 }}>
                <h2>行为设置</h2>
              </div>
              <div className={styles.adToggleList}>
                <label className={styles.adToggle}>
                  <input type="checkbox" checked={formState.behaviors.delegateTask} onChange={() => updateBehavior('delegateTask')} />
                  <span className={styles.adToggleTrack} />
                  <span className={styles.adToggleText}>允许委托任务给其他成员</span>
                </label>
                <label className={styles.adToggle}>
                  <input type="checkbox" checked={formState.behaviors.shareContext} onChange={() => updateBehavior('shareContext')} />
                  <span className={styles.adToggleTrack} />
                  <span className={styles.adToggleText}>自动共享团队上下文</span>
                </label>
                <label className={styles.adToggle}>
                  <input type="checkbox" checked={formState.behaviors.archiveMemory} onChange={() => updateBehavior('archiveMemory')} />
                  <span className={styles.adToggleTrack} />
                  <span className={styles.adToggleText}>不活跃 30 天后归档记忆</span>
                </label>
              </div>
            </>
          )}

          {activeSection === 'talents' && (
            <>
              <div className={styles.adSectionHeader}>
                <h2>人才列表</h2>
                <button className={styles.adBtnAdd} onClick={openTalentPicker}><Plus size={14} /> 添加人才</button>
              </div>
              <div className={styles.adList}>
                {formState.talents.map(talent => (
                  <div key={talent.id} className={styles.adListItem}>
                    <Zap size={14} className={styles.adListIcon} />
                    <span className={styles.adListName}>{talent.name}</span>
                    <span className={styles.adListBadge}>{talent.category}</span>
                    <button className={styles.adListRemove} onClick={() => removeTalent(talent.id)}><X size={12} /></button>
                  </div>
                ))}
              </div>
            </>
          )}

          {activeSection === 'knowledge' && (
            <>
              <div className={styles.adSectionHeader}>
                <h2>知识库</h2>
                <button
                  className={styles.adBtnAdd}
                  type="button"
                  disabled
                  aria-describedby="agent-detail-kb-unavailable"
                  title={KNOWLEDGE_BASE_WRITE_AVAILABILITY.reason}
                >
                  <Plus size={14} /> 绑定知识库
                </button>
              </div>
              <div id="agent-detail-kb-unavailable" className={styles.adList} role="note">
                <div className={styles.adListItem}>
                  <Database size={14} className={styles.adListIcon} />
                  <span className={styles.adListName}>{KNOWLEDGE_BASE_WRITE_AVAILABILITY.reason}</span>
                </div>
              </div>
            </>
          )}

          {activeSection === 'memory' && (
            <>
              <div className={styles.adSectionHeader}>
                <h2>初始记忆</h2>
                <button className={styles.adBtnAdd}><Plus size={14} /> 添加记忆</button>
              </div>
              <div className={styles.adList}>
                {formState.memories.map(mem => (
                  <div key={mem.id} className={`${styles.adListItem} ${styles.adListItemMemory}`}>
                    <div className={styles.adMemoryLeft}>
                      <span className={styles.adMemoryTitle}>{mem.title}</span>
                      <span className={styles.adMemoryContent}>{mem.content}</span>
                    </div>
                    <span className={styles.adListBadge}>{mem.type === 'context' ? '上下文' : mem.type === 'instruction' ? '指令' : '模式'}</span>
                    <button className={styles.adListRemove} onClick={() => removeMemory(mem.id)}><X size={12} /></button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </main>

      {/* 保存操作栏 */}
      {isDirty && (
        <div className={styles.adSaveBar}>
          <span className={styles.adSaveHint}>有未保存的修改</span>
          <button className={styles.adSaveDiscard} onClick={handleDiscard} disabled={isSaving}>
            <RotateCcw size={13} />
            放弃
          </button>
          <button className={styles.adSaveConfirm} onClick={handleSave} disabled={isSaving}>
            <Save size={13} />
            {isSaving ? '保存中...' : '保存修改'}
          </button>
        </div>
      )}

      {/* 招募弹窗 */}
      {showRecruitModal && (
        <div className={styles.adModalOverlay} onClick={() => !isRecruiting && setShowRecruitModal(false)}>
          <div className={styles.adModal} onClick={e => e.stopPropagation()}>
            {!recruited ? (
              <>
                <h3>确认招募</h3>
                <p>确认添加 <strong>{agentData.name}</strong> 到你的 AI 团队？</p>
                <div className={styles.adModalSummary}>
                  <span>模型: {agentData.model}</span>
                  <span>人才: {formState.talents.length} 项</span>
                  <span>知识库: 当前不可用</span>
                </div>
                <div className={styles.adModalBtns}>
                  <button className={styles.adModalCancel} onClick={() => setShowRecruitModal(false)} disabled={isRecruiting}>取消</button>
                  <button className={styles.adModalConfirm} onClick={handleRecruit} disabled={isRecruiting}>
                    {isRecruiting ? '招募中...' : '确认'}
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.adModalSuccess}>
                <div className={styles.adSuccessIcon}>✓</div>
                <h3>招募成功</h3>
                <p>{agentData.name} 已加入团队</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 解雇弹窗 */}
      {showDismissModal && (
        <div className={styles.adModalOverlay} onClick={() => !isDismissing && setShowDismissModal(false)}>
          <div className={styles.adModal} onClick={e => e.stopPropagation()}>
            {recruited ? (
              <>
                <h3>确认解雇</h3>
                <p>确认将 <strong>{agentData.name}</strong> 从团队中移除？</p>
                <div className={styles.adModalBtns}>
                  <button className={styles.adModalCancel} onClick={() => setShowDismissModal(false)} disabled={isDismissing}>取消</button>
                  <button className={`${styles.adModalConfirm} ${styles.adModalConfirmDanger}`} onClick={handleDismiss} disabled={isDismissing}>
                    {isDismissing ? '解雇中...' : '确认解雇'}
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.adModalSuccess}>
                <div className={styles.adSuccessIcon}>✓</div>
                <h3>已解雇</h3>
                <p>{agentData.name} 已离开团队</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 人才选择弹窗 */}
      {showTalentPicker && (
        <div className={styles.adModalOverlay} onClick={() => setShowTalentPicker(false)}>
          <div className={styles.adModal} onClick={e => e.stopPropagation()}>
            <div className={styles.adModalHeader}>
              <h3>选择人才</h3>
              <button className={styles.adModalClose} onClick={() => setShowTalentPicker(false)}>
                <X size={16} />
              </button>
            </div>
            <div className={styles.adPickerList}>
              {ALL_TALENTS.map(talent => {
                const selected = pendingTalentIds.includes(talent.id)
                return (
                  <button
                    key={talent.id}
                    className={`${styles.adPickerItem} ${selected ? styles.adPickerItemSelected : ''}`}
                    onClick={() => addTalent(talent)}
                  >
                    <span className={styles.adPickerCheck}>{selected && '✓'}</span>
                    <span className={styles.adPickerName}>{talent.name}</span>
                    <span className={styles.adPickerBadge}>{talent.category}</span>
                  </button>
                )
              })}
            </div>
            <div className={styles.adModalFooter}>
              <button className={styles.adModalDone} onClick={confirmTalentPicker}>
                完成 ({pendingTalentIds.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 头像选择弹窗 */}
      {showAvatarPicker && (
        <div className={styles.adModalOverlay} onClick={() => setShowAvatarPicker(false)}>
          <div className={styles.adModal} onClick={e => e.stopPropagation()}>
            <div className={styles.adModalHeader}>
              <h3>选择头像</h3>
              <button className={styles.adModalClose} onClick={() => setShowAvatarPicker(false)}>
                <X size={16} />
              </button>
            </div>
            <div className={styles.adAvatarGrid}>
              {AVATARS.map(emoji => (
                <button
                  key={emoji}
                  className={`${styles.adAvatarOpt} ${formState.avatar === emoji ? styles.adAvatarOptSelected : ''}`}
                  onClick={() => { setFormState(prev => ({ ...prev, avatar: emoji })); setShowAvatarPicker(false) }}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className={styles.adModalFooter}>
              <button className={styles.adAvatarUploadBtn} onClick={() => fileInputRef.current?.click()}>
                <Camera size={14} />
                上传图片
              </button>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleAvatarUpload} />
          </div>
        </div>
      )}
    </div>
  )
}
