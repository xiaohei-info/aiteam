import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  createProjectConversation,
  describeProjectConversationError,
  isMacUserAgent,
  latestEmployeeConversations,
  MAX_CONVERSATION_TITLE,
  projectConversationTitle,
  projectHandoffBlock,
  projectSendFailure,
  type DevelopableProject,
} from '../src/lib/projectConversation.ts'
import type { ConversationCreateRequest, ConversationMetadata } from '../src/api/agent/types.ts'

const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf-8')
const codex: DevelopableProject = { source: 'codex', name: 'app', parts: [{ id: 'abc123' }] }

function recorder() {
  const calls: string[] = []
  const created: ConversationCreateRequest[] = []
  return {
    calls,
    created,
    deps: {
      createChallenge: async () => { calls.push('challenge'); return 'challenge-1' },
      authorize: async (challenge: string, source: string, projectId: string) => { calls.push(`authorize:${challenge}:${source}:${projectId}`); return { ticket: 'ticket-1' } },
      create: async (params: ConversationCreateRequest) => { calls.push('create'); created.push(params); return { id: 'new' } as ConversationMetadata },
    },
  }
}

test('不能交给员工时给出原因：非桌面端、非 macOS', () => {
  assert.equal(projectHandoffBlock({ desktop: true, mac: true }), null)
  assert.match(projectHandoffBlock({ desktop: true, mac: false })!, /当前系统/)
  assert.match(projectHandoffBlock({ desktop: false, mac: true })!, /桌面端/)
  assert.equal(isMacUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'), true)
  assert.equal(isMacUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'), false)
})
test('对话名默认项目名，可改名，清空后回到项目名', () => {
  assert.equal(projectConversationTitle('  我的改版 ', '官网'), '我的改版')
  assert.equal(projectConversationTitle('   ', '官网'), '官网')
  assert.equal(projectConversationTitle('长'.repeat(500), '官网').length, MAX_CONVERSATION_TITLE)
})

test('外部项目先取挑战再由宿主签票据，请求里没有路径', async () => {
  const { deps, calls, created } = recorder()
  await createProjectConversation(deps, { project: codex, employeeId: 'emp-1', title: '' })
  assert.deepEqual(calls, ['challenge', 'authorize:challenge-1:codex:abc123', 'create'])
  assert.deepEqual(created[0], { kind: 'chat', entry_employee_id: 'emp-1', title: 'app', project: { name: 'app', ticket: 'ticket-1' } })
})

test('宿主拒绝授权时不创建对话', async () => {
  const { deps, calls } = recorder()
  await assert.rejects(createProjectConversation(
    { ...deps, authorize: async () => { throw 'source_overlaps_runtime' } },
    { project: codex, employeeId: 'emp-1', title: '' },
  ))
  assert.equal(calls.includes('create'), false)
})

test('错误文字不显示内部信息', () => {
  assert.match(describeProjectConversationError('source_overlaps_runtime'), /不能交给员工/)
  assert.match(describeProjectConversationError({ code: 'project_ticket_invalid', message: 'Project authorization expired' }), /过期/)
  assert.match(describeProjectConversationError({ code: 'project_not_found' }), /已不存在/)
  assert.equal(describeProjectConversationError(new Error('/Users/a/secret failed')), '新建对话失败，请重试。')
  assert.match(projectSendFailure({ code: 'project_workspace_unavailable' })!, /历史消息仍可查看/)
  assert.equal(projectSendFailure({ code: 'conversation_busy' }), null)
})

test('员工的主会话不包含项目对话和群聊', () => {
  const conversation = (id: string, updated: string, extra: Partial<ConversationMetadata> = {}) => ({
    id, kind: 'chat', entry_employee_id: 'emp-1', updated_at: updated, ...extra,
  })
  const older = conversation('older', '2026-11-01T00:00:00Z')
  const newer = conversation('newer', '2026-11-02T00:00:00Z')
  const project = conversation('project', '2026-11-08T00:00:00Z', { project: { source: 'codex', name: 'app' } })
  const group = conversation('group', '2026-11-08T00:00:00Z', { kind: 'group' })
  assert.equal(latestEmployeeConversations([older, project, newer, group]).get('emp-1')?.id, 'newer')
  assert.equal(latestEmployeeConversations([project]).has('emp-1'), false)
})

test('入口都走同一套规则：store、打开员工对话、对话页', () => {
  const store = read('src/stores/chat.ts')
  assert.equal(store.split('latestEmployeeConversations(convsRes.conversations)').length - 1, 2, '两处员工主会话映射都排除项目对话')
  assert.ok(store.includes('projectName: c.project?.name ?? null'))
  assert.ok(read('src/lib/openEmployeeChat.ts').includes('!item.projectName'))
  const chat = read('src/pages/Chat/index.tsx')
  assert.ok(chat.includes('项目：${conv.projectName}'), '对话页显示项目名')
  assert.ok(chat.includes('sendFailureRef.current ??'), '目录失效时不提示重试')
  const dialog = read('src/pages/Workbench/ProjectDevelopDialog.tsx')
  assert.ok(dialog.includes("'authorize_project_workspace'"))
  assert.equal(dialog.includes('canonical_path'), false, '前端不接触路径')
  assert.ok(read('src-tauri/src/lib.rs').includes('authorize_project_workspace,'), '宿主注册了命令')
  const workbench = read('src/pages/Workbench/index.tsx')
  assert.ok(workbench.includes('继续对话') && workbench.includes('交给员工继续做'), 'Fred 项目继续原会话，其他项目交给员工')
  assert.equal(workbench.includes('二次开发'), false)
  assert.ok(workbench.includes('className={styles.accentButton}'), '「交给员工继续做」用醒目的主色按钮')
})

test('项目对话的权限面板显示工作目录，可凭宿主票据更换，并提供三档权限', async () => {
  const { readFileSync } = await import('node:fs')
  const panel = readFileSync('src/components/Chat/ConversationPermissions.tsx', 'utf-8')
  assert.ok(panel.includes('metadata?.project?.path'), '工作目录来自会话详情')
  assert.ok(panel.includes("'select_project_folder'") && panel.includes('setConversationProjectFolder(sourceId, ticket)'), '宿主选目录签票据，Agent 凭票据更换')
  assert.ok(!/setConversationProjectFolder\([^)]*projectPath/.test(panel), '不把路径提交给 Agent')
  for (const mode of ["'read-only'", "'workspace-write'", "'full-access'"]) assert.ok(panel.includes(`handlePermission(${mode})`), mode)
})

test('更换目录失败的提示；关掉选择框不提示', async () => {
  const { describeProjectFolderError } = await import('../src/lib/projectConversation.ts')
  assert.equal(describeProjectFolderError('cancelled'), '')
  assert.match(describeProjectFolderError({ code: 'conversation_busy' }), /正在回复/)
  assert.match(describeProjectFolderError('source_overlaps_runtime'), /不能作为项目目录/)
  assert.match(describeProjectFolderError({ code: 'project_ticket_invalid' }), /过期/)
  assert.equal(describeProjectFolderError(new Error('boom')), '更换目录失败，请重试。')
})
