import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const detailSource = readFileSync(new URL('../src/pages/TalentMarket/TalentDetailPanel.tsx', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../src/pages/TalentMarket/types.ts', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/pages/TalentMarket/api.ts', import.meta.url), 'utf8')
const agentTypesSource = readFileSync(new URL('../src/api/agent/types.ts', import.meta.url), 'utf8')

test('talent detail shows only server-provided sample outputs and hides the block without data', () => {
  // 议题 7：示例产出取代「典型工作案例」空态；没有数据时整块隐藏，不显示开发期文案。
  assert.match(detailSource, /profile\.sample_outputs\.length > 0 &&/)
  assert.doesNotMatch(detailSource, /暂无可核验历史案例|待服务端提供|数据未提供|USAGE_DATA_UNAVAILABLE/)
})

test('talent market does not model or synthesize unsupported historical case fields', () => {
  const contractSources = `${typesSource}\n${agentTypesSource}`
  const caseField = /\b(?:historical_cases|case_studies|work_examples|showcases)\??\s*:/

  assert.doesNotMatch(contractSources, caseField)
  assert.doesNotMatch(apiSource, caseField)
  assert.doesNotMatch(apiSource, /案例\s*\d|典型案例|成功案例/)
})
