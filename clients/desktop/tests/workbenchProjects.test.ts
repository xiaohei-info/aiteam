import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFileTree,
  DEEPSEEK,
  defaultFile,
  employeeOptions,
  fileTypeLabel,
  filterProjects,
  formatSize,
  fredProjects,
  fredWorkspaceKeys,
  fromLocalProject,
  hostErrorMessage,
  htmlPageToRun,
  isExpanded,
  localSourceStates,
  needsPolling,
  projectRunnerKind,
  PROJECT_SOURCES,
  runnableUnitCount,
  runPhaseText,
  runStatusFromOutcome,
  sortProjects,
  unitKey,
  unitRevealFile,
  usesDeepSeek,
  visibleTreeRows,
  type FredWorkspaceWire,
  type LocalProjectWire,
  type ProjectFileWire,
  type RunStatus,
  type TreeNode,
} from '../src/pages/Workbench/projects.ts'
import { parseCsv, sandboxedHtml, svgDataUrl } from '../src/pages/Workbench/preview.ts'
import type { ConversationWorkspaces, ExpertProjection } from '../src/api/agent/types.ts'

const KEY_A = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa'
const KEY_B = 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb'
const KEY_C = 'conversation-cccccccccccccccccccccccc'
const KEY_D = 'conversation-dddddddddddddddddddddddd'

const file = (id: string, path: string, modifiedAt: number | null = 1, format: ProjectFileWire['format'] = 'code'): ProjectFileWire => ({
  id, path, format, size: 10, modified_at: modifiedAt,
})

const expert = (employeeId: string, displayName: string, model?: string): ExpertProjection => ({
  employee_id: employeeId,
  display_name: displayName,
  tenant_id: 't',
  version: '1',
  handle: employeeId,
  revoked: false,
  synced_at: '2026-10-20T00:00:00Z',
  model_policy: model ? { model } : undefined,
} as ExpertProjection)

const localProject = (overrides: Partial<LocalProjectWire> = {}): LocalProjectWire => ({
  source: 'codex',
  id: '0123456789abcdef',
  name: 'snake-game',
  description: '贪吃蛇小游戏',
  employee_name: 'Codex',
  model: 'gpt-5',
  models: [],
  location: '~/projects/snake-game',
  created_at: 1,
  updated_at: 100,
  file_count: 2,
  truncated: false,
  files: [file('f1', 'index.html', 5, 'html'), file('f2', 'js/game.js', 9)],
  ...overrides,
})

const workspace = (key: string, files: ProjectFileWire[], extra: Partial<FredWorkspaceWire> = {}): FredWorkspaceWire => ({
  workspace_key: key, name: null, description: null, updated_at: 50, file_count: files.length, truncated: false, files, ...extra,
})

const conversations: ConversationWorkspaces[] = [
  {
    conversation_id: 'chat-1',
    kind: 'chat',
    title: 'GitHub 热门榜',
    entry_employee_id: 'e1',
    coordinator_employee_id: null,
    updated_at: '2026-11-01T00:00:00Z',
    workspaces: [{ employee_id: 'e1', role: 'entry', removed: false, workspace_key: KEY_A, has_files: true }],
  },
  {
    conversation_id: 'group-1',
    kind: 'group',
    title: '官网改版',
    entry_employee_id: null,
    coordinator_employee_id: 'e2',
    updated_at: '2026-11-02T00:00:00Z',
    workspaces: [
      { employee_id: 'e2', role: 'coordinator', removed: false, workspace_key: KEY_B, has_files: true },
      { employee_id: 'e3', role: 'member', removed: true, workspace_key: KEY_C, has_files: true },
      { employee_id: 'e1', role: 'member', removed: false, workspace_key: KEY_D, has_files: false },
    ],
  },
  {
    conversation_id: 'empty',
    kind: 'chat',
    title: null,
    entry_employee_id: 'e1',
    coordinator_employee_id: null,
    updated_at: '2026-11-03T00:00:00Z',
    workspaces: [],
  },
]

