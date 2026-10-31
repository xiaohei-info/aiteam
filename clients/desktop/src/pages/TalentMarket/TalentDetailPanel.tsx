import { useEnterpriseWrite } from '../../hooks/useEnterpriseWrite'
import { useEffect, useState } from 'react'
import {
  Ban,
  BookOpen,
  Bot,
  Brain,
  BriefcaseBusiness,
  Cable,
  ChevronLeft,
  ChevronDown,
  CircleCheck,
  Gauge,
  KeyRound,
  Lightbulb,
  MessageCircle,
  Package,
  ShieldCheck,
  Tag,
  UserPlus,
  Zap,
} from 'lucide-react'
import styles from './TalentDetailPanel.module.css'
import TalentEmployeeWorkspace from './TalentEmployeeWorkspace'
import OutputTypeIcon from './OutputTypeIcon'
import { RECRUITMENT_AVAILABLE } from './api'
import {
  OUTPUT_TYPE_LABELS,
  PRICING_MODE_LABELS,
  connectorStatuses,
  formatTemplatePricing,
  hasTalentRequirements,
  requiredPermissionLabels,
  solveRateSummary,
  solveRateTone,
  talentReleaseLabel,
  type TalentConnectorStatus,
} from './talentProfile'
import type { MarketTemplate, MarketTemplateDetail } from './types'
import { agentApi, type Connector } from '../../api/agent'
import GoldenDotsLoading from '../../components/Loading/GoldenDotsLoading'
import RequestErrorState from '../../components/RequestState/RequestErrorState'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import type { RequestErrorInfo } from '../../lib/requestError'

// 议题 7：概览 / 能力 / 接入要求 / 数据与成本；没有内容的标签页整页隐藏，「接入要求」始终保留。
type DetailTab = 'overview' | 'capabilities' | 'requirements' | 'data'

interface DetailTabItem {
  key: DetailTab
  label: string
}

interface TalentDetailPanelProps {
  agent: MarketTemplate | null
  detail: MarketTemplateDetail | null
  loading: boolean
  error: RequestErrorInfo | null
  recruiting: boolean
  recruited: boolean
  onRecruit?: () => void
  onStartChat?: () => void
  // 已招募时点击示例问题：打开对话并把问题填入输入框（不自动发送）。
  onUsePrompt?: (prompt: string) => void
  // 「开始对话」进行中 / 失败原因（如本机还没有该员工的授权），显示在详情底部。
  startingChat?: boolean
  chatError?: string
  // 已招募但当前不能对话的原因（缺授权、暂停、下架等）；有值时禁用「开始对话」。
  chatBlockedReason?: string
  onRetry?: () => void
  onClose: () => void
}

interface TextItem {
  title: string
  meta: string
}

const DETAIL_TABS: DetailTabItem[] = [
  { key: 'overview', label: '概览' },
  { key: 'capabilities', label: '能力' },
  { key: 'requirements', label: '接入要求' },
  { key: 'data', label: '数据与成本' },
]

const CATEGORY_LABELS: Record<string, string> = {
  business: '业务运营',
  software: '软件开发',
  data: '数据分析',
  content: '内容创作',
  design: '设计创意',
  research: '研究助理',
  ecommerce: '跨境电商',
}

const MEMORY_LABELS: Record<string, string> = {
  mode: '记忆模式',
  provider_code: '记忆提供方',
  retention_days: '保留天数',
  writeback_enabled: '回写开关',
}

const MEMORY_VALUE_LABELS: Record<string, string> = {
  builtin: '内置策略',
  standard: '标准策略',
  true: '已开启',
  false: '已关闭',
}

