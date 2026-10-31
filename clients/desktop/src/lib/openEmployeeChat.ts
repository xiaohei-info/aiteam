import type { NavigateFunction } from 'react-router-dom'
import { agentApi } from '../api/agent'
import { useChatStore } from '../stores/chat'

/**
 * 组织架构、办公室、命令面板里的「和某员工对话」：打开该员工最近的会话，没有才新建。
 * 对话列表只包含真实会话，不再有 emp_ 占位，所以不能只靠跳转时携带员工 ID。
 */
export async function openEmployeeChat(
  employee: { employeeId: string; displayName: string },
  navigate: NavigateFunction,
): Promise<void> {
  const store = useChatStore.getState()
  // 列表按最近消息排序，第一条即最近的会话。
  const existing = store.conversations.find((item) => item._employeeId === employee.employeeId)
  if (existing) {
    store.setActiveConvId(existing.id)
    navigate('/chat')
    return
  }
  const created = await agentApi.createConversation({ kind: 'chat', entry_employee_id: employee.employeeId })
  navigate('/chat', {
    state: {
      employeeId: employee.employeeId,
      conversationId: created.id,
      profileName: employee.displayName,
      agentName: employee.displayName,
      refreshWorkbench: true,
    },
  })
}
