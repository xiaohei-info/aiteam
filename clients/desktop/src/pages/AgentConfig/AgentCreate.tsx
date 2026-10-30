/**
 * 智能体创建表单页面，支持配置基本信息、头像和人才。
 *
 * @注意 人才列表当前为 mock 数据；知识库契约未接入前绑定入口保持禁用。
 * @events onBack 返回列表页；onCreateSuccess(agent) 创建成功后携带新智能体数据
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronLeft, Plus, X, Zap, Database, Sparkles, Camera } from 'lucide-react'
import styles from './AgentCreate.module.css'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { KNOWLEDGE_BASE_WRITE_AVAILABILITY } from '../../lib/serviceWriteAvailability'

interface AvailableTalent {
  id: string
  name: string
  category: 'analysis' | 'generation' | 'integration'
}

const AVAILABLE_TALENTS: AvailableTalent[] = [
  { id: 'talent-1', name: '统计分析', category: 'analysis' },
  { id: 'talent-2', name: '数据可视化', category: 'generation' },
  { id: 'talent-3', name: 'SQL 查询优化', category: 'analysis' },
  { id: 'talent-4', name: '机器学习建模', category: 'analysis' },
  { id: 'talent-5', name: '代码审查', category: 'analysis' },
  { id: 'talent-6', name: '文档编写', category: 'generation' },
  { id: 'talent-7', name: 'API 集成', category: 'integration' },
]

const AVATARS = ['🤖', '🧠', '👨‍💻', '📊', '🎨', '📝', '💬', '🔧', '🔬', '🎯', '⚡', '🛡️']

interface AgentCreateProps {
  onBack: () => void
  onCreateSuccess: (agent: any) => void
}

export default function AgentCreate({ onBack, onCreateSuccess }: AgentCreateProps) {
  const [formData, setFormData] = useState({
    name: '',
    role: '',
    avatar: '🤖',
    description: '',
    model: 'claude-opus-5',
    systemPrompt: '',
    allowDelegation: true,
    shareContext: true,
    autoArchive: false,
  })
  const [selectedTalents, setSelectedTalents] = useState<string[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [showTalentPicker, setShowTalentPicker] = useState(false)
  const [showDescModal, setShowDescModal] = useState(false)
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const descRef = useRef<HTMLParagraphElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDescOverflow, setIsDescOverflow] = useState(false)

  useGlobalShortcutClose({ active: showTalentPicker, onClose: () => setShowTalentPicker(false) })
  useGlobalShortcutClose({ active: showDescModal, onClose: () => setShowDescModal(false) })
  useGlobalShortcutClose({ active: showAvatarPicker, onClose: () => setShowAvatarPicker(false) })

  useEffect(() => {
    if (!descRef.current) return
    const checkOverflow = () => {
      const lineHeight = parseInt(window.getComputedStyle(descRef.current!).lineHeight)
      const height = descRef.current!.scrollHeight
      const lines = Math.ceil(height / lineHeight)
      setIsDescOverflow(lines > 3)
    }
    checkOverflow()
    window.addEventListener('resize', checkOverflow)
    return () => window.removeEventListener('resize', checkOverflow)
  }, [formData.description])

  const updateField = (field: string, value: string | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const toggleTalent = (talentId: string) => {
    setSelectedTalents(prev =>
      prev.includes(talentId)
        ? prev.filter(id => id !== talentId)
        : [...prev, talentId]
    )
  }

  const removeTalent = (talentId: string) => {
    setSelectedTalents(prev => prev.filter(id => id !== talentId))
  }

  const handleAvatarUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setFormData(prev => ({ ...prev, avatar: reader.result as string }))
      setShowAvatarPicker(false)
    }
    reader.readAsDataURL(file)
  }, [])

  const isValid = formData.name && formData.role && formData.description && formData.systemPrompt

  const handleCreate = async () => {
    if (!isValid) return
    setIsCreating(true)
    await new Promise(resolve => setTimeout(resolve, 1500))

    const newAgent = {
      id: `agent-${Date.now()}`,
      emoji: formData.avatar,
      name: formData.name,
      role: formData.role,
      description: formData.description,
      dept: '新建部门',
      status: 'idle',
      model: formData.model,
      talents: selectedTalents,
    }

    setIsCreating(false)
    onCreateSuccess(newAgent)
  }

  const categoryLabel = (cat: string) => {
    if (cat === 'analysis') return '分析'
    if (cat === 'generation') return '生成'
    return '集成'
  }

  return (
    <div className={styles.ac}>
      {/* 左栏：实时预览 */}
      <aside className={styles.acPreview}>
        <button
          className={styles.acBack}
          onClick={onBack}
          aria-keyshortcuts="Meta+W Control+W"
          title="返回智能体列表（⌘W / Ctrl+W）"
        >
          <ChevronLeft size={16} />
          <span>返回</span>
        </button>

        <div className={styles.acPreviewCard}>
          <div className={styles.acPreviewAvatar}>
            {formData.avatar.startsWith('data:') ? (
              <img src={formData.avatar} alt="avatar" className={styles.acPreviewAvatarImg} />
            ) : (
              formData.avatar
            )}
          </div>
          <h2 className={styles.acPreviewName}>{formData.name || '智能体名称'}</h2>
          <span className={styles.acPreviewRole}>{formData.role || '岗位/角色'}</span>

          <div className={styles.acPreviewStatus}>
            <span className={styles.acPreviewDot} />
            预览
          </div>

          <div className={styles.acPreviewDescContainer}>
            <p className={styles.acPreviewDesc} ref={descRef}>
              {formData.description || '职位描述将显示在这里...'}
            </p>
            {isDescOverflow && (
              <button
                className={styles.acPreviewDescMore}
                onClick={() => setShowDescModal(true)}
              >
                查看更多
              </button>
            )}
          </div>

          <div className={styles.acPreviewMeta}>
            <div className={styles.acPreviewMetaRow}>
              <span className={styles.acPreviewMetaLabel}>模型</span>
              <span className={styles.acPreviewMetaValue}>{formData.model}</span>
            </div>
            <div className={styles.acPreviewMetaRow}>
              <span className={styles.acPreviewMetaLabel}>人才</span>
              <span className={styles.acPreviewMetaValue}>{selectedTalents.length} 项</span>
            </div>
            <div className={styles.acPreviewMetaRow}>
              <span className={styles.acPreviewMetaLabel}>知识库</span>
              <span className={styles.acPreviewMetaValue}>不可用</span>
            </div>
          </div>
        </div>

        <button
          className={styles.acBtnCreate}
          onClick={handleCreate}
          disabled={!isValid || isCreating}
        >
          {isCreating ? (
            <>
              <span className={styles.acSpinner} />
              创建中...
            </>
          ) : (
            <>
              <Sparkles size={14} />
              创建智能体
            </>
          )}
        </button>
      </aside>

      {/* 右栏：表单区 */}
      <main className={styles.acMain}>
        <div className={styles.acForm}>
          {/* 基本信息 */}
          <section className={styles.acSection}>
            <div className={styles.acSectionHeader}>
              <h2>基本信息</h2>
              <span className={styles.acHint}>定义智能体的身份</span>
            </div>

            <div className={styles.acAvatarRow}>
              <span className={styles.acFieldLabel}>头像</span>
              <div className={styles.acAvatarCurrent} onClick={() => setShowAvatarPicker(true)}>
                {formData.avatar.startsWith('data:') ? (
                  <img src={formData.avatar} alt="avatar" className={styles.acAvatarCurrentImg} />
                ) : (
                  <span className={styles.acAvatarCurrentEmoji}>{formData.avatar}</span>
                )}
                <div className={styles.acAvatarCurrentOverlay}><Camera size={14} /></div>
              </div>
            </div>

            <div className={styles.acField}>
              <label className={styles.acFieldLabel}>名称 <span className={styles.acRequired}>*</span></label>
              <input
                type="text"
                value={formData.name}
                onChange={e => updateField('name', e.target.value)}
                placeholder="例如：数据分析师"
              />
            </div>

            <div className={styles.acField}>
              <label className={styles.acFieldLabel}>岗位/角色 <span className={styles.acRequired}>*</span></label>
              <input
                type="text"
                value={formData.role}
                onChange={e => updateField('role', e.target.value)}
                placeholder="例如：数据科学家"
              />
            </div>

            <div className={styles.acField}>
              <label className={styles.acFieldLabel}>职位描述 <span className={styles.acRequired}>*</span></label>
              <textarea
                value={formData.description}
                onChange={e => updateField('description', e.target.value)}
                placeholder="描述这个智能体的专业领域和能力..."
                rows={3}
              />
            </div>
          </section>

          {/* 模型和提示词 */}
          <section className={styles.acSection}>
            <div className={styles.acSectionHeader}>
              <h2>模型 & 提示词</h2>
              <span className={styles.acHint}>设置 AI 行为</span>
            </div>

            <div className={styles.acField}>
              <label className={styles.acFieldLabel}>选择模型</label>
              <select
                value={formData.model}
                onChange={e => updateField('model', e.target.value)}
              >
                <option value="claude-opus-5">Claude Opus 5 (最高级)</option>
                <option value="claude-sonnet-5">Claude Sonnet 5 (高级)</option>
                <option value="claude-fable-5">Claude Fable 5 (标准)</option>
                <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (轻量)</option>
              </select>
            </div>

            <div className={styles.acField}>
              <label className={styles.acFieldLabel}>系统提示词 <span className={styles.acRequired}>*</span></label>
              <textarea
                value={formData.systemPrompt}
                onChange={e => updateField('systemPrompt', e.target.value)}
                placeholder="定义智能体的行为、专业知识和沟通风格..."
                rows={5}
              />
              <span className={styles.acCharCount}>{formData.systemPrompt.length} / 2000</span>
            </div>

            <div className={styles.acToggleList}>
              <label className={styles.acToggle}>
                <input
                  type="checkbox"
                  checked={formData.allowDelegation}
                  onChange={e => updateField('allowDelegation', e.target.checked)}
                />
                <span className={styles.acToggleTrack} />
                <span className={styles.acToggleText}>允许委托任务给其他成员</span>
              </label>
              <label className={styles.acToggle}>
                <input
                  type="checkbox"
                  checked={formData.shareContext}
                  onChange={e => updateField('shareContext', e.target.checked)}
                />
                <span className={styles.acToggleTrack} />
                <span className={styles.acToggleText}>自动共享团队上下文</span>
              </label>
              <label className={styles.acToggle}>
                <input
                  type="checkbox"
                  checked={formData.autoArchive}
                  onChange={e => updateField('autoArchive', e.target.checked)}
                />
                <span className={styles.acToggleTrack} />
                <span className={styles.acToggleText}>不活跃 30 天后归档记忆</span>
              </label>
            </div>
          </section>

          {/* 人才 */}
          <section className={styles.acSection}>
            <div className={styles.acSectionHeader}>
              <h2>人才</h2>
              <button className={styles.acBtnAdd} onClick={() => setShowTalentPicker(true)}>
                <Plus size={14} /> 添加
              </button>
            </div>

            {selectedTalents.length === 0 ? (
              <div className={styles.acEmpty}>
                <Zap size={16} />
                <span>点击"添加"选择人才</span>
              </div>
            ) : (
              <div className={styles.acList}>
                {selectedTalents.map(talentId => {
                  const talent = AVAILABLE_TALENTS.find(s => s.id === talentId)
                  if (!talent) return null
                  return (
                    <div key={talentId} className={styles.acListItem}>
                      <Zap size={14} className={styles.acListIcon} />
                      <span className={styles.acListName}>{talent.name}</span>
                      <span className={styles.acListBadge}>{categoryLabel(talent.category)}</span>
                      <button className={styles.acListRemove} onClick={() => removeTalent(talentId)}>
                        <X size={12} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* 知识库 */}
          <section className={styles.acSection}>
            <div className={styles.acSectionHeader}>
              <h2>知识库</h2>
              <button
                className={styles.acBtnAdd}
                type="button"
                disabled
                aria-describedby="agent-create-kb-unavailable"
                title={KNOWLEDGE_BASE_WRITE_AVAILABILITY.reason}
              >
                <Plus size={14} /> 绑定
              </button>
            </div>
            <div id="agent-create-kb-unavailable" className={styles.acEmpty} role="note">
              <Database size={16} />
              <span>{KNOWLEDGE_BASE_WRITE_AVAILABILITY.reason}</span>
            </div>
          </section>
        </div>
      </main>

      {/* 人才选择弹窗 */}
      {showTalentPicker && (
        <div className={styles.acModalOverlay} onClick={() => setShowTalentPicker(false)}>
          <div className={styles.acModal} onClick={e => e.stopPropagation()}>
            <div className={styles.acModalHeader}>
              <h3>选择人才</h3>
              <button
                className={styles.acModalClose}
                onClick={() => setShowTalentPicker(false)}
                aria-keyshortcuts="Meta+W Control+W"
                title="关闭人才选择（⌘W / Ctrl+W）"
              >
                <X size={16} />
              </button>
            </div>
            <div className={styles.acModalBody}>
              {AVAILABLE_TALENTS.map(talent => (
                <button
                  key={talent.id}
                  className={`${styles.acPickerItem} ${selectedTalents.includes(talent.id) ? styles.acPickerItemSelected : ''}`}
                  onClick={() => toggleTalent(talent.id)}
                >
                  <span className={styles.acPickerCheck}>
                    {selectedTalents.includes(talent.id) && '✓'}
                  </span>
                  <span className={styles.acPickerName}>{talent.name}</span>
                  <span className={styles.acPickerBadge}>{categoryLabel(talent.category)}</span>
                </button>
              ))}
            </div>
            <div className={styles.acModalFooter}>
              <button className={styles.acModalDone} onClick={() => setShowTalentPicker(false)}>
                完成 ({selectedTalents.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 职位描述弹层 */}
      {showDescModal && (
        <div className={styles.acModalOverlay} onClick={() => setShowDescModal(false)}>
          <div className={styles.acDescModal} onClick={e => e.stopPropagation()}>
            <div className={styles.acDescModalHeader}>
              <h3>职位描述</h3>
              <button
                className={styles.acDescModalClose}
                onClick={() => setShowDescModal(false)}
                aria-keyshortcuts="Meta+W Control+W"
                title="关闭职位描述（⌘W / Ctrl+W）"
              >
                <X size={18} />
              </button>
            </div>
            <div className={styles.acDescModalContent}>
              {formData.description}
            </div>
          </div>
        </div>
      )}

      {/* 头像选择弹窗 */}
      {showAvatarPicker && (
        <div className={styles.acModalOverlay} onClick={() => setShowAvatarPicker(false)}>
          <div className={styles.acModal} onClick={e => e.stopPropagation()}>
            <div className={styles.acModalHeader}>
              <h3>选择头像</h3>
              <button
                className={styles.acModalClose}
                onClick={() => setShowAvatarPicker(false)}
                aria-keyshortcuts="Meta+W Control+W"
                title="关闭头像选择（⌘W / Ctrl+W）"
              >
                <X size={16} />
              </button>
            </div>
            <div className={styles.acAvatarGridModal}>
              {AVATARS.map(emoji => (
                <button
                  key={emoji}
                  className={`${styles.acAvatarOpt} ${formData.avatar === emoji ? styles.acAvatarOptSelected : ''}`}
                  onClick={() => { updateField('avatar', emoji); setShowAvatarPicker(false) }}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className={styles.acModalFooter}>
              <button className={styles.acAvatarUploadBtn} onClick={() => fileInputRef.current?.click()}>
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
