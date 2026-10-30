import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Check,
  RefreshCw,
  Search,
} from 'lucide-react'
import './TalentMarket.css'
import {
  deriveMarketCategories,
  fetchMarketAgents,
  fetchMarketTemplateDetail,
  recruitMarketAgent,
} from './api'
import type { MarketTemplate, MarketCategory, MarketTemplateDetail, RecruitResponse } from './types'
import GoldenDotsLoading from '../../components/Loading/GoldenDotsLoading'
import AgentCard from './AgentCard'
import RecruitAliasDialog from './RecruitAliasDialog'
import TalentDetailPanel from './TalentDetailPanel'
import type { TalentFilters } from './TalentFilterSidebar'
import TalentSortSelect, { type TalentSortKey } from './TalentSortSelect'
import type { MarketplaceOutputType, MarketplacePricingMode } from '../../api/agent/types'
import { OUTPUT_TYPE_LABELS, PRICING_MODE_LABELS } from './talentProfile'
import RequestErrorState from '../../components/RequestState/RequestErrorState'
import { classifyRequestError, type RequestErrorInfo } from '../../lib/requestError'
import {
  MARKET_PRICE_MAX,
  MARKET_PRICE_MIN,
  filterMarketAgents,
  sortMarketAgents,
} from './marketFilters'
import { loadTalentChatBlockedReasons, loadTalentEmployees, startTalentEmployeeChat } from './talentEmployeeChat'
import { pickTalentChatTarget, TALENT_GRANT_MISSING_MESSAGE } from './talentEmployees'
import { useAgentAuthStore } from '../../stores/agentAuth'

interface TalentSection {
  key: string
  title: string
  agents: MarketTemplate[]
}

interface TalentSectionProps {
  section: TalentSection
  recruitingId: string | null
  recruitmentsByTemplate: Record<string, RecruitResponse>
  chatBlockedByTemplate: Record<string, string>
  onOpenDetail: (agent: MarketTemplate) => void
  onRecruit: (agent: MarketTemplate) => void
  onStartChat: (agent: MarketTemplate) => void
}

function buildSections(
  agents: MarketTemplate[],
  categories: MarketCategory[],
  query: string,
  activeCategory: string,
  sort: TalentSortKey,
  profileFiltered: boolean,
): TalentSection[] {
  if (!agents.length) return []

  const categoryLabel = new Map(categories.map(category => [category.id, category.label]))

  if (query.trim()) {
    return [{ key: 'search', title: '搜索结果', agents: sortMarketAgents(agents, sort) }]
  }

  // 选了非默认排序或产出/计价/外部系统筛选时，按排序平铺，不再分精选和分类。
  if (sort !== 'composite' || profileFiltered) {
    const title = activeCategory !== 'all' ? categoryLabel.get(activeCategory) ?? '筛选结果' : '筛选结果'
    return [{ key: 'filtered', title, agents: sortMarketAgents(agents, sort) }]
  }

  if (activeCategory !== 'all') {
    return [{ key: activeCategory, title: categoryLabel.get(activeCategory) ?? '分类结果', agents }]
  }

  const sorted = sortMarketAgents(agents, 'recruits')
  const featured = sorted.slice(0, Math.min(4, sorted.length))
  const featuredIds = new Set(featured.map(agent => agent.template_id))
  const remaining = agents.filter(agent => !featuredIds.has(agent.template_id))
  const sections: TalentSection[] = [{ key: 'featured', title: '精选', agents: featured }]

  for (const category of categories) {
    if (category.id === 'all') continue
    const group = remaining.filter(agent => agent.category === category.id)
    if (group.length) {
      sections.push({ key: category.id, title: category.label, agents: group })
    }
  }

  const uncategorized = remaining.filter(agent => !categoryLabel.has(agent.category))
  if (uncategorized.length) {
    sections.push({ key: 'other', title: '更多人才', agents: uncategorized })
  }

  return sections.filter(section => section.agents.length)
}

