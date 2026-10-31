import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildCommandPaletteConversationSources,
  moveCommandPaletteSelection,
  moveTrappedFocus,
  searchCommandPalette,
  UNAVAILABLE_SEARCH_SOURCES,
} from '../src/components/Layout/commandPaletteSearch.ts'
import { isGlobalSearchShortcut } from '../src/components/Layout/globalSearch.ts'

const employees = [
  {
    employeeId: 'employee-1',
    displayName: '林序言',
    roleName: '产品研究员',
    skills: ['用户研究', '竞品分析'],
    persona: '负责产品洞察',
    targetConversationId: 'conversation-1',
  },
  {
    employeeId: 'employee-2',
    displayName: '周砚',
    roleName: '前端工程师',
    skills: ['React'],
    targetConversationId: 'emp_employee-2',
  },
]

const conversations = [
  {
    id: 'conversation-1',
    kind: 'private' as const,
    title: '林序言',
    preview: '季度产品复盘',
  },
  {
    id: 'group-1',
    kind: 'group' as const,
    title: '发布协作组',
    preview: '竞品分析已经整理完成',
    memberCount: 3,
  },
]

test('command palette searches real employee fields and keeps their activation target', () => {
  const result = searchCommandPalette({ query: '用户研究', employees, conversations })

  assert.deepEqual(result.employees.map((item) => item.targetId), ['conversation-1'])
  assert.deepEqual(result.conversations, [])

  const employeeWithoutConversation = searchCommandPalette({ query: '周砚', employees, conversations })
  assert.equal(employeeWithoutConversation.employees[0]?.targetId, 'emp_employee-2')
})

test('conversation search matches metadata titles but does not become message full-text search', () => {
  const titleMatch = searchCommandPalette({ query: '发布', employees, conversations })
  assert.deepEqual(titleMatch.conversations.map((item) => item.targetId), ['group-1'])
  assert.equal(titleMatch.conversations[0]?.kind, 'group-conversation')

  const previewOnly = searchCommandPalette({ query: '季度产品复盘', employees, conversations })
  assert.deepEqual(previewOnly.conversations, [])
})

test('conversation sources include every real private conversation and exclude employee placeholders', () => {
  const sources = buildCommandPaletteConversationSources({
    conversations: [
      { id: 'conversation-mapped', title: '映射会话', employeeId: 'employee-1' },
      { id: 'conversation-orphaned', title: '已撤销员工的历史会话' },
      { id: 'emp_employee-2', title: '仅员工入口', employeeId: 'employee-2' },
    ],
    groups: [{ id: 'group-1', name: '服务端群聊', memberCount: 2 }],
    employees: [
      {
        employeeId: 'employee-1',
        displayName: '林序言',
        conversationId: 'conversation-mapped',
        avatarUrl: 'https://example.test/avatar.png',
      },
    ],
  })

  assert.deepEqual(sources.map((source) => source.id), [
    'conversation-mapped',
    'conversation-orphaned',
    'group-1',
  ])
  assert.equal(sources[0]?.avatarUrl, 'https://example.test/avatar.png')
})

test('command palette is mounted once at the authenticated app router level', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const layoutSource = readFileSync(new URL('../src/components/Layout/index.tsx', import.meta.url), 'utf8')

  assert.match(appSource, /isAuthenticated\s*&&\s*<CommandPalette\s*\/>/)
  assert.equal(appSource.match(/<CommandPalette\s*\/>/g)?.length, 1)
  assert.doesNotMatch(layoutSource, /CommandPalette/)
})

test('command palette ranks exact and prefix matches before contains matches', () => {
  const rankedEmployees = [
    { ...employees[0], employeeId: 'contains', displayName: '设计研究员' },
    { ...employees[0], employeeId: 'prefix', displayName: '研究助理' },
    { ...employees[0], employeeId: 'exact', displayName: '研究' },
  ]
  const result = searchCommandPalette({ query: '研究', employees: rankedEmployees, conversations: [] })

  assert.deepEqual(result.employees.map((item) => item.label), ['研究', '研究助理', '设计研究员'])
})

test('task and knowledge sources are explicitly unavailable and never emitted as fake results', () => {
  assert.deepEqual(UNAVAILABLE_SEARCH_SOURCES.map((source) => source.key), ['tasks', 'knowledge'])
  assert.match(UNAVAILABLE_SEARCH_SOURCES[0].reason, /接口尚未接入/)
  assert.match(UNAVAILABLE_SEARCH_SOURCES[1].reason, /410/)

  const result = searchCommandPalette({ query: '', employees: [], conversations: [] })
  assert.deepEqual(result, { employees: [], conversations: [] })
})

test('arrow navigation and focus trap wrap at both boundaries', () => {
  assert.equal(moveCommandPaletteSelection(-1, 3, 'ArrowDown'), 0)
  assert.equal(moveCommandPaletteSelection(2, 3, 'ArrowDown'), 0)
  assert.equal(moveCommandPaletteSelection(0, 3, 'ArrowUp'), 2)
  assert.equal(moveCommandPaletteSelection(1, 3, 'Home'), 0)
  assert.equal(moveCommandPaletteSelection(1, 3, 'End'), 2)
  assert.equal(moveCommandPaletteSelection(0, 0, 'ArrowDown'), -1)

  assert.equal(moveTrappedFocus(2, 3, false), 0)
  assert.equal(moveTrappedFocus(0, 3, true), 2)
  assert.equal(moveTrappedFocus(-1, 3, false), 0)
  assert.equal(moveTrappedFocus(-1, 3, true), 2)
})

test('global shortcut accepts only exact Command or Ctrl K outside IME composition', () => {
  const baseEvent = {
    key: 'k',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    repeat: false,
  }

  assert.equal(isGlobalSearchShortcut(baseEvent), true)
  assert.equal(isGlobalSearchShortcut({ ...baseEvent, metaKey: false, ctrlKey: true, key: 'K' }), true)
  assert.equal(isGlobalSearchShortcut({ ...baseEvent, metaKey: false }), false)
  assert.equal(isGlobalSearchShortcut({ ...baseEvent, shiftKey: true }), false)
  assert.equal(isGlobalSearchShortcut({ ...baseEvent, isComposing: true }), false)
  assert.equal(isGlobalSearchShortcut({ ...baseEvent, repeat: true }), false)
})