const RATE_TONE_CLASS = {
  success: styles.rateSuccess,
  primary: styles.ratePrimary,
  warning: styles.rateWarning,
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function formatCategory(category: string): string {
  return CATEGORY_LABELS[category] ?? (category || '未分类')
}

function formatMemoryValue(value: unknown): string {
  if (typeof value === 'string') return MEMORY_VALUE_LABELS[value] ?? value
  if (typeof value === 'boolean') return value ? MEMORY_VALUE_LABELS.true : MEMORY_VALUE_LABELS.false
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}`
  return '已配置'
}

function describeMemoryConfig(config: unknown): TextItem[] {
  const entries = Object.entries(asRecord(config))

  if (!entries.length) {
    return []
  }

  return entries.slice(0, 6).map(([key, value]) => ({
    title: MEMORY_LABELS[key] ?? key,
    meta: formatMemoryValue(value),
  }))
}

export default function TalentDetailPanel({
  agent,
  detail,
  loading,
  error,
  recruiting,
  recruited,
  onRecruit,
  onStartChat,
  onUsePrompt,
  startingChat,
  chatError,
  chatBlockedReason,
  onRetry,
  onClose,
}: TalentDetailPanelProps) {
  const permission = useEnterpriseWrite()
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')
  const panelRef = useDialogFocus<HTMLElement>({ active: agent !== null })
  const profile = detail?.profile ?? agent?.profile
  const hasConnectors = Boolean(profile && (profile.required_connectors.length || profile.optional_connectors.length))
  // 本机已启用的连接器，用来标注模板要求的外部系统是否已开通；读取失败时为 null，不标注。
  const [enabledConnectors, setEnabledConnectors] = useState<Connector[] | null>(null)

  useGlobalShortcutClose({ active: agent !== null, layer: 'panel', onClose })

  useEffect(() => {
    if (!hasConnectors) return
    let active = true
    agentApi.listConnectors()
      .then(result => { if (active) setEnabledConnectors(result.data) })
      .catch(err => {
        console.warn('[TalentDetail] connector status unavailable:', err)
        if (active) setEnabledConnectors(null)
      })
    return () => { active = false }
  }, [hasConnectors])

  if (!agent || !profile) return null

  const name = detail?.name ?? agent.name
  const description = detail?.description || agent.description
  const skills = detail?.default_skills?.length ? detail.default_skills : agent.skills
  const skillsCount = detail?.skills_count ?? agent.skills_count ?? skills.length
  const tags = detail?.tags?.length ? detail.tags : agent.tags
  const category = detail?.category ?? agent.category
  const categoryLabel = formatCategory(category)
  // recruit_count 仅表示模板被企业招募的次数，不能当成员工调用次数。
  const recruitCount = detail?.recruit_count ?? agent.recruit_count
  const modelName = detail?.default_model_ref?.model ?? agent.default_model_ref?.model
  const modelProvider = detail?.default_model_ref?.provider ?? agent.default_model_ref?.provider
  const memoryItems = describeMemoryConfig(detail?.default_memory_config)
  const releaseLabel = talentReleaseLabel(profile)
  const promptsClickable = Boolean(onUsePrompt) && !chatBlockedReason && !startingChat
  const requiredConnectors = connectorStatuses(profile.required_connectors, enabledConnectors)
  const optionalConnectors = connectorStatuses(profile.optional_connectors, enabledConnectors)
  const permissionLabels = requiredPermissionLabels(profile.required_permissions)

  const hasOverview = Boolean(profile.tagline || description || profile.use_cases.length || profile.limitations.length
    || profile.example_prompts.length || profile.sample_outputs.length)
  const hasCapabilities = skillsCount > 0 || skills.length > 0 || profile.output_types.length > 0 || tags.length > 0
  const hasData = Boolean(profile.stats || typeof recruitCount === 'number' || profile.pricing || modelName || profile.memory_policy_summary)
  const tabContent: Record<DetailTab, boolean> = { overview: hasOverview, capabilities: hasCapabilities, requirements: true, data: hasData }
  const visibleTabs = DETAIL_TABS.filter(tab => tabContent[tab.key])
  const currentTab = tabContent[activeTab] ? activeTab : visibleTabs[0].key

  const handleTab = (tab: DetailTab) => {
    if (!tabContent[tab]) return
    setActiveTab(tab)
  }

  const handleTabsKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'))
    if (tabs.length === 0) return
    event.preventDefault()
    const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : event.key === 'ArrowRight'
          ? (currentIndex + 1 + tabs.length) % tabs.length
          : (currentIndex - 1 + tabs.length) % tabs.length
    const nextTab = tabs[nextIndex]
    handleTab(nextTab.dataset.tabKey as DetailTab)
    nextTab.focus()
  }

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  const renderSectionHeader = (eyebrow: string, title: string, icon: React.ReactNode, titleId?: string) => (
    <div className={styles.sectionHeader}>
      <div>
        <span>{eyebrow}</span>
        <h3 id={titleId}>{title}</h3>
      </div>
      {icon}
    </div>
  )

  const renderConnectorRows = (items: TalentConnectorStatus[], required: boolean) => items.map(item => (
    <div key={`${required ? 'required' : 'optional'}-${item.key}`} className={styles.itemRow}>
      <span className={styles.itemIcon}><Cable size={14} strokeWidth={1.8} /></span>
      <div>
        <strong>{item.name}</strong>
        <span>{required ? '必需' : '可选'}</span>
      </div>
      {item.enabled !== null && (
        <em className={`${styles.statusBadge} ${item.enabled ? styles.statusEnabled : styles.statusMissing}`}>
          {item.enabled ? '已开通' : '未开通'}
        </em>
      )}
    </div>
  ))

  const renderOverviewTab = () => (
    <div className={styles.detailStack}>
      {(profile.tagline || description) && (
        <section className={styles.infoCard}>
          {renderSectionHeader('定位', categoryLabel, <BriefcaseBusiness size={17} strokeWidth={1.8} />)}
          {profile.tagline && <p className={styles.tagline}>{profile.tagline}</p>}
          {description && <p>{description}</p>}
        </section>
      )}

      {(profile.use_cases.length > 0 || profile.limitations.length > 0) && (
        <section className={styles.infoCard}>
          {renderSectionHeader('适用场景', '它适合做什么', <Lightbulb size={17} strokeWidth={1.8} />)}
          {profile.use_cases.length > 0 && (
            <div className={styles.fitGroup}>
              <strong>适合</strong>
              <ul>{profile.use_cases.map(item => <li key={item}>{item}</li>)}</ul>
            </div>
          )}
          {profile.limitations.length > 0 && (
            <div className={styles.fitGroup}>
              <strong>不适合</strong>
              <ul>{profile.limitations.map(item => <li key={item}>{item}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      {profile.example_prompts.length > 0 && (
        <section className={styles.infoCard}>
          {renderSectionHeader('示例问题', promptsClickable ? '点击直接带入对话' : '可以这样问它', <MessageCircle size={17} strokeWidth={1.8} />)}
          <div className={styles.promptList}>
            {profile.example_prompts.map(prompt => promptsClickable ? (
              <button
                key={prompt}
                type="button"
                className={`${styles.promptPill} ${styles.promptPillAction}`}
                onClick={() => onUsePrompt?.(prompt)}
                title="打开对话并填入输入框"
              >
                {prompt}
              </button>
            ) : (
              <span key={prompt} className={styles.promptPill}>{prompt}</span>
            ))}
          </div>
        </section>
      )}

      {profile.sample_outputs.length > 0 && (
        <section className={styles.infoCard}>
          {renderSectionHeader('示例产出', '它能交付什么', <Package size={17} strokeWidth={1.8} />)}
          <div className={styles.itemList}>
            {profile.sample_outputs.map(output => (
              <div key={`${output.title}-${output.output_type}`} className={styles.itemRow}>
                <span className={styles.itemIcon}><OutputTypeIcon type={output.output_type} /></span>
                <div>
                  <strong>{output.title}</strong>
                  <span>{OUTPUT_TYPE_LABELS[output.output_type]}</span>
                </div>
                {output.preview_url && (
                  <a className={styles.previewLink} href={output.preview_url} target="_blank" rel="noopener noreferrer">预览</a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )

  const renderCapabilitiesTab = () => (
    <div className={styles.detailStack}>
      {(skillsCount > 0 || skills.length > 0) && (
        <section className={styles.infoCard}>
          {renderSectionHeader('技能清单', `模板提供的 ${skillsCount} 项固定技能`, <Zap size={17} strokeWidth={1.8} />)}
          {profile.skill_details.length || skills.length ? (
            <div className={styles.itemList}>
              {(profile.skill_details.length ? profile.skill_details : skills.map(skill => ({ name: skill, summary: null, version: '' }))).map(skill => (
                <div key={skill.name} className={styles.itemRow}>
                  <span className={styles.itemIcon}><Zap size={14} strokeWidth={1.8} /></span>
                  <div>
                    <strong>{skill.name}</strong>
                    {(skill.summary || skill.version) && (
                      <span>{[skill.summary, skill.version ? `v${skill.version}` : ''].filter(Boolean).join(' · ')}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.mutedText}>技能名称会在企业技能市场发布后显示。</p>
          )}
        </section>
      )}

      {profile.output_types.length > 0 && (
        <section className={styles.infoCard}>
          {renderSectionHeader('产出类型', '交付物形式', <Package size={17} strokeWidth={1.8} />)}
          <div className={styles.chips}>
            {profile.output_types.map(type => (
              <span key={type} className={styles.iconChip}><OutputTypeIcon type={type} />{OUTPUT_TYPE_LABELS[type]}</span>
            ))}
          </div>
        </section>
      )}

      {tags.length > 0 && (
        <section className={styles.infoCard}>
          {renderSectionHeader('能力标签', '该专家擅长的领域与技能', <Tag size={17} strokeWidth={1.8} />)}
          <div className={styles.chips}>
            {tags.map(tag => <span key={tag}>{tag}</span>)}
          </div>
        </section>
      )}
    </div>
  )

  const renderRequirementsTab = () => {
    if (!hasTalentRequirements(profile) && !profile.required_permissions && !memoryItems.length) {
      return (
        <section className={styles.infoCard}>
          <p className={styles.readyNote}><CircleCheck size={15} strokeWidth={1.9} />无需额外配置</p>
        </section>
      )
    }
    return (
      <div className={styles.detailStack}>
        <section className={styles.infoCard}>
          {renderSectionHeader('外部系统', '需要接入的连接器', <Cable size={17} strokeWidth={1.8} />)}
          {requiredConnectors.length || optionalConnectors.length ? (
            <div className={styles.itemList}>
              {renderConnectorRows(requiredConnectors, true)}
              {renderConnectorRows(optionalConnectors, false)}
            </div>
          ) : (
            <p className={styles.readyNote}><CircleCheck size={15} strokeWidth={1.9} />无需额外外部系统</p>
          )}
        </section>

        {profile.recommended_knowledge.length > 0 && (
          <section className={styles.infoCard}>
            {renderSectionHeader('推荐知识', '建议提供的资料', <BookOpen size={17} strokeWidth={1.8} />)}
            <div className={styles.chips}>
              {profile.recommended_knowledge.map(item => <span key={item}>{item}</span>)}
            </div>
          </section>
        )}

        {profile.required_permissions && (
          <section className={styles.infoCard}>
            {renderSectionHeader('需要的权限', '对话中的本机权限', <KeyRound size={17} strokeWidth={1.8} />)}
            {permissionLabels.length ? (
              <div className={styles.chips}>
                {permissionLabels.map(item => <span key={item}>{item}</span>)}
              </div>
            ) : (
              <p className={styles.readyNote}><CircleCheck size={15} strokeWidth={1.9} />不需要完全访问或本机目录</p>
            )}
          </section>
        )}

        {memoryItems.length > 0 && (
          <section className={styles.infoCard}>
            {renderSectionHeader('入职上下文', '新员工入职时带入的上下文', <Brain size={17} strokeWidth={1.8} />)}
            <div className={styles.itemList}>
              {memoryItems.map(item => (
                <div key={`${item.title}-${item.meta}`} className={styles.itemRow}>
                  <span className={styles.itemIcon}><Brain size={14} strokeWidth={1.8} /></span>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.meta}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    )
  }

  const renderDataTab = () => {
    const stats = profile.stats
    return (
      <div className={styles.detailStack}>
        {(stats || typeof recruitCount === 'number') && (
          <section className={styles.infoCard}>
            {renderSectionHeader('质量与规模', '本企业的使用效果', <Gauge size={17} strokeWidth={1.8} />)}
            <div className={styles.specList}>
              {stats && (
                <div>
                  <span>解决率</span>
                  <strong className={stats.resolution_rate === null ? styles.rateMuted : RATE_TONE_CLASS[solveRateTone(stats.resolution_rate)]}>
                    {solveRateSummary(stats)}
                  </strong>
                </div>
              )}
              {typeof recruitCount === 'number' && (
                <div>
                  <span>企业已招募</span>
                  <strong>{recruitCount.toLocaleString('zh-CN')}</strong>
                </div>
              )}
            </div>
          </section>
        )}

        {profile.pricing && (
          <section className={styles.infoCard}>
            {renderSectionHeader('成本', '参考价，以企业账单为准', <Tag size={17} strokeWidth={1.8} />)}
            <div className={styles.specList}>
              <div>
                <span>计价方式</span>
                <strong>{PRICING_MODE_LABELS[profile.pricing.mode]}</strong>
              </div>
              <div>
                <span>参考单价</span>
                <strong>{formatTemplatePricing(profile.pricing)}</strong>
              </div>
            </div>
          </section>
        )}

        {(modelName || profile.memory_policy_summary) && (
          <section className={styles.infoCard}>
            {renderSectionHeader('数据与隐私', '模型与记忆', <ShieldCheck size={17} strokeWidth={1.8} />)}
            <div className={styles.specList}>
              {modelName && (
                <div>
                  <span>模型和服务商</span>
                  <strong>{modelProvider ? `${modelProvider} · ${modelName}` : modelName}</strong>
                </div>
              )}
              {profile.memory_policy_summary && (
                <div>
                  <span>记忆策略</span>
                  <strong title={profile.memory_policy_summary}>{profile.memory_policy_summary}</strong>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    )
  }

  const renderActiveTab = () => {
    if (currentTab === 'capabilities') return renderCapabilitiesTab()
    if (currentTab === 'requirements') return renderRequirementsTab()
    if (currentTab === 'data') return renderDataTab()
    return renderOverviewTab()
  }

  const renderPublishInfo = () => {
    if (!profile.publisher && !releaseLabel && !profile.changelog_url) return null
    return (
      <footer className={styles.publishInfo}>
        {profile.publisher && <span>发布者：{profile.publisher}</span>}
        {releaseLabel && <span>{releaseLabel}</span>}
        {profile.changelog_url && <a href={profile.changelog_url} target="_blank" rel="noopener noreferrer">更新说明</a>}
      </footer>
    )
  }

  const renderActions = () => (
    <div className={styles.actionBar}>
      {chatError
        ? <p role="alert" className={styles.actionError}>{chatError}</p>
        : onStartChat && chatBlockedReason && <p role="status" className={`${styles.actionError} ${styles.actionNotice}`}>{chatBlockedReason}</p>}
      {onStartChat ? (
        <button
          className={styles.primaryBtn}
          disabled={startingChat || Boolean(chatBlockedReason)}
          onClick={onStartChat}
          type="button"
        >
          {chatBlockedReason ? <Ban size={16} strokeWidth={1.8} /> : <MessageCircle size={16} strokeWidth={1.8} />}
          {startingChat ? '正在进入对话…' : chatBlockedReason ? '暂不可对话' : '开始对话'}
        </button>
      ) : (
        <>
          <button
            className={styles.secondaryBtn}
            onClick={onClose}
            type="button"
          >
            稍后再说
          </button>
          <button
            className={styles.primaryBtn}
            disabled={!RECRUITMENT_AVAILABLE || recruiting || recruited || !permission.enabled}
            onClick={onRecruit}
            type="button"
            title={RECRUITMENT_AVAILABLE ? permission.reason : '桌面端暂不支持招募，请在企业后台招募后再来对话'}
          >
            <UserPlus size={16} strokeWidth={1.9} />
            {!RECRUITMENT_AVAILABLE ? '请在企业后台招募' : recruiting ? '招募中…' : '招募'}
          </button>
        </>
      )}
    </div>
  )

  return (
    <div className={styles.backdrop}>
      <section
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="talent-detail-title"
        tabIndex={-1}
        onKeyDown={handlePanelKeyDown}
      >
        <header className={styles.topBar}>
          <button
            className={styles.backBtn}
            onClick={onClose}
            type="button"
            aria-keyshortcuts="Meta+W Control+W"
            title="返回人才市场（⌘W / Ctrl+W）"
          >
            <ChevronLeft size={16} strokeWidth={1.9} />
            <span>返回</span>
          </button>
          <div className={styles.topTitle}>
            <Bot size={15} strokeWidth={1.8} />
            <span>专家详情</span>
          </div>
        </header>

        <div className={styles.hero}>
          <div className={styles.avatar} aria-hidden="true">{name.slice(0, 1)}</div>
          <div className={styles.titleBlock}>
            <h2 id="talent-detail-title">{name}</h2>
            <p>{releaseLabel ? `${categoryLabel} · ${releaseLabel}` : categoryLabel}</p>
          </div>
        </div>

        <nav className={styles.tabs} aria-label="详情分区" role="tablist" onKeyDown={handleTabsKeyDown}>
          {visibleTabs.map(tab => (
            <button
              key={tab.key}
              className={currentTab === tab.key ? styles.active : ''}
              onClick={() => handleTab(tab.key)}
              type="button"
              id={`talent-detail-tab-${tab.key}`}
              data-tab-key={tab.key}
              role="tab"
              aria-selected={currentTab === tab.key}
              aria-controls="talent-detail-tabpanel"
              tabIndex={currentTab === tab.key ? 0 : -1}
            >
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        <div className={styles.contentGrid}>
          <div
            className={styles.mainColumn}
            id="talent-detail-tabpanel"
            role="tabpanel"
            aria-labelledby={`talent-detail-tab-${currentTab}`}
          >
            {loading ? (
              <div className={styles.detailLoading}>
                <GoldenDotsLoading label="详情加载中" />
              </div>
            ) : error ? (
              <RequestErrorState
                compact
                error={error}
                onRetry={() => onRetry?.()}
              />
            ) : (
              <>
                <TalentEmployeeWorkspace key={agent.template_id} templateId={agent.template_id} showKnowledge={currentTab === 'requirements'} />
                {renderActiveTab()}

                {!recruited && (
                  <section className={styles.confirmCard}>
                    <div className={styles.confirmCopy}>
                      <h3>模板配置预览</h3>
                      <p>招募后需在企业管理端完成实例配置、生命周期和成员授权，再同步本机授权。</p>
                    </div>
                    {modelName && (
                      <label className={styles.modelField}>
                        <span>模板模型</span>
                        <div className={styles.selectWrap}>
                          <select value="default" disabled aria-label="模板模型">
                            <option value="default">{modelName}</option>
                          </select>
                          <ChevronDown size={15} strokeWidth={1.8} />
                        </div>
                      </label>
                    )}
                  </section>
                )}

                {renderPublishInfo()}
              </>
            )}
          </div>
        </div>

        {renderActions()}
      </section>
    </div>
  )
}
