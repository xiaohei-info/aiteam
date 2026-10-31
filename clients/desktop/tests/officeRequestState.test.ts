import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const officeSource = readFileSync(
  new URL('../src/pages/OfficeStatus/index.tsx', import.meta.url),
  'utf8',
)
// 花名册加载与错误分类在常驻运行时里（登录后就开始），页面只读 store
const hostSource = readFileSync(
  new URL('../src/components/OfficeRuntimeHost.tsx', import.meta.url),
  'utf8',
)
const rosterSource = readFileSync(
  new URL('../src/pages/OfficeStatus/officeRoster.ts', import.meta.url),
  'utf8',
)
const storeSource = readFileSync(
  new URL('../src/stores/officeRuntime.ts', import.meta.url),
  'utf8',
)
const panelSource = readFileSync(
  new URL('../src/pages/OfficeStatus/BottomPanels.tsx', import.meta.url),
  'utf8',
)
const constantsSource = readFileSync(
  new URL('../src/pages/OfficeStatus/constants.ts', import.meta.url),
  'utf8',
)

test('office request failure has a classified retryable state and cannot present LIVE', () => {
  assert.match(hostSource, /classifyRequestError/)
  assert.match(officeSource, /<RequestErrorState/)
  assert.match(officeSource, /onRetry=\{retry\}/)
  assert.match(storeSource, /loadAttempt: state\.loadAttempt \+ 1/)
  assert.match(officeSource, /error \? 'ERROR' : 'LIVE'/)
  assert.match(officeSource, /error\s*\? '员工状态不可用'/)
  assert.doesNotMatch(officeSource, /\.catch\(\(err\) => console\.error/)
  assert.doesNotMatch(hostSource, /\.catch\(\(err\) => console\.error/)
})

test('office success uses authoritative summary and keeps a real empty state', () => {
  assert.match(rosterSource, /summary: scene\.summary/)
  assert.match(hostSource, /setState\(\{ agents: next, summary,/)
  assert.match(officeSource, /summary\.working \+ summary\.ready/)
  assert.match(officeSource, /当前没有可展示的 AI 员工/)
  assert.doesNotMatch(officeSource, /MOCK_TASKS|MOCK_STATS/)
})

test('office uses real scheduled feed without mock rows', () => {
  assert.match(officeSource, /agentApi.getOfficeFeed/ )
  assert.match(panelSource, /定时会话摘要/)
  assert.match(panelSource, /暂无真实活动记录/)
  assert.doesNotMatch(constantsSource, /MOCK_|giphy\.com|AI培训市场调研/)
})
