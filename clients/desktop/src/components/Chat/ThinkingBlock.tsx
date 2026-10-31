import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import TodoTaskCard from './TodoTaskCard'
import { parseTodoTaskCard } from '../../lib/todoTaskCard'
import type { ThinkingStep, ToolCall } from '../../stores/chat'

interface ThinkingBlockProps {
  steps?: ThinkingStep[]
  isStreaming?: boolean
  autoExpand?: boolean
}

export function ThinkingBlock({ steps, isStreaming, autoExpand = true }: ThinkingBlockProps) {
  const [isOpen, setIsOpen] = useState(false)
  const processId = useId()
  const autoExpanded = Boolean(isStreaming && autoExpand)
  const expanded = autoExpanded || isOpen
  const hasTools = steps?.some((step) => step.kind === 'tool')

  if (!steps || steps.length === 0) return null

  return (
    <div className="tb-wrap">
      {!autoExpanded && (
        <button type="button" onClick={() => setIsOpen(!isOpen)} className="chat-thinking-toggle" aria-expanded={expanded} aria-controls={processId}>
          <ChevronRight
            size={10}
            strokeWidth={1.7}
            className={`chat-thinking-chevron${expanded ? ' open' : ''}`}
          />
          {hasTools ? '执行过程' : '推理过程'}
        </button>
      )}

      {expanded && (
        <div id={processId} className="chat-thinking-body">
          {steps.map((step, i) =>
            step.kind === 'reasoning' ? (
              <div key={i} className="tb-content">
                {isStreaming ? (
                  <span>{step.text}</span>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.text}</ReactMarkdown>
                )}
              </div>
            ) : (
              <ToolCallItem key={i} call={step.tool} />
            )
          )}
        </div>
      )}
    </div>
  )
}

function ToolCallItem({ call }: { call: ToolCall }) {
  const todo = parseTodoTaskCard(call)
  if (todo) return <TodoTaskCard card={todo} variant="history" />

  return (
    <div className="tb-content tb-tool-block">
      <div className="tb-tool-inline-header">
        <span className="tb-tool-name">{call.name}</span>
        <span className="tb-tool-op-badge">工具调用</span>
        {call.isError && <span className="tb-tool-error-badge">错误</span>}
      </div>
      {call.input && (
        <pre className="tb-tool-json">{JSON.stringify(call.input, null, 2)}</pre>
      )}
      {call.result !== undefined && (
        <>
          <div className="tb-tool-result-label">结果</div>
          <pre className="tb-tool-json">{call.result}</pre>
        </>
      )}
    </div>
  )
}
