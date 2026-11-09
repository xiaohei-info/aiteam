import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { conversationWorkspaceKey } from '../src/lib/conversationPermissions.ts'
import type { ConversationWorkspaces } from '../src/api/agent/types.ts'

const item = (workspaces: Array<[string | null, string, boolean?]>): ConversationWorkspaces => ({
  conversation_id: 'c1', kind: 'chat', title: null, entry_employee_id: null, coordinator_employee_id: null,
  updated_at: '2026-11-09T00:00:00.000Z',
  workspaces: workspaces.map(([employee_id, workspace_key, removed]) => ({
    employee_id, role: 'member', removed: removed ?? false, workspace_key, has_files: true,
  })),
})

test('没有受管目录时返回 null', () => {
  assert.equal(conversationWorkspaceKey(undefined, 'e1'), null)
  assert.equal(conversationWorkspaceKey(item([]), 'e1'), null)
})

test('群聊成员共用一个目录，取第一个', () => {
  assert.equal(conversationWorkspaceKey(item([['e1', 'agent开发组-3f8c2b'], ['e2', 'agent开发组-3f8c2b']]), null), 'agent开发组-3f8c2b')
})

test('私聊优先取入口员工的目录，没有匹配时取仍在会话内的第一个', () => {
  const chat = item([['e1', '会话-aaaaaa/旧员工'], ['e2', '会话-aaaaaa/新员工']])
  assert.equal(conversationWorkspaceKey(chat, 'e2'), '会话-aaaaaa/新员工')
  assert.equal(conversationWorkspaceKey(chat, 'e9'), '会话-aaaaaa/旧员工')
})

test('已移出成员的目录只在没有其他目录时兜底', () => {
  assert.equal(conversationWorkspaceKey(item([['e1', 'a-111111', true], ['e2', 'b-222222']]), 'e1'), 'b-222222')
  assert.equal(conversationWorkspaceKey(item([['e1', 'a-111111', true]]), null), 'a-111111')
})

test('权限面板通过宿主解析真实路径并提供在文件夹中显示，前端不拼路径', () => {
  const panel = fs.readFileSync(path.resolve(process.cwd(), 'src/components/Chat/ConversationPermissions.tsx'), 'utf-8')
  assert.ok(panel.includes("'fred_workspace_path'"))
  assert.ok(panel.includes('reveal: true'))
  assert.ok(panel.includes('在 Finder 中显示'))
})