function markAgentRecruited(agent: MarketTemplate): MarketTemplate {
  return {
    ...agent,
    is_recruited: true,
  }
}

function TalentSectionList({
  section,
  recruitingId,
  recruitmentsByTemplate,
  chatBlockedByTemplate,
  onOpenDetail,
  onRecruit,
  onStartChat,
}: TalentSectionProps) {
  return (
    <section className="tm-section">
      <div className="tm-section-header">
        <h2>{section.title}</h2>
      </div>
      <div className="tm-agent-grid">
        {section.agents.map((agent, index) => (
          <AgentCard
            key={agent.template_id}
            agent={agent}
            index={index}
            recruiting={recruitingId === agent.template_id}
            recruited={agent.is_recruited}
            canStartChat={agent.is_recruited || Boolean(recruitmentsByTemplate[agent.template_id])}
            chatBlockedReason={chatBlockedByTemplate[agent.template_id]}
            onClick={() => onOpenDetail(agent)}
            onRecruit={() => onRecruit(agent)}
            onStartChat={() => onStartChat(agent)}
          />
        ))}
      </div>
    </section>
  )
}

// 分类以外的筛选维度保持默认，复用现有搜索逻辑。
const INITIAL_FILTERS: TalentFilters = {
  categories: [],
  skills: [],
  levels: [],
  tags: [],
  priceMin: MARKET_PRICE_MIN,
  priceMax: MARKET_PRICE_MAX,
  outputTypes: [],
  pricingModes: [],
  noExternalSystems: false,
}

type ProfileFilters = Pick<TalentFilters, 'outputTypes' | 'pricingModes' | 'noExternalSystems'>

const INITIAL_PROFILE_FILTERS: ProfileFilters = { outputTypes: [], pricingModes: [], noExternalSystems: false }

function toggleItem<T>(items: T[], value: T): T[] {
  return items.includes(value) ? items.filter(item => item !== value) : [...items, value]
}

