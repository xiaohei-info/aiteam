import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  USAGE_DATA_UNAVAILABLE,
  formatPricePerCall,
  formatUsageCost,
  formatUsageCount,
} from '../src/lib/usageDisplay.ts'

test('usage display preserves real zeroes and formats only valid values', () => {
  assert.equal(formatUsageCount(0), '0')
  assert.equal(formatUsageCount(1234), '1,234')
  assert.equal(formatUsageCost(0, 'USD'), '$0')
  assert.equal(formatUsageCost(12.5, 'CNY'), '¥12.5')
  assert.equal(formatPricePerCall(0.5, 'CNY'), '¥0.5/次')
})

test('missing or invalid usage never falls back to zero', () => {
  for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(formatUsageCount(value), USAGE_DATA_UNAVAILABLE)
    assert.equal(formatUsageCost(value), USAGE_DATA_UNAVAILABLE)
  }
  assert.equal(formatUsageCount(1.5), USAGE_DATA_UNAVAILABLE)
})

test('usage surfaces use explicit B2.1 fields without mining unknown API extensions', () => {
  const agentPanel = readFileSync(
    new URL('../src/components/Chat/AgentDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  const talentDetail = readFileSync(
    new URL('../src/pages/TalentMarket/TalentDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  const agentCard = readFileSync(
    new URL('../src/pages/TalentMarket/AgentCard.tsx', import.meta.url),
    'utf8',
  )
  const marketApi = readFileSync(
    new URL('../src/pages/TalentMarket/api.ts', import.meta.url),
    'utf8',
  )
  const chatStore = readFileSync(
    new URL('../src/stores/chat.ts', import.meta.url),
    'utf8',
  )

  assert.match(agentPanel, /LocalUsage employeeId=\{employeeId\}/)
  assert.match(agentPanel, /WorkHistory employeeId=\{employeeId\}/)
  assert.doesNotMatch(agentPanel, /total_runs:\s*0|total_runs\s*\?\?\s*0/)

  // 议题 7：人才计价只读服务端 pricing 字段，没有数据的指标不上卡片。
  assert.match(talentDetail, /profile\.pricing/)
  assert.match(agentCard, /talentCardMetrics\(/)
  assert.doesNotMatch(agentCard, /recruit_count\s*\?\?\s*0/)

  assert.doesNotMatch(marketApi, /m\.(?:price_per_call|cumulative_cost|invocation_count|token_usage|total_cost)/)
  assert.doesNotMatch(chatStore, /e\.(?:invocation_count|token_usage|total_cost)/)
})

test('talent detail shows pricing only from the server pricing field, without development copy', () => {
  const talentDetail = readFileSync(
    new URL('../src/pages/TalentMarket/TalentDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  const marketApi = readFileSync(
    new URL('../src/pages/TalentMarket/api.ts', import.meta.url),
    'utf8',
  )

  assert.match(talentDetail, /\{profile\.pricing && \(/)
  assert.match(talentDetail, /formatTemplatePricing\(profile\.pricing\)/)
  assert.doesNotMatch(talentDetail, /USAGE_DATA_UNAVAILABLE|数据未提供|待服务端提供|尚未提供计费方式/)

  // Agent / Manager marketplace 契约尚无这些字段，不能从动态扩展或旧 price_tier 猜测。
  assert.doesNotMatch(talentDetail, /\b(?:billing_mode|billing_type|monthly_plan|monthly_package|price_tier)\b/)
  assert.doesNotMatch(marketApi, /\b(?:billing_mode|billing_type|monthly_plan|monthly_package|price_tier|currency)\b/)
})
