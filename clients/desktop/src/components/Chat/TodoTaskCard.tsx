import { Circle, CircleCheck, CircleSlash, ListTodo, LoaderCircle } from 'lucide-react'
import './TodoTaskCard.css'
import { toTodoTaskDisplay } from '../../lib/todoTaskCard'
import type { TodoTaskCardData, TodoTaskDisplayStatus } from '../../lib/todoTaskCard'

interface TodoTaskCardProps {
  card: TodoTaskCardData
  variant?: 'current' | 'history'
  /** 所属回复是否仍在流式输出；只有输出中的当前卡片才显示“进行中”。 */
  isActive?: boolean
}

const STATUS_LABELS: Record<TodoTaskDisplayStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  unfinished: '未完成',
}

function StatusIcon({ status }: { status: TodoTaskDisplayStatus }) {
  if (status === 'completed') return <CircleCheck size={16} aria-hidden="true" />
  if (status === 'in_progress') return <LoaderCircle className="ttc-status-spinner" size={16} aria-hidden="true" />
  if (status === 'unfinished') return <CircleSlash size={16} aria-hidden="true" />
  return <Circle size={16} aria-hidden="true" />
}

function summaryText(display: ReturnType<typeof toTodoTaskDisplay>): string {
  if (display.allCompleted) return `全部完成 · ${display.completed}/${display.total} 已完成`
  if (display.unfinished > 0) return `${display.completed}/${display.total} 已完成 · ${display.unfinished} 项未完成`
  return `${display.completed}/${display.total} 已完成`
}

export default function TodoTaskCard({ card, variant = 'current', isActive = false }: TodoTaskCardProps) {
  const history = variant === 'history'
  // 历史快照与已结束的回复都按终止态展示，避免“进行中”在消息发完后永久旋转。
  const display = toTodoTaskDisplay(card, variant === 'current' && isActive)

  return (
    <section className={`ttc${history ? ' history' : ''}`} aria-label={history ? '任务清单更新' : 'AI 员工任务清单'} aria-live={history ? undefined : 'polite'}>
      <header className="ttc-header">
        <span className="ttc-title">
          <ListTodo size={17} aria-hidden="true" />
          {history ? '任务清单更新' : '任务清单'}
        </span>
        <span className="ttc-summary">{summaryText(display)}</span>
      </header>

      {display.items.length > 0 ? (
        <ul className="ttc-list">
          {display.items.map((item) => (
            <li className={`ttc-item ${item.displayStatus}`} key={item.id}>
              <span className="ttc-status-icon"><StatusIcon status={item.displayStatus} /></span>
              <span className="ttc-item-title">{item.title}</span>
              <span className="ttc-status-label">{STATUS_LABELS[item.displayStatus]}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ttc-empty">当前没有待办任务</p>
      )}
    </section>
  )
}