export default function TalentMarket() {
  const [categories, setCategories] = useState<MarketCategory[]>(() => deriveMarketCategories([]))
  const [agents, setAgents] = useState<MarketTemplate[]>([])
  const [recruitmentsByTemplate, setRecruitmentsByTemplate] = useState<Record<string, RecruitResponse>>({})
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [loading, setLoading] = useState(true)
  // 刷新时保留当前列表，只让刷新按钮转圈；loading 只用于首次加载。
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const [refreshNotice, setRefreshNotice] = useState('')
  // 已招募人才不能发起对话的原因（缺授权、暂停、下架等），按模板 ID 索引。
  const [chatBlockedByTemplate, setChatBlockedByTemplate] = useState<Record<string, string>>({})
  const availabilityRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const [loadError, setLoadError] = useState<RequestErrorInfo | null>(null)
  const [actionError, setActionError] = useState('')
  const [selectedAgent, setSelectedAgent] = useState<MarketTemplate | null>(null)
  const [detail, setDetail] = useState<MarketTemplateDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const detailRequestRef = useRef(0)
  const [detailError, setDetailError] = useState<RequestErrorInfo | null>(null)
  const [recruitingId, setRecruitingId] = useState<string | null>(null)
  const [pendingRecruitAgent, setPendingRecruitAgent] = useState<MarketTemplate | null>(null)
  // 招募成功 Toast:名字仅用于文案渲染,timer 用于 2 秒后自动清空。
  const [recruitToastName, setRecruitToastName] = useState<string | null>(null)
  const recruitToastTimerRef = useRef<number | null>(null)
  const [activeCategory, setActiveCategory] = useState('all')
  const [profileFilters, setProfileFilters] = useState<ProfileFilters>(INITIAL_PROFILE_FILTERS)
  const [sort, setSort] = useState<TalentSortKey>('composite')

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 260)
    return () => window.clearTimeout(timer)
  }, [search])

  const applyMarketAgents = useCallback((items: MarketTemplate[]) => {
    const nextCategories = deriveMarketCategories(items)

    setAgents(items)
    setCategories(nextCategories)
    setActiveCategory(prev => nextCategories.some(category => category.id === prev) ? prev : 'all')
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      availabilityRequestRef.current += 1
    }
  }, [])

  const loadChatAvailability = useCallback(async (items: MarketTemplate[]) => {
    const request = ++availabilityRequestRef.current
    try {
      const blocked = await loadTalentChatBlockedReasons(items.filter(item => item.is_recruited).map(item => item.template_id))
      if (request === availabilityRequestRef.current) setChatBlockedByTemplate(blocked)
    } catch (err) {
      // 状态读取失败不拦截对话；点击「开始对话」时仍会按 readiness 校验。
      console.error(err)
      if (request === availabilityRequestRef.current) setChatBlockedByTemplate({})
    }
  }, [])

  const loadMarketData = useCallback(async (
    force = false,
    isAlive: () => boolean = () => true,
    background = false,
  ) => {
    if (!background) setLoading(true)
    setLoadError(null)
    try {
      const response = await fetchMarketAgents({}, { force })

      if (!isAlive()) return
      applyMarketAgents(response.items)
      void loadChatAvailability(response.items)
    } catch (err) {
      if (!isAlive()) return
      console.error(err)
      setLoadError(classifyRequestError(err, '人才市场数据加载失败，请稍后重试。'))
    } finally {
      if (isAlive() && !background) setLoading(false)
    }
  }, [applyMarketAgents, loadChatAvailability])

  useEffect(() => {
    let alive = true

    loadMarketData(false, () => alive)

    return () => {
      alive = false
    }
  }, [loadMarketData])

  // 先从 Manager 同步最新授权（暂停、恢复等只有同步后本机才知道），再重读模板和员工状态。
  const handleRefreshList = useCallback(async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    setRefreshNotice('')
    try {
      try {
        await useAgentAuthStore.getState().retryGrantsSync()
      } catch (err) {
        console.error(err)
        if (mountedRef.current) setRefreshNotice('员工授权同步失败，员工状态可能不是最新，请稍后再刷新。')
      }
      if (!mountedRef.current) return
      await loadMarketData(true, () => mountedRef.current, true)
    } finally {
      refreshingRef.current = false
      if (mountedRef.current) setRefreshing(false)
    }
  }, [loadMarketData])

  const filteredAgents = useMemo(
    () => filterMarketAgents(agents, {
      ...INITIAL_FILTERS,
      ...profileFilters,
      categories: activeCategory === 'all' ? [] : [activeCategory],
    }, debouncedSearch),
    [activeCategory, agents, debouncedSearch, profileFilters],
  )

  const profileFiltered = profileFilters.outputTypes.length > 0 || profileFilters.pricingModes.length > 0 || profileFilters.noExternalSystems

  const sections = useMemo(
    () => buildSections(filteredAgents, categories, debouncedSearch, activeCategory, sort, profileFiltered),
    [activeCategory, categories, debouncedSearch, filteredAgents, profileFiltered, sort],
  )

  // 筛选项只列出目录里真实出现的值；没有数据的维度整组隐藏（议题 7）。
  const profileFacets = useMemo(() => {
    const outputTypes = new Set<MarketplaceOutputType>()
    const pricingModes = new Set<MarketplacePricingMode>()
    let needsConnectors = false
    for (const agent of agents) {
      agent.profile.output_types.forEach(type => outputTypes.add(type))
      if (agent.profile.pricing) pricingModes.add(agent.profile.pricing.mode)
      if (agent.profile.required_connectors.length) needsConnectors = true
    }
    return {
      outputTypes: (Object.keys(OUTPUT_TYPE_LABELS) as MarketplaceOutputType[]).filter(type => outputTypes.has(type)),
      pricingModes: (Object.keys(PRICING_MODE_LABELS) as MarketplacePricingMode[]).filter(mode => pricingModes.has(mode)),
      needsConnectors,
    }
  }, [agents])
  const hasProfileFacets = profileFacets.outputTypes.length > 0 || profileFacets.pricingModes.length > 0 || profileFacets.needsConnectors

  const handleOpenDetail = useCallback(async (agent: MarketTemplate) => {
    const request = ++detailRequestRef.current
    setSelectedAgent(agent)
    setDetail(null)
    setDetailError(null)
    setActionError('')
    setDetailLoading(true)
    try {
      const data = await fetchMarketTemplateDetail(agent.template_id)
      if (request !== detailRequestRef.current) return
      setDetail(data)
    } catch (err) {
      if (request === detailRequestRef.current) setDetailError(classifyRequestError(err, '人才详情加载失败，请稍后重试。'))
    } finally {
      if (request === detailRequestRef.current) setDetailLoading(false)
    }
  }, [])

  const handleCloseDetail = useCallback(() => {
    detailRequestRef.current += 1
    setSelectedAgent(null)
    setDetail(null)
    setDetailError(null)
    setActionError('')
    setDetailLoading(false)
  }, [])

  const selectedRecruitment = selectedAgent ? recruitmentsByTemplate[selectedAgent.template_id] : undefined
  const selectedRecruited = Boolean(selectedAgent?.is_recruited || selectedRecruitment)

  // 招募记录 ∩ 本机授权解析出该人才的员工后直接进对话；没有可用员工时提示去企业后台完成授权。
  const navigate = useNavigate()
  const [startingChatId, setStartingChatId] = useState<string | null>(null)
  const startChatRequestRef = useRef(0)
  useEffect(() => () => { startChatRequestRef.current += 1 }, [])

  // draftMessage：从详情的示例问题带入，只填入输入框，不自动发送。
  const handleStartChat = useCallback(async (agent: MarketTemplate, draftMessage?: string) => {
    if (startingChatId) return
    const request = ++startChatRequestRef.current
    const isCurrent = () => request === startChatRequestRef.current
    setStartingChatId(agent.template_id)
    setActionError('')
    try {
      const target = pickTalentChatTarget(await loadTalentEmployees(agent.template_id))
      if (!isCurrent()) return
      if (target.kind === 'none') throw new Error(TALENT_GRANT_MISSING_MESSAGE)
      await startTalentEmployeeChat(target.employee, navigate, isCurrent, draftMessage)
    } catch (err) {
      console.error(err)
      if (isCurrent()) setActionError(err instanceof Error ? err.message : '发起对话失败，请稍后重试')
    } finally {
      if (isCurrent()) setStartingChatId(null)
    }
  }, [navigate, startingChatId])

  const handleOpenRecruitDialog = useCallback((agent: MarketTemplate) => {
    if (recruitmentsByTemplate[agent.template_id] || recruitingId) return
    setPendingRecruitAgent(agent)
  }, [recruitingId, recruitmentsByTemplate])

  const handleCloseRecruitDialog = useCallback(() => {
    if (recruitingId) return
    setPendingRecruitAgent(null)
  }, [recruitingId])

  const recruitmentKeyRef = useRef(new Map<string, string>())

  const handleRecruit = useCallback(async (alias: string) => {
    const agent = pendingRecruitAgent
    if (!agent || recruitmentsByTemplate[agent.template_id] || recruitingId) return
    setRecruitingId(agent.template_id)
    setActionError('')
    try {
      const operation = `${agent.template_id}:${alias}`
      const key = recruitmentKeyRef.current.get(operation) ?? crypto.randomUUID()
      recruitmentKeyRef.current.set(operation, key)
      const response = await recruitMarketAgent(agent.template_id, alias, key)
      if (!response.employee_id || response.status === 'failed') {
        throw new Error('企业员工实例未创建成功')
      }
      const recruitedAgent = markAgentRecruited(agent)
      setRecruitmentsByTemplate(prev => ({
        ...prev,
        [agent.template_id]: response,
      }))
      setAgents(prev => prev.map(item => (
        item.template_id === agent.template_id
          ? markAgentRecruited(item)
          : item
      )))
      setSelectedAgent(prev => prev?.template_id === agent.template_id ? recruitedAgent : prev)
      setPendingRecruitAgent(null)
      // 招募成功 Toast:显示别名(用户自己填的名字),2 秒后自动隐藏。
      // 用 alias 而非模板 name,是因为员工在企业里的最终身份是别名。
      const displayName = alias.trim() || agent.name
      setRecruitToastName(displayName)
      if (recruitToastTimerRef.current !== null) window.clearTimeout(recruitToastTimerRef.current)
      recruitToastTimerRef.current = window.setTimeout(() => setRecruitToastName(null), 2000)
    } catch (err) {
      console.error(err)
      setActionError('招募失败，请稍后重试')
    } finally {
      setRecruitingId(null)
    }
  }, [pendingRecruitAgent, recruitingId, recruitmentsByTemplate])

  useEffect(() => () => {
    if (recruitToastTimerRef.current !== null) window.clearTimeout(recruitToastTimerRef.current)
  }, [])

  return (
    <div className="tm-page">
      <main className="tm-main">
        <section className="tm-toolbar" aria-label="人才市场页面操作">
          <p>像招聘高端团队成员一样挑选 AI 员工，并立即加入组织协作。</p>

          <div className="tm-header-actions">
            <label className="tm-search-box">
              <Search size={16} strokeWidth={1.8} />
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="搜索人才、技能或场景"
              />
            </label>
          </div>
        </section>

        {actionError && (
          <div className="tm-error">
            <span>{actionError}</span>
          </div>
        )}

        {refreshNotice && (
          <div className="tm-error" role="status">
            <span>{refreshNotice}</span>
          </div>
        )}

        {loadError ? (
          <RequestErrorState
            error={loadError}
            onRetry={() => void handleRefreshList()}
            retrying={loading || refreshing}
          />
        ) : loading ? (
          <div className="tm-loading">
            <GoldenDotsLoading label="加载人才中" />
          </div>
        ) : (
          <>
            <div className="tm-list-header">
            <nav className="tm-category-nav" aria-label="人才分类">
              {categories.map(category => (
                <button
                  key={category.id}
                  className={`tm-category-tab ${activeCategory === category.id ? 'active' : ''}`}
                  onClick={() => setActiveCategory(category.id)}
                  aria-pressed={activeCategory === category.id}
                  type="button"
                >
                  <span>{category.label}</span>
                </button>
              ))}
              {hasProfileFacets && <span className="tm-category-divider" aria-hidden="true" />}
              {profileFacets.outputTypes.map(type => (
                <button
                  key={`output-${type}`}
                  className={`tm-category-tab ${profileFilters.outputTypes.includes(type) ? 'active' : ''}`}
                  onClick={() => setProfileFilters(prev => ({ ...prev, outputTypes: toggleItem(prev.outputTypes, type) }))}
                  aria-pressed={profileFilters.outputTypes.includes(type)}
                  type="button"
                >
                  <span>产出：{OUTPUT_TYPE_LABELS[type]}</span>
                </button>
              ))}
              {profileFacets.pricingModes.map(mode => (
                <button
                  key={`pricing-${mode}`}
                  className={`tm-category-tab ${profileFilters.pricingModes.includes(mode) ? 'active' : ''}`}
                  onClick={() => setProfileFilters(prev => ({ ...prev, pricingModes: toggleItem(prev.pricingModes, mode) }))}
                  aria-pressed={profileFilters.pricingModes.includes(mode)}
                  type="button"
                >
                  <span>计价：{PRICING_MODE_LABELS[mode]}</span>
                </button>
              ))}
              {profileFacets.needsConnectors && (
                <button
                  className={`tm-category-tab ${profileFilters.noExternalSystems ? 'active' : ''}`}
                  onClick={() => setProfileFilters(prev => ({ ...prev, noExternalSystems: !prev.noExternalSystems }))}
                  aria-pressed={profileFilters.noExternalSystems}
                  type="button"
                >
                  <span>无需外部系统</span>
                </button>
              )}
            </nav>
            <TalentSortSelect value={sort} onChange={setSort} />
            <button
              className="tm-header-action tm-list-refresh"
              disabled={refreshing}
              onClick={() => void handleRefreshList()}
              title="同步员工授权并刷新人才列表"
              type="button"
            >
              <RefreshCw size={13} strokeWidth={1.8} className={refreshing ? 'spinning' : undefined} />
              {refreshing ? '刷新中…' : '刷新'}
            </button>
            </div>
            {sections.length ? (
              <div className="tm-sections">
                {sections.map(section => (
                  <TalentSectionList
                    key={section.key}
                    section={section}
                    recruitingId={recruitingId ?? startingChatId}
                    recruitmentsByTemplate={recruitmentsByTemplate}
                    chatBlockedByTemplate={chatBlockedByTemplate}
                    onOpenDetail={handleOpenDetail}
                    onRecruit={handleOpenRecruitDialog}
                    onStartChat={handleStartChat}
                  />
                ))}
              </div>
            ) : (
              <div className="tm-empty">
                <div className="tm-empty-icon"><Search size={24} strokeWidth={1.8} /></div>
                <h2>{agents.length === 0 ? '当前企业暂无可见人才' : '没有找到匹配人才'}</h2>
                <p>{agents.length === 0
                  ? '企业目录没有返回人才。可点击刷新重试，或联系管理员确认目录与模型授权。'
                  : '换个关键词，或切换到全部分类、取消筛选后再试一次。'}</p>
              </div>
            )}
          </>
        )}
      </main>

      <TalentDetailPanel
        key={selectedAgent?.template_id ?? 'closed'}
        agent={selectedAgent}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        recruiting={recruitingId === selectedAgent?.template_id}
        recruited={selectedRecruited}
        onRecruit={selectedAgent ? () => handleOpenRecruitDialog(selectedAgent) : undefined}
        onStartChat={selectedAgent && selectedRecruited ? () => handleStartChat(selectedAgent) : undefined}
        onUsePrompt={selectedAgent && selectedRecruited ? prompt => handleStartChat(selectedAgent, prompt) : undefined}
        startingChat={Boolean(selectedAgent) && startingChatId === selectedAgent?.template_id}
        chatBlockedReason={selectedAgent && selectedRecruited ? chatBlockedByTemplate[selectedAgent.template_id] : undefined}
        chatError={selectedAgent ? actionError || undefined : undefined}
        onRetry={selectedAgent ? () => void handleOpenDetail(selectedAgent) : undefined}
        onClose={handleCloseDetail}
      />

      {pendingRecruitAgent && (
        <RecruitAliasDialog
          talentName={pendingRecruitAgent.name}
          submitting={recruitingId === pendingRecruitAgent.template_id}
          onCancel={handleCloseRecruitDialog}
          onConfirm={handleRecruit}
        />
      )}

      {/* 招募成功 Toast:key 用名字保证同名快速重复招募时动画能重放。 */}
      {recruitToastName && (
        <div key={recruitToastName + '_' + Date.now()} className="tm-toast" role="status">
          <span className="tm-toast-icon"><Check size={12} strokeWidth={2.4} /></span>
          <span>已创建企业员工：{recruitToastName}，请完成配置和成员授权。</span>
        </div>
      )}
    </div>
  )
}
