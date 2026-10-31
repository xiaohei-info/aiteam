/**
 * 知识来源按归属分三张卡：企业知识库 / 个人知识库 / 本机目录。
 *
 * 企业知识库由管理员在管理后台配置，部署位置（Manager 托管或企业内网 NAS）只读显示，成员无需填写地址；
 * 浏览和上传文档仍走客户端到 Manager 的直连，所以保留「连接」入口。旧版 Agent 没有来源索引时，企业卡沿用连接状态。
 * 个人知识库是原「NAS 知识库」，可以连接多台服务；新建在某台服务那一行发起，所以目标服务总是明确的。
 * 本机目录来自本机 Agent 已注册的目录，按员工开关在聊天「权限」里管理。
 * @events onConnectEnterprise 打开企业知识库连接弹窗
 * @events onAddNas 打开添加个人知识库服务弹窗
 * @events onEditNas 打开某台个人服务的连接弹窗
 * @events onCreateInNas 打开在某台个人服务上新建知识库的弹窗
 * @events onOpenLocal 打开本地文档页
 */
import { Building2, HardDrive, Laptop, LockKeyhole, Plus, Tag } from 'lucide-react'
import type { KnowledgeSource, KnowledgeSourceConnection } from './knowledgeService'
import { enterpriseDeploymentTag, type EnterpriseSourceSummary, type LocalSourceSummary } from './knowledgeSourceGroups'

/** One connected personal service as shown on the page; `name` is empty when the user gave none. */
export interface NasConnectionView {
  id: string
  name: string
  address: string
  connection: KnowledgeSourceConnection
  count: number
}

interface Props {
  enterprise: KnowledgeSourceConnection
  /** Agent 来源索引里的企业部分；null 表示旧版 Agent 或读取失败，沿用连接状态。 */
  enterpriseIndex: EnterpriseSourceSummary | null
  nas: NasConnectionView[]
  /** Agent 来源索引里的本机部分；null 时只显示说明。 */
  local: LocalSourceSummary | null
  onConnectEnterprise: () => void
  onAddNas: () => void
  onEditNas: (id: string) => void
  onCreateInNas: (id: string) => void
  onOpenLocal: () => void
}

const STATUS_LABEL: Record<KnowledgeSourceConnection['state'], string> = {
  unconfigured: '未连接',
  checking: '连接中',
  connected: '已连接',
  error: '连接失败',
}

export function KnowledgeSourceStatus({ connection }: { connection: KnowledgeSourceConnection }) {
  return <span className={`kb-source-pill is-${connection.state}`} role="status">{STATUS_LABEL[connection.state]}</span>
}

function EnterpriseCard({ enterprise, index, onConnect }: { enterprise: KnowledgeSourceConnection; index: EnterpriseSourceSummary | null; onConnect: () => void }) {
  const isConnected = enterprise.state !== 'unconfigured'
  const deploymentTag = index ? enterpriseDeploymentTag(index) : null
  const cardState = index?.state === 'unavailable' ? 'error' : index ? 'connected' : enterprise.state
  const description = index?.state === 'unavailable'
    ? '企业服务暂不可用，稍后点「刷新」重试。'
    : index
      ? '企业所有，按岗位权限可读。由管理员在管理后台配置，无需你填写地址。'
      : '企业所有，按岗位权限可读。连接后，企业知识库会出现在下方列表中。'
  const meta = index?.state === 'ready'
    ? (index.count > 0 ? `${index.count} 个空间` : '暂无你可读的空间')
    : null
  return (
    <article className={`kb-source-card is-${cardState}`} data-source="enterprise">
      <div className="kb-source-card-head">
        <span className="kb-source-card-icon"><Building2 size={17} strokeWidth={1.8} /></span>
        <div className="kb-source-card-title">
          <strong>企业知识库</strong>
          {deploymentTag && <span className="kb-source-deployment">{deploymentTag}</span>}
          {index
            ? <span className={`kb-source-pill is-${index.state === 'ready' ? 'connected' : 'error'}`} role="status">{index.state === 'ready' ? '已开通' : '暂不可用'}</span>
            : <KnowledgeSourceStatus connection={enterprise} />}
        </div>
      </div>
      <div className="kb-source-card-body">
        <p>{description}</p>
        {isConnected && <code className="kb-source-card-address" title={enterprise.address}>{enterprise.address}</code>}
        {enterprise.state === 'error' && <p className="kb-source-card-error">{enterprise.message}</p>}
      </div>
      <div className="kb-source-card-foot">
        <span className="kb-source-card-meta">{meta ?? (index ? '' : '每个企业 1 个，由 Manager 自动开通')}</span>
        <button
          type="button"
          className="kb-header-action"
          onClick={onConnect}
          aria-label={isConnected ? '修改企业知识库连接' : '连接企业知识库'}
          title={index && !isConnected ? '浏览和上传企业文档需要连接 Manager' : undefined}
        >
          {isConnected ? '修改连接' : '连接企业知识库'}
        </button>
      </div>
    </article>
  )
}

