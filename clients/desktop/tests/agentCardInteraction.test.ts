import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runAgentCardAction } from '../src/pages/TalentMarket/agentCardActions.ts'

test('人才卡片的详情、招募和对话动作互不触发', () => {
  const calls: string[] = []
  const handlers = {
    onDetail: () => calls.push('detail'),
    onRecruit: () => calls.push('recruit'),
    onStartChat: () => calls.push('chat'),
  }

  runAgentCardAction('primary', false, handlers)
  assert.deepEqual(calls, ['recruit'])

  calls.length = 0
  runAgentCardAction('primary', true, handlers)
  assert.deepEqual(calls, ['chat'])

  calls.length = 0
  runAgentCardAction('detail', true, handlers)
  assert.deepEqual(calls, ['detail'])
})

test('人才卡片使用非交互 article，详情按钮已移除且保留主操作', () => {
  const source = readFileSync(
    new URL('../src/pages/TalentMarket/AgentCard.tsx', import.meta.url),
    'utf8',
  )
  const articleOpening = source.match(/<article[\s\S]*?>/)?.[0] ?? ''
  const summaryStart = source.indexOf('<button\n        type="button"\n        className="tm-agent-summary"')
  const summaryEnd = source.indexOf('</button>', summaryStart)
  const summaryMarkup = source.slice(summaryStart, summaryEnd + '</button>'.length)

  assert.doesNotMatch(articleOpening, /onClick=|onKeyDown=|role="button"|tabIndex=/)
  assert.ok(summaryStart >= 0)
  assert.equal(summaryMarkup.match(/<button\b/g)?.length, 1)
  assert.doesNotMatch(source, /stopPropagation|KeyboardEvent/)
  assert.doesNotMatch(source, /className="tm-agent-detail"|查看详情|待配置授权/)
  assert.match(source.slice(summaryEnd), /className="tm-agent-recruit"/)
})