const experts = [expert('e1', '小研', 'deepseek-chat'), expert('e2', '协调员', 'gpt-5'), expert('e3', '设计师')]

test('local projects map from the host and keep source states', () => {
  const project = fromLocalProject(localProject())
  assert.equal(project.key, 'codex:0123456789abcdef')
  assert.deepEqual(project.models, ['gpt-5'])
  assert.equal(project.parts.length, 1)
  assert.equal(project.parts[0].files[1].name, 'game.js')
  assert.equal(project.parts[0].label, null)
  assert.deepEqual(fromLocalProject(localProject({ models: ['a', 'b'] })).models, ['a', 'b'])

  const states = localSourceStates({
    sources: [
      { source: 'codex', available: true, project_count: 1, truncated: false, creation_time_unavailable: false },
      { source: 'claude', available: false, project_count: 0, truncated: false, creation_time_unavailable: true },
    ],
    projects: [],
  })
  assert.equal(states[0].status, 'ready')
  assert.equal(states[1].status, 'missing')
  assert.match(states[1].message ?? '', /创建时间/)
  assert.deepEqual(PROJECT_SOURCES, ['fred', 'codex', 'claude', 'claude_desktop', 'workbuddy'])
})

test('Fred lists only folders with files, once each', () => {
  assert.deepEqual(fredWorkspaceKeys(conversations, 10), [KEY_A, KEY_B, KEY_C])
  assert.deepEqual(fredWorkspaceKeys(conversations, 2), [KEY_A, KEY_B])
})

test('Fred chats are one folder; groups merge every member folder, removed ones included', () => {
  const projects = fredProjects(conversations, [
    workspace(KEY_A, [file('a1', 'trending.html', 10, 'html')], { name: 'github-trending', updated_at: 70 }),
    workspace(KEY_B, [file('b1', 'index.html', 30, 'html')], { description: '官网首页' }),
    workspace(KEY_C, [file('c1', 'logo.svg', 20, 'svg')]),
  ], experts)
  assert.deepEqual(projects.map(project => project.id), ['chat-1', 'group-1'])

  const [chat, group] = projects
  assert.equal(chat.name, 'github-trending')
  assert.equal(chat.employeeName, '小研')
  assert.equal(chat.conversationId, 'chat-1')
  assert.equal(chat.location, null)
  assert.deepEqual(chat.models, ['deepseek-chat'])
  assert.equal(chat.updatedAt, 70)
  assert.equal(chat.parts[0].id, KEY_A)

  assert.equal(group.name, '官网改版')
  assert.equal(group.employeeName, '协调员')
  assert.equal(group.description, '官网首页')
  assert.deepEqual(group.parts.map(part => [part.label, part.removed]), [['协调员', false], ['设计师', true]])
  assert.equal(group.fileCount, 2)
  assert.deepEqual(group.models, ['gpt-5'])

  // A folder the host could not list (deleted since) does not make a project.
  assert.deepEqual(fredProjects(conversations.slice(0, 1), [], experts), [])
  const untitled = fredProjects(conversations.slice(0, 1), [workspace(KEY_A, [file('a1', 'a.md', 1, 'markdown')])], [])
  assert.equal(untitled[0].name, 'GitHub 热门榜')
  assert.equal(untitled[0].employeeName, '未知员工')
})