function PersonalCard({ nas, onAddNas, onEditNas, onCreateInNas }: Pick<Props, 'nas' | 'onAddNas' | 'onEditNas' | 'onCreateInNas'>) {
  const libraryCount = nas.reduce((sum, item) => sum + item.count, 0)
  return (
    <article className="kb-source-card kb-nas-panel" data-source="local">
      <div className="kb-source-card-head">
        <span className="kb-source-card-icon"><HardDrive size={17} strokeWidth={1.8} /></span>
        <div className="kb-source-card-title">
          <strong>个人知识库</strong>
          {nas.length > 0 && <span className="kb-source-deployment">已连接 {nas.length} 个服务</span>}
        </div>
      </div>
      <div className="kb-source-card-body">
        <p>你自己的 NAS 或自建服务，仅本人可见，可授权给你的 AI 员工。可以连接多个服务，在某个服务那一行新建知识库。</p>
      </div>
      <div className="kb-source-card-foot">
        <span className="kb-source-card-meta">{nas.length ? `${libraryCount} 个知识库` : '还没有连接个人知识库服务'}</span>
        <button type="button" className="kb-header-action" onClick={onAddNas}>
          <Plus size={13} strokeWidth={2} />添加个人知识库服务
        </button>
      </div>
      {nas.length > 0 && (
        <ul className="kb-nas-list" aria-label="已连接的个人知识库服务">
          {nas.map((item) => {
            const title = item.name || item.address
            const isFailed = item.connection.state === 'error'
            return (
              <li key={item.id} className={`kb-nas-row is-${item.connection.state}`} data-nas-id={item.id}>
                <div className="kb-nas-row-main">
                  <div className="kb-source-card-title">
                    <strong title={title}>{title}</strong>
                    <KnowledgeSourceStatus connection={item.connection} />
                  </div>
                  {item.name && <code className="kb-source-card-address" title={item.address}>{item.address}</code>}
                  <p>{item.connection.state === 'error' ? item.connection.message : `这个服务上有 ${item.count} 个知识库`}</p>
                </div>
                <div className="kb-nas-row-actions">
                  <button
                    type="button"
                    className="kb-header-action kb-nas-create"
                    onClick={() => onCreateInNas(item.id)}
                    disabled={isFailed}
                    title={isFailed ? '这个服务连接失败，请先修改连接' : undefined}
                    aria-label={`在「${title}」上新建个人知识库`}
                  >
                    <Plus size={13} strokeWidth={2} />新建知识库
                  </button>
                  <button type="button" className="kb-header-action" onClick={() => onEditNas(item.id)} aria-label={`修改「${title}」的连接`}>
                    修改连接
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}

function LocalCard({ local, onOpenLocal }: { local: LocalSourceSummary | null; onOpenLocal: () => void }) {
  const meta = local?.state === 'host_unavailable'
    ? '本机目录服务暂不可用'
    : local?.state === 'ready' && local.unavailableCount > 0
      ? `${local.unavailableCount} 个目录需要重新授权`
      : '员工能否检索，在聊天的「权限 → 目录」里按员工打开'
  return (
    <article className={`kb-source-card ${local?.state === 'host_unavailable' ? 'is-error' : ''}`} data-source="device">
      <div className="kb-source-card-head">
        <span className="kb-source-card-icon"><Laptop size={17} strokeWidth={1.8} /></span>
        <div className="kb-source-card-title">
          <strong>本机目录</strong>
          {local?.state === 'ready' && <span className="kb-source-deployment">{local.count} 个目录</span>}
        </div>
      </div>
      <div className="kb-source-card-body">
        <p>这台电脑上的文件夹，不上传，员工只检索命中的片段。</p>
      </div>
      <div className="kb-source-card-foot">
        <span className="kb-source-card-meta">{meta}</span>
        <button type="button" className="kb-header-action" onClick={onOpenLocal}>本地文档</button>
      </div>
    </article>
  )
}

export default function KnowledgeSourceCards({ enterprise, enterpriseIndex, nas, local, onConnectEnterprise, onAddNas, onEditNas, onCreateInNas, onOpenLocal }: Props) {
  return (
    <section className="kb-source-cards" aria-label="知识来源">
      <EnterpriseCard enterprise={enterprise} index={enterpriseIndex} onConnect={onConnectEnterprise} />
      <PersonalCard nas={nas} onAddNas={onAddNas} onEditNas={onEditNas} onCreateInNas={onCreateInNas} />
      <LocalCard local={local} onOpenLocal={onOpenLocal} />
    </section>
  )
}

export interface KnowledgeSourceDraft {
  name: string
  url: string
  token: string
}

export const EMPTY_SOURCE_DRAFT: KnowledgeSourceDraft = { name: '', url: '', token: '' }

const FIELD_COPY: Record<KnowledgeSource, { url: string; urlPlaceholder: string; token: string; tokenPlaceholder: string }> = {
  enterprise: {
    url: 'Manager 地址',
    urlPlaceholder: 'https://manager.example.com（根地址，不带 /api/manager）',
    token: 'Manager 访问令牌',
    tokenPlaceholder: 'Manager 登录令牌；上传和授权需 owner / enterprise_admin',
  },
  local: {
    url: '服务地址',
    urlPlaceholder: 'https://nas.example.com',
    token: '访问令牌',
    tokenPlaceholder: 'Bearer token，可选',
  },
}

/** 单一来源的连接输入，连接弹窗使用；只有个人服务有名称。 */
export function KnowledgeSourceFields({ source, draft, disabled, autoFocus = true, onChange }: {
  source: KnowledgeSource
  draft: KnowledgeSourceDraft
  disabled?: boolean
  autoFocus?: boolean
  onChange: (draft: KnowledgeSourceDraft) => void
}) {
  const copy = FIELD_COPY[source]
  const Icon = source === 'local' ? HardDrive : Building2
  const focus = autoFocus ? { autoFocus: true, 'data-dialog-initial-focus': true } : {}
  return (
    <>
      {source === 'local' && (
        <label className="kb-field">
          <span><Tag size={13} />服务名称</span>
          <input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder="选填，例如：家里 NAS；不填则显示地址"
            maxLength={40}
            disabled={disabled}
            {...focus}
          />
        </label>
      )}
      <label className="kb-field">
        <span><Icon size={13} />{copy.url}</span>
        <input
          value={draft.url}
          onChange={(event) => onChange({ ...draft, url: event.target.value })}
          placeholder={copy.urlPlaceholder}
          disabled={disabled}
          {...(source === 'enterprise' ? focus : {})}
        />
      </label>
      <label className="kb-field">
        <span><LockKeyhole size={13} />{copy.token}</span>
        <input
          type="password"
          value={draft.token}
          onChange={(event) => onChange({ ...draft, token: event.target.value })}
          placeholder={copy.tokenPlaceholder}
          autoComplete="off"
          disabled={disabled}
        />
      </label>
    </>
  )
}
