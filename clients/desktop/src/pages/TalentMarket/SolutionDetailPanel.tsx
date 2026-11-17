import { Ban, BookOpen, ChevronLeft, Crown, ListChecks, MessageCircle, Plug, ScrollText, User, Users } from 'lucide-react'
import styles from './TalentDetailPanel.module.css'
import type { ExpertProjection, InstallableSkill, LocalCapability, SolutionProjection } from '../../api/agent/types'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import {
  capabilityReadiness,
  renderSolutionRules,
  solutionMode,
  solutionStart,
  SOLUTION_MODE_LABEL,
} from './solutionMarket'

interface SolutionDetailPanelProps {
  solution: SolutionProjection
  experts: readonly ExpertProjection[]
  /** 本人在本机已安装的个人能力；读取失败为 null，推荐能力不标注状态。 */
  localCapabilities: readonly LocalCapability[] | null
  /** 企业目录里本人可自装的技能；读不到为 null。 */
  installableSkills?: readonly InstallableSkill[] | null
  starting: boolean
  actionError?: string
  onStart: () => void
  onClose: () => void
}

/**
 * 方案详情（设计 §3.6）：成员与群主、编排规则（只读）、推荐的 skill / MCP 及本机状态、交付要求。
 * 版式复用专家详情（TalentDetailPanel）的整页面板与卡片样式。
 */