test('projects filter by source, DeepSeek model, employee and file paths', () => {
  const projects = [
    fromLocalProject(localProject()),
    fromLocalProject(localProject({ source: 'claude', id: 'aaaaaaaaaaaaaaaa', name: 'dashboard', description: null, models: ['deepseek-v3'], employee_name: 'Claude Code', updated_at: 200, files: [file('x', 'app.py')] })),
  ]
  assert.deepEqual(sortProjects(projects).map(project => project.name), ['dashboard', 'snake-game'])
  const filter = (source: Parameters<typeof filterProjects>[1]['source'], query = '', employee = '') =>
    filterProjects(projects, { source, query, employee }).map(project => project.name)
  assert.deepEqual(filter('codex'), ['snake-game'])
  assert.deepEqual(filter(DEEPSEEK), ['dashboard'])
  assert.deepEqual(filter('all', 'game.js'), ['snake-game'])
  assert.deepEqual(filter('all', '贪吃蛇'), ['snake-game'])
  assert.deepEqual(filter('all', 'app.py claude'), ['dashboard'])
  assert.deepEqual(filter('all', '', 'Codex'), ['snake-game'])
  assert.ok(usesDeepSeek({ models: ['DeepSeek-R1'] }))
  assert.deepEqual(employeeOptions(projects, 'all').map(option => option.name), ['Claude Code', 'Codex'])
})

const names = (rows: TreeNode[]) => rows.map(row => `${'  '.repeat(row.depth)}${row.name}`)

test('file trees list folders first and put group members at the top level', () => {
  const project = fromLocalProject(localProject({
    files: [file('1', 'src/components/deep/Button.tsx'), file('2', 'README.md'), file('3', 'src/main.ts'), file('4', 'a.txt')],
  }))
  const tree = buildFileTree(project)
  // The first two levels start expanded; deeper folders start collapsed.
  assert.deepEqual(names(visibleTreeRows(tree, new Set())), ['src', '  components', '    deep', '  main.ts', 'a.txt', 'README.md'])
  const components = (tree[0] as Extract<TreeNode, { kind: 'dir' }>).children[0] as Extract<TreeNode, { kind: 'dir' }>
  const deep = components.children[0] as Extract<TreeNode, { kind: 'dir' }>
  assert.equal(isExpanded(components, new Set()), true)
  assert.equal(isExpanded(deep, new Set()), false)
  assert.deepEqual(names(visibleTreeRows(tree, new Set([deep.key]))).slice(0, 4), ['src', '  components', '    deep', '      Button.tsx'])
  assert.deepEqual(names(visibleTreeRows(tree, new Set([tree[0].key]))), ['src', 'a.txt', 'README.md'])

  const [, group] = fredProjects(conversations, [
    workspace(KEY_A, [file('a1', 'x.md')]),
    workspace(KEY_B, [file('b1', 'site/index.html')]),
    workspace(KEY_C, [file('c1', 'logo.svg')]),
  ], experts)
  const groupTree = buildFileTree(group)
  assert.deepEqual(names(visibleTreeRows(groupTree, new Set())), ['协调员', '  site', '    index.html', '设计师（已移出）', '  logo.svg'])
  const fileRow = visibleTreeRows(groupTree, new Set()).find(row => row.kind === 'file' && row.name === 'logo.svg')
  assert.equal(fileRow?.kind === 'file' ? fileRow.part : -1, 1)
})

test('a project opens on its README, then index.html, then the newest file', () => {
  const pick = (files: ProjectFileWire[]) => defaultFile(fromLocalProject(localProject({ files })))?.file.path
  assert.equal(pick([file('1', 'index.html', 9), file('2', 'README.md', 1)]), 'README.md')
  assert.equal(pick([file('1', 'docs/README.md', 9), file('2', 'index.html', 1)]), 'index.html')
  assert.equal(pick([file('1', 'a.js', 1), file('2', 'b.js', 5)]), 'b.js')
  assert.equal(defaultFile({ parts: [] }), null)
})

const status = (overrides: Partial<RunStatus>): RunStatus => ({
  running: false, phase: null, url: null, exit_code: null, url_timed_out: false, logs: [], ...overrides,
})

