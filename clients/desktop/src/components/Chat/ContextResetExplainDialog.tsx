import type { ReactNode } from 'react'
import { Brain, ChartColumn, CircleAlert, MessagesSquare, Pencil, Users, Zap } from 'lucide-react'
import { ChatDialog } from './ChatDialog'

interface ExplainItem {
  icon: ReactNode
  title: string
  text: string
}

// 文案与实际行为对应：重置清空模型上下文、保留历史消息；记忆按员工设置保存；评估 7 天内可在分隔线上修改。
const ITEMS: ReadonlyArray<ExplainItem> = [
  {
    icon: <MessagesSquare size={16} />,
    title: '历史消息都保留',
    text: '分隔线以上的消息仍可翻看，只是员工回答新问题时不再读取它们。',
  },
  {
    icon: <Zap size={16} />,
    title: '回复更快、更省',
    text: '对话越长，每次回复要处理的内容越多，越慢、消耗的 token 越多，旧话题也可能干扰新问题。换话题或想换个问法重来时，适合开启新上下文。',
  },
  {
    icon: <Brain size={16} />,
    title: '有用的内容存进记忆',
    text: '员工开启了记忆保存时，这段对话会整理成记忆，之后的对话仍能用到。',
  },
  {
    icon: <ChartColumn size={16} />,
    title: '评估帮助改进员工',
    text: '「已解决 / 未解决」计入员工的解决率和人才市场的质量指标，只统计结果，不包含对话内容。',
  },
  {
    icon: <Pencil size={16} />,
    title: '7 天内可以修改',
    text: '点分隔线上的结果，可以修改或撤销这次评估。',
  },
  {
    icon: <Users size={16} />,
    title: '群聊一起开启',
    text: '群聊里所有参与的员工会一起开启新上下文。',
  },
]

/** 「解决了吗」气泡右侧感叹号打开的说明：开启新上下文意味着什么。 */
export function ContextResetExplainDialog({ onClose }: { onClose: () => void }) {
  return (
    <ChatDialog
      title="开启新上下文是什么意思？"
      className="chat-outcome-explain-dialog"
      icon={<CircleAlert size={20} />}
      description="点「已解决」或「未解决」都会结束这段对话，开启新上下文"
      onClose={onClose}
    >
      <ul className="chat-outcome-explain-list">
        {ITEMS.map((item) => (
          <li key={item.title}>
            <span className="chat-outcome-explain-icon" aria-hidden="true">{item.icon}</span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="chat-outcome-explain-note">暂时不想开启？点气泡上的 ✕ 关闭，下次回复结束后会再提示；不想再被询问就点「不再提示」，可在设置里重新打开。只想换个话题、不评估？点输入框工具栏里的「开启新上下文」按钮。</p>
      <footer>
        <button type="button" className="chat-outcome-explain-ok" onClick={onClose}>知道了</button>
      </footer>
    </ChatDialog>
  )
}
