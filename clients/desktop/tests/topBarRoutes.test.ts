import assert from 'node:assert/strict'
import test from 'node:test'
import { GLOBAL_SEARCH_REQUEST_EVENT } from '../src/components/Layout/globalSearch.ts'
import { resolveTopBarRoute } from '../src/components/Layout/topBarRoutes.ts'

test('TopBar resolves every protected top-level route to its page title', () => {
  const routes: Record<string, string> = {
    '/chat': '单聊',
    '/group-chat': '群聊',
    '/tasks': '自动化',
    '/agents': '智能体',
    '/talents': '人才市场',
    '/skills': '技能中心',
    '/knowledge': '知识库',
    '/workbench': '工作台',
    '/org': '组织架构',
    '/mcp': 'MCP 服务',
    '/office': '办公室',
    '/settings': '设置',
    '/profile': '个人资料',
  }

  for (const [pathname, title] of Object.entries(routes)) {
    assert.equal(resolveTopBarRoute(pathname).title, title)
  }
})

test('TopBar uses navigable parent crumbs for actual nested routes', () => {
  assert.deepEqual(resolveTopBarRoute('/knowledge/local-documents').breadcrumbs, [
    { label: '知识库', to: '/knowledge' },
    { label: '本地文档' },
  ])
  assert.deepEqual(resolveTopBarRoute('/knowledge/kb-1/').breadcrumbs, [
    { label: '知识库', to: '/knowledge' },
    { label: '知识库详情' },
  ])
  assert.deepEqual(resolveTopBarRoute('/chat/conversation-1').breadcrumbs, [
    { label: '单聊', to: '/chat' },
    { label: '会话' },
  ])
  assert.deepEqual(resolveTopBarRoute('/profile/settings').breadcrumbs, [
    { label: '个人资料', to: '/profile' },
    { label: '设置' },
  ])

  const profileTabs: Record<string, string> = {
    '/profile/agents': '智能体',
    '/profile/knowledge': '知识库',
    '/profile/skills': '技能中心',
  }
  for (const [pathname, title] of Object.entries(profileTabs)) {
    const route = resolveTopBarRoute(pathname)
    assert.equal(route.title, title)
    assert.deepEqual(route.breadcrumbs, [
      { label: '个人资料', to: '/profile' },
      { label: title },
    ])
  }
})

test('global search request event name is stable for the command palette integration', () => {
  assert.equal(GLOBAL_SEARCH_REQUEST_EVENT, 'aifred:global-search-request')
})