test('run state: badges, page choice, phase text and polling', () => {
  const demos = [
    { dir: '', runner: { kind: 'html' as const, files: [] } },
    { dir: 'vite-demo', runner: { kind: 'node' as const, script: 'dev' } },
    { dir: 'game', runner: { kind: 'static' as const, dir: '' } },
  ]
  assert.equal(projectRunnerKind([demos]), 'node')
  assert.equal(runnableUnitCount([demos, [{ dir: '', runner: { kind: 'none' } }]]), 3)
  assert.equal(projectRunnerKind([[{ dir: '', runner: { kind: 'none' } }]]), 'none')
  assert.equal(projectRunnerKind([demos, undefined]), null)
  assert.notEqual(unitKey({ source: 'fred', id: KEY_A }, ''), unitKey({ source: 'fred', id: KEY_A }, 'game'))

  // Showing a subfolder app selects a file directly in it, which opens that folder.
  const part = { files: [file('1', 'vite-demo/src/main.js'), file('2', 'vite-demo/package.json'), file('3', 'game/index.html')].map(wire => fromLocalProject(localProject({ files: [wire] })).parts[0].files[0]) }
  assert.equal(unitRevealFile(part, 'vite-demo')?.path, 'vite-demo/package.json')
  assert.equal(unitRevealFile(part, 'game')?.path, 'game/index.html')
  assert.equal(unitRevealFile(part, ''), null)
  assert.equal(unitRevealFile(part, 'missing'), null)

  const pages = { kind: 'html' as const, files: [{ id: 'p1', path: 'a.html' }, { id: 'p2', path: 'b.html' }] }
  assert.equal(htmlPageToRun(pages, 'p2'), 'p2')
  assert.equal(htmlPageToRun(pages, 'readme'), 'p1')
  assert.equal(htmlPageToRun(pages, null), 'p1')
  assert.equal(htmlPageToRun({ kind: 'static', dir: 'dist' }, 'p2'), null)

  assert.equal(runPhaseText(undefined), null)
  assert.equal(runPhaseText(status({ phase: 'preparing', running: true })), '正在安装依赖…')
  assert.match(runPhaseText(status({ phase: 'starting', running: true, url_timed_out: true })) ?? '', /30 秒/)
  assert.equal(runPhaseText(status({ phase: 'exited', exit_code: 1 })), '已退出（退出码 1）')
  assert.match(runPhaseText(status({ phase: 'failed', exit_code: 3 })) ?? '', /退出码 3/)

  const node = { kind: 'node' as const, script: 'dev' }
  assert.ok(needsPolling(node, status({ running: true, phase: 'starting' })))
  assert.ok(!needsPolling(node, status({ phase: 'stopped' })))
  assert.ok(!needsPolling({ kind: 'static', dir: '' }, status({ running: true, phase: 'running' })))

  assert.equal(runStatusFromOutcome({ outcome: 'needs_consent', commands: [], cwd: '/p', fingerprint: 'f' }), null)
  assert.deepEqual(runStatusFromOutcome({ outcome: 'started', ...status({ running: true, phase: 'running', url: 'http://127.0.0.1:5/' }) }),
    status({ running: true, phase: 'running', url: 'http://127.0.0.1:5/' }))
})

test('host errors and file facts read as Chinese labels', () => {
  assert.match(hostErrorMessage('python_unavailable'), /python3/)
  assert.match(hostErrorMessage(new Error('node_unavailable')), /Node/)
  assert.equal(hostErrorMessage('weird', '兜底'), '兜底')
  assert.equal(fileTypeLabel({ name: 'deck.pptx', format: 'document' }), 'PPT')
  assert.equal(fileTypeLabel({ name: 'main.ts', format: 'code' }), 'TS')
  assert.equal(fileTypeLabel({ name: 'photo.png', format: 'image' }), '图片')
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(2048), '2.0 KB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB')
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
  const csp = /<meta http-equiv="Content-Security-Policy" content="default-src 'none'/
  assert.match(sandboxedHtml('<h1>项目</h1>'), csp)
  const withDoctype = sandboxedHtml('<!DOCTYPE html><html><body>x</body></html>')
  assert.ok(withDoctype.startsWith('<!DOCTYPE html><meta'))
  assert.equal(svgDataUrl('<svg a="1"/>'), 'data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%221%22%2F%3E')
})
