import { useMemo, useState } from 'react'
import type { PermissionMode } from '../../api/agent/types'
import { composeCapabilityRequestMessage } from './askEmployeeMessage.ts'
import { LoaderCircle, Send, UserRound } from 'lucide-react'
import { ChatDialog } from '../../components/Chat/ChatDialog'
import { agentApi } from '../../api/agent'
import type { WorkbenchEmployee } from '../../lib/employeeConversationMap'
import { employeeUnavailableMessage } from '../../lib/employeeAvailability'

/**
 * 「让员工帮我装」：把「企业没有的能力」交给一个员工去判断和安装。
 *
 * 定位（用户拍板）：企业目录里有的，用户自己点安装；只有企业没有的才走这里。
 * 能力仍归成员个人（所有会话可用），员工只是代办——它判断完仍要成员批准才落库。
 * 每次新开会话：不复用历史上下文，避免把别的任务混进来。
 */
export function AskEmployeeDialog({ employees, onSent, onClose }: { employees: WorkbenchEmployee[]; onSent: (conversationId: string, text: string, employeeId: string, title: string) => void; onClose: () => void }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.employeeId ?? '')
  const [requirement, setRequirement] = useState('')
  const [link, setLink] = useState('')
  const [json, setJson] = useState('')
  // 权限默认给最高：装能力要下载、落盘、连服务，只读会处处卡住。
  const [permission, setPermission] = useState<PermissionMode>('full-access')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const blocked = useMemo(() => employeeUnavailableMessage(employees.find((item) => item.employeeId === employeeId)), [employees, employeeId])
  const canSend = Boolean(employeeId) && requirement.trim().length > 0 && !blocked && !busy

  const send = async () => {
    const employee = employees.find((item) => item.employeeId === employeeId)
    if (!employee) return
    setBusy(true); setError('')
    const text = composeCapabilityRequestMessage({ requirement, link, json })
    const title = `让${employee.displayName}帮我装能力`
    try {
      // 每次新开：不复用该员工的旧会话，需求在干净上下文里被判断。
      const conversation = await agentApi.createConversation({ kind: 'chat', entry_employee_id: employee.employeeId, title, permission_mode: permission })
      await agentApi.sendInitialCapabilityRequest(conversation.id, text)
      onSent(conversation.id, text, employee.employeeId, conversation.title || title)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '发送失败，请重试')
      setBusy(false)
    }
  }

  return <ChatDialog title="让员工帮我装" description="企业没有的能力，交给一个员工去判断和安装；装的是你个人的能力" icon={<UserRound size={18} />} className="mcp-dialog" onClose={onClose}>
    <div className="mcp-form">
      <label>选一个员工
        <select value={employeeId} disabled={busy} onChange={(event) => { setEmployeeId(event.target.value); setError('') }}>
          {employees.map((item) => <option key={item.employeeId} value={item.employeeId}>{item.displayName}</option>)}
        </select>
      </label>
      {blocked && <p className="mcp-error">{blocked}</p>}
      <label>你想要什么能力（必填）
        <textarea rows={4} value={requirement} disabled={busy} onChange={(event) => setRequirement(event.target.value)}
          placeholder="例如：我需要一个能查物流轨迹的 MCP；或者一个能按模板写周报的技能。" />
      </label>
      <label>链接（可选）
        <input value={link} disabled={busy} spellCheck={false} inputMode="url" placeholder="ClawHub / GitHub / MCP 地址" onChange={(event) => setLink(event.target.value)} />
      </label>
      <label>对话权限
        <select value={permission} disabled={busy} onChange={(event) => setPermission(event.target.value as PermissionMode)}>
          <option value="read-only">只读（只能读文件）</option>
          <option value="workspace-write">工作区可写（可读写，不联网）</option>
          <option value="full-access">完全访问（不受限，可联网）</option>
        </select>
        <span className="mcp-note">装能力要下载内容、写本机目录、连外部服务，建议「完全访问」。</span>
      </label>
      <label>配置 JSON（可选）
        <textarea rows={4} value={json} disabled={busy} spellCheck={false}
          placeholder={'{ "mcpServers": { "my-server": { "type": "streamableHttp", "url": "https://…" } } }'}
          onChange={(event) => setJson(event.target.value)} />
        <span className="mcp-note">只支持 streamable HTTP 远程服务；配置里的令牌不会被保存。</span>
      </label>
      <p className="mcp-hint"><Send size={13} aria-hidden="true" /><span>点「发给员工」会新开一个会话。员工判断后来找你批准，装好不另发通知，到「能力」页看。</span></p>
      {error && <p role="alert" className="mcp-error">{error}</p>}
      <footer>
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="skill-install" disabled={!canSend} onClick={() => void send()}>
          {busy ? <><LoaderCircle className="file-access-spinner" size={13} aria-hidden="true" />发送中…</> : '发给员工'}
        </button>
      </footer>
    </div>
  </ChatDialog>
}

