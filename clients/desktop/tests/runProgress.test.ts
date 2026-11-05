import assert from 'node:assert/strict'
import test from 'node:test'
import { formatElapsed, runProgress, toolAction } from '../src/lib/runProgress.ts'
import { dispatchPiEvent } from '../src/lib/piConverters.ts'
import type { ThinkingStep, ToolCall } from '../src/stores/chat.ts'

const tool = (name: string, extra: Partial<ToolCall> = {}): ThinkingStep => ({ kind: 'tool', tool: { id: name, name, ...extra } })
const done = (name: string): ThinkingStep => tool(name, { isError: false })
const start = Date.parse('2026-11-05T14:10:00Z')

test('the current tool call names the action, the step count and the time spent', () => {
  const steps = [...Array.from({ length: 17 }, () => done('bash')), tool('bash', { input: { command: 'rm -rf secret' } })]
  assert.equal(runProgress(steps, start, start + 5 * 60_000 + 30_000), '正在运行命令 · 第 18 步 · 已用时 5 分钟')
  const writing = [...Array.from({ length: 30 }, () => done('bash')), tool('write', { fileName: 'report.md' })]
  assert.equal(runProgress(writing, start, start + 10 * 60_000), '正在写入 report.md · 第 31 步 · 已用时 10 分钟')
})

test('between tool calls and before the first minute it still reads 思考中', () => {
  assert.equal(runProgress([], start, start + 20_000), '思考中')
  assert.equal(runProgress([done('bash')], start, start + 59_000), '思考中 · 第 1 步')
  assert.equal(runProgress([done('bash'), { kind: 'reasoning', text: 'next' }], start, start + 61 * 60_000), '思考中 · 第 1 步 · 已用时 1 小时 1 分钟')
  assert.equal(runProgress([tool('bash')], undefined, start), '正在运行命令 · 第 1 步', 'no start time, no elapsed time')
})

test('actions never show commands or paths, and fall back to plain words', () => {
  assert.equal(toolAction({ id: 'a', name: 'read', input: { path: '/Users/me/x.md' } }), '读取文件')
  assert.equal(toolAction({ id: 'a', name: 'edit', fileName: 'app.py' }), '修改 app.py')
  assert.equal(toolAction({ id: 'a', name: 'todo_update' }), '更新任务清单')
  assert.equal(toolAction({ id: 'a', name: 'custom_rag', toolKind: 'rag' }), '查阅知识库')
  assert.equal(toolAction({ id: 'a', name: 'connector_jira_search' }), '调用工具')
  assert.equal(formatElapsed(120 * 60_000), '2 小时')
})

test('tool execution events carry the file name into the tool call', () => {
  const calls: ToolCall[] = []
  const onToolCall = (call: ToolCall) => calls.push(call)
  dispatchPiEvent({ type: 'tool_execution_start', toolCallId: 'w', toolName: 'write', file_name: 'report.md', args: { content: 'x' } } as never, { onToolCall })
  dispatchPiEvent({ type: 'tool_execution_update', toolCallId: 'w', toolName: 'write', file_name: 'report.md' } as never, { onToolCall })
  dispatchPiEvent({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', file_name: '' } as never, { onToolCall })
  assert.deepEqual(calls.map(call => call.fileName), ['report.md', 'report.md', undefined])
})