export default function SolutionDetailPanel({ solution, experts, localCapabilities, installableSkills, starting, actionError, onStart, onClose }: SolutionDetailPanelProps) {
  const panelRef = useDialogFocus<HTMLElement>({ active: true })
  useGlobalShortcutClose({ active: true, layer: 'panel', onClose })
  const mode = solutionMode(solution)
  const action = solutionStart(solution, experts)
  const byId = new Map(experts.filter(expert => !expert.revoked).map(expert => [expert.employee_id, expert]))
  const ids = solution.expert_employee_ids ?? []
  const names = new Map(ids.flatMap(id => byId.get(id) ? [[id, byId.get(id)!.display_name] as const] : []))
  const capabilities = solution.recommended_capabilities ?? []

  const sectionHeader = (eyebrow: string, title: string, icon: React.ReactNode) => (
    <div className={styles.sectionHeader}>
      <div><span>{eyebrow}</span><h3>{title}</h3></div>
      {icon}
    </div>
  )

  return (
    <div className={styles.backdrop}>
      <section
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="solution-detail-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      >
        <header className={styles.topBar}>
          <button className={styles.backBtn} onClick={onClose} type="button" aria-keyshortcuts="Meta+W Control+W" title="返回方案列表（⌘W / Ctrl+W）">
            <ChevronLeft size={16} strokeWidth={1.9} />
            <span>返回</span>
          </button>
          <div className={styles.topTitle}>
            <ListChecks size={15} strokeWidth={1.8} />
            <span>方案详情</span>
          </div>
        </header>

        <div className={styles.hero}>
          <div className={styles.avatar} aria-hidden="true">{mode === 'solo' ? <User size={26} strokeWidth={1.6} /> : <Users size={26} strokeWidth={1.6} />}</div>
          <div className={styles.titleBlock}>
            <h2 id="solution-detail-title">{solution.display_name}</h2>
            <p>{SOLUTION_MODE_LABEL[mode]}方案 · {mode === 'solo' ? '与专家私聊使用' : '建群后由群主按规则组织协作'}</p>
          </div>
        </div>

        <div className={styles.contentGrid}>
          <div className={styles.mainColumn}>
            <div className={styles.detailStack}>
              {solution.description && (
                <section className={styles.infoCard}>
                  {sectionHeader('概览', '方案说明', <ScrollText size={17} strokeWidth={1.8} />)}
                  <p className={styles.mutedText}>{solution.description}</p>
                </section>
              )}

              <section className={styles.infoCard} data-testid="solution-detail-members">
                {sectionHeader('团队', mode === 'solo' ? '专家' : '成员与群主', <Users size={17} strokeWidth={1.8} />)}
                <div className={styles.itemList}>
                  {ids.map(id => {
                    const expert = byId.get(id)
                    const coordinator = mode === 'group' && id === solution.coordinator_employee_id
                    return (
                      <div key={id} className={styles.itemRow}>
                        <span className={styles.itemIcon}>{coordinator ? <Crown size={14} strokeWidth={1.8} /> : <User size={14} strokeWidth={1.8} />}</span>
                        <div>
                          <strong>{expert?.display_name ?? '尚未授权到本机的成员'}</strong>
                          <span>{expert?.persona || (expert ? `@${expert.handle}` : '请联系企业管理员授权后刷新')}</span>
                        </div>
                        {coordinator ? <em className={`${styles.statusBadge} ${styles.statusEnabled}`}>群主</em>
                          : !expert ? <em className={`${styles.statusBadge} ${styles.statusMissing}`}>未授权</em> : <span />}
                      </div>
                    )
                  })}
                </div>
              </section>

              {mode === 'group' && (
                <section className={styles.infoCard}>
                  {sectionHeader('群聊编排', '编排规则', <ListChecks size={17} strokeWidth={1.8} />)}
                  {solution.orchestration_rules
                    ? <p className={styles.mutedText} style={{ whiteSpace: 'pre-wrap' }} data-testid="solution-detail-rules">{renderSolutionRules(solution.orchestration_rules, names)}</p>
                    : <p className={styles.mutedText}>该方案没有编排规则，建群后由群主按协作说明自由协调。</p>}
                </section>
              )}

              <section className={styles.infoCard}>
                {sectionHeader('能力', '推荐的 skill 与 MCP', <Plug size={17} strokeWidth={1.8} />)}
                {capabilities.length === 0 ? <p className={styles.mutedText}>该方案没有推荐能力。</p> : (
                  <>
                    <p className={styles.mutedText} style={{ marginBottom: 10 }}>仅供参考，不会自动安装。对话中确实需要时，Agent 会先询问你，同意后才安装。</p>
                    <div className={styles.itemList}>
                      {capabilities.map(item => {
                        const status = capabilityReadiness(item, localCapabilities, installableSkills)
                        // skill 的 ref 是平台 skill_id（UUID），只展示名称；MCP 名称后带上标识
                        const name = !item.display_name || item.display_name === item.ref ? item.ref : item.kind === 'skill' ? item.display_name : `${item.display_name}（${item.ref}）`
                        return (
                          <div key={`${item.kind}:${item.ref}`} className={styles.itemRow} data-testid="solution-detail-capability">
                            <span className={styles.itemIcon}>{item.kind === 'mcp' ? <Plug size={14} strokeWidth={1.8} /> : <BookOpen size={14} strokeWidth={1.8} />}</span>
                            <div>
                              <strong>{item.kind === 'mcp' ? 'MCP' : 'skill'} · {name}</strong>
                              <span>{item.purpose || (item.kind === 'mcp' ? '由你在本机提供地址安装' : '来自企业技能目录')}</span>
                            </div>
                            {status ? <em className={`${styles.statusBadge} ${status.ready ? styles.statusEnabled : styles.statusMissing}`}>{status.label}</em> : <span />}
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </section>

              {(solution.output_requirements || solution.coordinator_instructions) && (
                <section className={styles.infoCard}>
                  {sectionHeader('交付', '交付要求', <ScrollText size={17} strokeWidth={1.8} />)}
                  <div className={styles.specList}>
                    {solution.output_requirements && <div><span>交付要求</span><strong>{solution.output_requirements}</strong></div>}
                    {solution.coordinator_instructions && <div><span>{mode === 'solo' ? '工作说明' : '群主协作说明'}</span><strong>{solution.coordinator_instructions}</strong></div>}
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>

        <div className={styles.actionBar}>
          {actionError
            ? <p role="alert" className={styles.actionError}>{actionError}</p>
            : action.kind === 'unavailable' && <p role="status" className={`${styles.actionError} ${styles.actionNotice}`}>{action.reason}</p>}
          <button className={styles.secondaryBtn} onClick={onClose} type="button">返回</button>
          <button className={styles.primaryBtn} disabled={starting || action.kind === 'unavailable'} onClick={onStart} type="button">
            {action.kind === 'unavailable' ? <Ban size={16} strokeWidth={1.8} /> : mode === 'solo' ? <MessageCircle size={16} strokeWidth={1.8} /> : <Users size={16} strokeWidth={1.8} />}
            {starting ? '处理中…' : action.kind === 'unavailable' ? '暂不可用' : action.label}
          </button>
        </div>
      </section>
    </div>
  )
}
