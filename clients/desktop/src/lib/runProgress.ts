import type { ThinkingStep, ToolCall } from '../stores/chat'

/** What a running reply is doing, in one line: the current action, the step count and the time spent. */

const ACTIONS: Record<string, string> = {
  bash: '运行命令',
  todo_update: '更新任务清单',
  knowledge_search: '查阅知识库',
  knowledge_get: '查阅知识库',
  hindsight_recall: '回想相关记忆',
  hindsight_retain: '记录记忆',
  mention_employee: '请同事协助',
  delegate_employee: '请同事协助',
}
const FILE_ACTIONS: Record<string, string> = { read: '读取', write: '写入', edit: '修改' }
const KIND_ACTIONS: Record<NonNullable<ToolCall['toolKind']>, string> = {
  memory: '回想相关记忆', rag: '查阅知识库', todo: '更新任务清单',
}

/** Never the command or arguments; file tools name only the file the Agent sent (`file_name`). */
export function toolAction(call: ToolCall): string {
  const file = FILE_ACTIONS[call.name]
  if (file) return call.fileName ? `${file} ${call.fileName}` : `${file}文件`
  return ACTIONS[call.name] ?? (call.toolKind ? KIND_ACTIONS[call.toolKind] : undefined) ?? '调用工具'
}

export function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`
}

/**
 * e.g. 「正在写入 report.md · 第 31 步 · 已用时 10 分钟」. A tool call is finished once its result
 * carries `isError`; until then it is the current action, otherwise the model is thinking. The time
 * appears from the first full minute so a quick reply still reads 「思考中」.
 */
export function runProgress(steps: readonly ThinkingStep[], startedAt: number | undefined, now: number): string {
  const tools = steps.flatMap(step => step.kind === 'tool' ? [step.tool] : [])
  const last = steps.length > 0 ? steps[steps.length - 1] : undefined
  const parts = [last?.kind === 'tool' && last.tool.isError === undefined ? `正在${toolAction(last.tool)}` : '思考中']
  if (tools.length > 0) parts.push(`第 ${tools.length} 步`)
  if (startedAt !== undefined && now - startedAt >= 60_000) parts.push(`已用时 ${formatElapsed(now - startedAt)}`)
  return parts.join(' · ')
}
