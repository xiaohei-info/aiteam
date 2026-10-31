import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('顶层业务页面使用路由级 lazy import 与可访问加载态', () => {
  for (const route of [
    'Chat', 'GroupChat', 'AgentConfig', 'TalentMarket', 'SkillCenter', 'OrgChart',
    'KnowledgeBase', 'KnowledgeBaseDetail', 'McpConfig', 'OfficeStatus', 'Settings',
    'Profile', 'Tasks', 'Login',
  ]) {
    assert.match(appSource, new RegExp(`const ${route} = lazy\\(\\(\\) => import\\(`))
  }
  assert.match(appSource, /<Suspense fallback=\{<RouteLoading \/>\}>/)
  assert.match(appSource, /role="status" aria-live="polite">正在加载页面/)
})
