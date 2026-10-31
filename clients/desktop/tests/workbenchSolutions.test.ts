import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEEPSEEK,
  employeeOptions,
  fileTypeLabel,
  FILTER_LABELS,
  filterSolutions,
  fredSolutionFiles,
  fredSolutionsFromArtifacts,
  fromLocalFileContent,
  fromLocalSummary,
  hasConversationActivity,
  localErrorMessage,
  localSourceStates,
  parseCsv,
  sandboxedHtml,
  solutionFileFormat,
  SOLUTION_SOURCES,
  sortSolutions,
  svgDataUrl,
  usesDeepSeek,
  type SolutionFile,
  type SolutionSummary,
} from '../src/pages/Workbench/solutions.ts'
import type { ConversationMetadata, ExpertProjection, LocalFileMetadata } from '../src/api/agent/types.ts'

const conversation = (overrides: Partial<ConversationMetadata>): ConversationMetadata => ({
  id: 'conv',
  title: null,
  kind: 'chat',
  labels: [],
  state: 'idle',
  entry_employee_id: null,
  coordinator_employee_id: null,
  solution_instance_id: null,
  schedule: null,
  permission_mode: 'default',
  last_read_entry_id: null,
  created_at: '2026-10-20T08:00:00Z',
  updated_at: '2026-10-21T08:00:00Z',
  ...overrides,
} as ConversationMetadata)

const expert = (employeeId: string, displayName: string, extra: Partial<ExpertProjection> = {}): ExpertProjection => ({
  employee_id: employeeId,
  display_name: displayName,
  tenant_id: 't',
  version: '1',
  handle: employeeId,
  revoked: false,
  synced_at: '2026-10-20T00:00:00Z',
  ...extra,
} as ExpertProjection)

const artifact = (id: string, filename: string, createdAt: string, extra: Partial<LocalFileMetadata> = {}): LocalFileMetadata => ({
  id,
  conversation_id: 'conv',
  tenant_id: 't',
  member_id: 'm',
  kind: 'artifact',
  filename,
  mime_type: 'text/markdown',
  byte_size: 10,
  sha256: id,
  created_at: createdAt,
  ...extra,
})

test('only solution documents count, never code, images or housekeeping files', () => {
  assert.equal(solutionFileFormat('登录方案.md'), 'markdown')
  assert.equal(solutionFileFormat('REPORT.HTML'), 'html')
  assert.equal(solutionFileFormat('预算.xlsx'), 'document')
  assert.equal(solutionFileFormat('logo.svg'), 'svg')
  for (const name of ['main.ts', 'chart.png', 'README.md', 'AGENTS.md', '.notes.md', 'Makefile', '']) {
    assert.equal(solutionFileFormat(name), null, name)
  }
  assert.equal(fileTypeLabel({ name: '汇报.pptx', format: 'document' }), 'PPT')
  assert.equal(fileTypeLabel({ name: '方案.md', format: 'markdown' }), 'Markdown')
})

test('Fred artifacts keep only the newest version of each document', () => {
  const files = fredSolutionFiles([
    artifact('a1', 'plan.md', '2026-10-22T08:00:00Z'),
    artifact('a2', 'plan.md', '2026-10-22T09:00:00Z'),
    artifact('a3', 'build.py', '2026-10-22T10:00:00Z', { mime_type: 'text/plain' }),
    artifact('a4', '汇报.pptx', '2026-10-22T07:00:00Z'),
    artifact('u1', 'upload.md', '2026-10-22T11:00:00Z', { kind: 'attachment' }),
  ])
  assert.deepEqual(files.map(file => [file.id, file.name, file.format]), [
    ['a2', 'plan.md', 'markdown'],
    ['a4', '汇报.pptx', 'document'],
  ])
  assert.equal(files[0].changedAt, Date.parse('2026-10-22T09:00:00Z'))
  assert.equal(files[0].mimeType, 'text/markdown')
  assert.equal(files[0].path, null)
  assert.equal(files[0].model, null)
})

