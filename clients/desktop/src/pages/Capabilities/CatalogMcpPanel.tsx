/**
 * 「添加 MCP · 从企业拿」（设计 2026-11-20 §4.4b）：列出企业从平台启用的与企业自建的 MCP，本人一键安装到本机。
 * 地址、工具与鉴权方式都以企业目录为准；无需登录的点一下就装好，需要登录的直接进入服务方登录，
 * 需要令牌的在这一行填写。令牌只在桌面端 → 本机 Agent 之间流转，提交后立即从界面清空。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BadgeCheck, LoaderCircle, Search } from 'lucide-react'
import { agentApi, AgentApiError } from '../../api/agent'
import type { CatalogMcp, McpLogin } from '../../api/agent/types'
import { capabilityTitle } from './capabilityLabels'
import './McpAuth.css'

const AUTH_LABEL = { none: '无需登录', oauth: '需要登录', bearer: '需要令牌' } as const
const ACTION_LABEL = { install: '安装', update: '更新', conflict: '替换' } as const

function listError(error: unknown): string {
  if (error instanceof AgentApiError && error.status === 503) return '暂时无法连接企业服务，请稍后再试；也可以在「自定义」里粘贴配置添加。'
  return error instanceof Error && error.message ? error.message : '企业 MCP 目录读取失败'
}

function toolsText(item: CatalogMcp): string {
  if (item.tools.length) return `${item.tools.length} 个工具`
  return item.auth === 'oauth' ? '登录后读取工具' : '以服务方实际工具为准'
}

export function CatalogMcpPanel({ onInstalled, onLogin, onClose }: {
  onInstalled: () => void
  /** 需要到服务方网页登录：交给外层窗口显示登录进度，登录完成即装好。 */
  onLogin: (login: McpLogin, name: string) => void
  onClose: () => void
}) {
  const [rows, setRows] = useState<CatalogMcp[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  /** 展开了令牌输入或替换确认的那一行。 */
  const [open, setOpen] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      setRows(await agentApi.listInstallableMcpServers())
      setError('')
    } catch (err) {
      setError(listError(err))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const shown = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (rows ?? []).filter((item) => !keyword || `${item.display_name} ${item.ref} ${item.summary}`.toLowerCase().includes(keyword))
  }, [rows, query])

  const install = async (item: CatalogMcp) => {
    const name = item.display_name || item.ref
    setBusy(item.server_id)
    setRowError(null)
    setNotice('')
    try {
      const result = await agentApi.installCatalogMcpServer(item.server_id, {
        ...(item.state === 'install' ? {} : { replace: true }),
        ...(token.trim() ? { credential: { token: token.trim() } } : {}),
      })
      setToken('')
      setOpen(null)
      if (result.login) { onLogin(result.login, name); return }
      setNotice(`已安装「${name}」，下一轮对话起可用。`)
      // 行立即显示「已安装」，目录在后台刷新（企业目录可能较慢，不让整张表一直锁着）。
      setRows((current) => current?.map((row) => row.server_id === item.server_id ? { ...row, state: 'installed' } : row) ?? current)
      onInstalled()
      void load()
    } catch (err) {
      setToken('')
      setRowError({ id: item.server_id, text: err instanceof Error && err.message ? err.message : '安装失败，请重试' })
      // 本机或企业目录已变化（例如在别处装好了）：刷新状态。
      if (err instanceof AgentApiError && (err.status === 404 || err.status === 409)) await load()
    } finally { setBusy(null) }
  }

  /** 点按钮：需要令牌或替换确认的先在行内展开，其余直接安装。 */
  const start = (item: CatalogMcp) => {
    if (item.auth === 'bearer' || item.state === 'conflict') {
      setOpen(open === item.server_id ? null : item.server_id)
      setToken('')
      setRowError(null)
      return
    }
    void install(item)
  }

  return <>
    {error ? <p role="alert" className="mcp-error">{error}</p>
      : rows === null ? <p className="mcp-note" role="status"><LoaderCircle className="file-access-spinner" size={13} aria-hidden="true" /> 正在读取企业 MCP 目录…</p>
        : rows.length === 0 ? <p className="mcp-note">企业还没有开放 MCP，可联系管理员在 MCP 市场启用或添加。</p>
          : <>
            {rows.length > 6 && <label className="skill-search">
              <Search size={14} aria-hidden="true" />
              <input aria-label="搜索 MCP" placeholder="搜索名称、标识或用途" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>}
            <ul className="skill-list catalog-mcp-list" aria-label="企业可安装的 MCP">
              {shown.map((item) => {
                const working = busy === item.server_id
                const expanded = open === item.server_id
                const needsToken = item.auth === 'bearer' && item.state !== 'update'
                const action = item.state === 'installed' ? null : ACTION_LABEL[item.state]
                return <li key={item.server_id}>
                  <div className="catalog-mcp-row">
                    <span className="skill-list-copy">
                      <strong>{item.display_name || item.ref}</strong>
                      <span>{item.origin === 'platform' ? '平台' : '企业自建'} · {AUTH_LABEL[item.auth]} · {toolsText(item)} · 标识 {capabilityTitle(item.namespace, item.ref)}</span>
                      {item.summary && <span>{item.summary}</span>}
                      {item.state === 'update' && <span>企业已更新这个 MCP，点「更新」换成最新配置。</span>}
                      {rowError?.id === item.server_id && <span role="alert" className="mcp-error">{rowError.text}</span>}
                    </span>
                    {action === null
                      ? <span className="mcp-auth-badge">已安装</span>
                      : <button type="button" aria-expanded={item.auth === 'bearer' || item.state === 'conflict' ? expanded : undefined} disabled={busy !== null} onClick={() => start(item)}>
                        {working ? '正在安装…' : action}
                      </button>}
                  </div>
                  {expanded && <form className="catalog-mcp-expand" aria-label={`安装 ${item.display_name || item.ref}`} onSubmit={(event) => { event.preventDefault(); if ((!needsToken || token.trim()) && !busy) void install(item) }}>
                    {item.state === 'conflict' && <p className="mcp-note">本机已有标识为 {item.ref} 的其他 MCP（你自己添加的）。替换后改用企业提供的这个，原来那个的配置和凭据不再使用。</p>}
                    {item.auth === 'bearer' && <label>访问令牌{item.state === 'update' ? '（留空则沿用本机已保存的令牌）' : ''}（只保存在本机，不进入对话、不交给模型）
                      <input type="password" autoComplete="off" spellCheck={false} autoFocus value={token} disabled={working} onChange={(event) => setToken(event.target.value)} />
                    </label>}
                    <div className="catalog-mcp-expand-actions">
                      <button type="button" disabled={working} onClick={() => { setOpen(null); setToken('') }}>取消</button>
                      <button type="submit" className="primary" disabled={(needsToken && !token.trim()) || busy !== null}>{working ? '正在安装…' : item.state === 'conflict' ? '确认替换' : action}</button>
                    </div>
                  </form>}
                </li>
              })}
              {shown.length === 0 && <li><span className="mcp-note">没有匹配的 MCP。</span></li>}
            </ul>
          </>}
    {notice && <p className="mcp-note installed-note" role="status"><BadgeCheck size={14} aria-hidden="true" />{notice}</p>}
    <p className="mcp-note">地址、工具和鉴权方式以企业目录为准；令牌和登录凭据只保存在本机。</p>
    <footer><button type="button" onClick={onClose}>关闭</button></footer>
  </>
}