test('only Fred conversations that produced documents become solutions', () => {
  const experts = [
    expert('emp-a', '小析', { avatar_url: 'https://cdn/a.png', model_policy: { model: 'gpt-x' } as ExpertProjection['model_policy'] }),
    expert('emp-b', '小协'),
  ]
  assert.equal(hasConversationActivity(conversation({ last_preview: null, last_message_at: null })), false)
  assert.equal(hasConversationActivity(conversation({ last_preview: '好的' })), true)

  const solutions = fredSolutionsFromArtifacts([
    { conversation: conversation({ id: 'c1', entry_employee_id: 'emp-a' }), artifacts: [artifact('a1', '方案.md', '2026-10-22T08:00:00Z')] },
    // 只生成了代码的对话不是方案。
    { conversation: conversation({ id: 'c2', entry_employee_id: 'emp-a' }), artifacts: [artifact('a2', 'main.ts', '2026-10-22T08:00:00Z')] },
    { conversation: conversation({ id: 'g1', kind: 'group', title: '季度复盘', coordinator_employee_id: 'emp-b' }), artifacts: [artifact('a3', '复盘.docx', '2026-10-23T08:00:00Z')] },
    { conversation: conversation({ id: 'g2', kind: 'group' }), artifacts: [artifact('a4', 'notes.txt', '2026-10-24T08:00:00Z')] },
  ], experts)

  assert.deepEqual(solutions.map(solution => solution.key), ['fred:c1', 'fred:g1', 'fred:g2'])
  const [chat, group, unnamedGroup] = solutions
  assert.equal(chat.employeeName, '小析')
  assert.equal(chat.employeeAvatarUrl, 'https://cdn/a.png')
  assert.equal(chat.model, 'gpt-x')
  assert.deepEqual(chat.models, ['gpt-x'])
  assert.deepEqual(group.models, [])
  assert.equal(chat.title, '与 小析 的会话')
  assert.equal(chat.updatedAt, Date.parse('2026-10-22T08:00:00Z'))
  assert.equal(group.isGroup, true)
  assert.equal(group.employeeName, '小协')
  assert.equal(group.title, '季度复盘')
  assert.equal(unnamedGroup.employeeName, '群聊协作')
  assert.equal(unnamedGroup.title, '未命名群聊')
})

const file = (overrides: Partial<SolutionFile>): SolutionFile => ({
  id: 'f',
  name: 'plan.md',
  path: null,
  format: 'markdown',
  kind: 'created',
  exists: true,
  changedAt: null,
  task: null,
  model: null,
  mimeType: null,
  ...overrides,
})

const summary = (overrides: Partial<SolutionSummary>): SolutionSummary => ({
  key: 'fred:x',
  source: 'fred',
  id: 'x',
  title: '方案',
  employeeName: '小析',
  employeeAvatarUrl: null,
  workspace: null,
  model: null,
  models: [],
  createdAt: null,
  updatedAt: null,
  isGroup: false,
  files: [file({})],
  ...overrides,
})

test('solutions filter by source, employee and file names or requests', () => {
  const solutions = [
    summary({ key: 'fred:1', title: '登录 SSO 方案', employeeName: '小析', updatedAt: 3 }),
    summary({ key: 'codex:2', source: 'codex', title: 'Intel 安装包', employeeName: 'Codex', workspace: '~/Code/AITeam', updatedAt: 5,
      files: [file({ name: 'mac-intel-dmg-build.md', task: '将配置过程输出为文档' })] }),
    summary({ key: 'workbuddy:3', source: 'workbuddy', title: 'BLE 后台', employeeName: 'WorkBuddy', updatedAt: null, files: [file({ name: '架构.pptx' })] }),
    summary({ key: 'fred:4', title: '周报', employeeName: '小析', updatedAt: 4 }),
  ]

  assert.deepEqual(sortSolutions(solutions).map(item => item.key), ['codex:2', 'fred:4', 'fred:1', 'workbuddy:3'])
  const keys = (filter: Parameters<typeof filterSolutions>[1]) => filterSolutions(solutions, filter).map(item => item.key)
  assert.deepEqual(keys({ source: 'all', employee: '', query: '' }), ['fred:1', 'codex:2', 'workbuddy:3', 'fred:4'])
  assert.deepEqual(keys({ source: 'fred', employee: '', query: '' }), ['fred:1', 'fred:4'])
  assert.deepEqual(keys({ source: 'all', employee: '小析', query: 'sso' }), ['fred:1'])
  assert.deepEqual(keys({ source: 'all', employee: '', query: 'dmg 输出' }), ['codex:2'])
  assert.deepEqual(keys({ source: 'all', employee: '', query: 'aiteam' }), ['codex:2'])
  assert.deepEqual(keys({ source: 'all', employee: '', query: '.pptx' }), ['workbuddy:3'])
  assert.deepEqual(keys({ source: 'codex', employee: '小析', query: '' }), [])

  assert.deepEqual(employeeOptions(solutions, 'all'), [
    { name: '小析', count: 2 },
    { name: 'Codex', count: 1 },
    { name: 'WorkBuddy', count: 1 },
  ])
  assert.deepEqual(employeeOptions(solutions, 'codex'), [{ name: 'Codex', count: 1 }])
})

test('DeepSeek collects solutions written by DeepSeek models on any platform', () => {
  const solutions = [
    summary({ key: 'claude:1', source: 'claude', employeeName: 'Claude Code', models: ['glm-5.3', 'deepseek-v4-flash'] }),
    summary({ key: 'workbuddy:2', source: 'workbuddy', employeeName: 'WorkBuddy', models: ['DeepSeek-V4.1-Flash'] }),
    summary({ key: 'claude:3', source: 'claude', employeeName: 'Claude Code', models: ['claude-opus-4-8'] }),
    summary({ key: 'qoder:4', source: 'qoder', employeeName: 'Qoder', models: [] }),
  ]
  assert.equal(usesDeepSeek(solutions[0]), true)
  assert.equal(usesDeepSeek(solutions[2]), false)
  const keys = (filter: Parameters<typeof filterSolutions>[1]) => filterSolutions(solutions, filter).map(item => item.key)
  assert.deepEqual(keys({ source: DEEPSEEK, employee: '', query: '' }), ['claude:1', 'workbuddy:2'])
  // 同一方案仍在原来源下，DeepSeek 与来源重复计数。
  assert.deepEqual(keys({ source: 'claude', employee: '', query: '' }), ['claude:1', 'claude:3'])
  assert.deepEqual(keys({ source: 'all', employee: '', query: 'opus' }), ['claude:3'])
  assert.deepEqual(employeeOptions(solutions, DEEPSEEK), [
    { name: 'Claude Code', count: 1 },
    { name: 'WorkBuddy', count: 1 },
  ])
  assert.deepEqual(SOLUTION_SOURCES, ['fred', 'claude', 'claude_desktop', 'codex', 'trae', 'qoder', 'workbuddy'])
  assert.equal(FILTER_LABELS.claude_desktop, 'Claude 桌面版')
  assert.equal(FILTER_LABELS.deepseek, 'DeepSeek')
})

test('local agent records map to solutions, file contents and source states', () => {
  const solution = fromLocalSummary({
    source: 'codex',
    id: '01a0d0f7',
    title: '组件化方案',
    employee_name: 'Codex',
    workspace: '~/Code/app',
    model: 'gpt-6',
    models: ['gpt-6'],
    created_at: 100,
    updated_at: 200,
    files: [{ id: '0123456789abcdef', name: '方案.md', path: '~/Code/app/docs/方案.md', format: 'markdown', kind: 'created', exists: false, changed_at: 200, task: '写成文档', model: 'gpt-6' }],
  })
  assert.equal(solution.key, 'codex:01a0d0f7')
  assert.deepEqual(solution.models, ['gpt-6'])
  assert.deepEqual(solution.files[0], {
    id: '0123456789abcdef', name: '方案.md', path: '~/Code/app/docs/方案.md', format: 'markdown', kind: 'created',
    exists: false, changedAt: 200, task: '写成文档', model: 'gpt-6', mimeType: null,
  })
  assert.deepEqual(fromLocalFileContent({ name: '方案.md', path: '~/x', format: 'markdown', origin: 'record', content: '# 方案' }), { text: '# 方案', fromRecord: true })
  assert.deepEqual(fromLocalFileContent({ name: 'a.docx', path: '~/a.docx', format: 'document', origin: 'disk', content: null }), { text: null, fromRecord: false })

  assert.deepEqual(localSourceStates({
    sources: [
      { source: 'codex', available: true, solution_count: 13, truncated: true },
      { source: 'claude_desktop', available: false, solution_count: 0, truncated: false },
      { source: 'workbuddy', available: false, solution_count: 0, truncated: false },
    ],
    solutions: [],
  }), [
    { source: 'codex', status: 'ready', count: 13, truncated: true },
    { source: 'claude_desktop', status: 'missing', count: 0, truncated: false },
    { source: 'workbuddy', status: 'missing', count: 0, truncated: false },
  ])

  assert.equal(localErrorMessage('file_missing'), '原文件已删除或移动，且无法从会话记录还原')
  assert.equal(localErrorMessage(new Error('home_unavailable')), '无法确定当前用户目录')
  assert.equal(localErrorMessage('/Users/me/.codex leaked detail'), '读取本机 Agent 记录失败')
})

test('CSV previews handle quotes, CRLF, BOM and row limits', () => {
  assert.deepEqual(parseCsv('\uFEFF名称,说明\r\n"A,1","含""引号"""\r\n\r\nB,"多\n行"\n').rows, [
    ['名称', '说明'],
    ['A,1', '含"引号"'],
    ['B', '多\n行'],
  ])
  assert.deepEqual(parseCsv('a\nb\nc\nd', 2), { rows: [['a'], ['b']], truncated: true })
  assert.deepEqual(parseCsv('a\nb', 2), { rows: [['a'], ['b']], truncated: false })
})

test('HTML and SVG previews cannot load external resources', () => {
  const csp = /^<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">/
  assert.match(sandboxedHtml('<h1>方案</h1>'), csp)
  const withDoctype = sandboxedHtml('<!DOCTYPE html><html><body>x</body></html>')
  assert.ok(withDoctype.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"'))
  assert.ok(withDoctype.endsWith('<html><body>x</body></html>'))
  assert.equal(svgDataUrl('<svg a="1"/>'), 'data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%221%22%2F%3E')
})
