import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const createSource = readFileSync(
  new URL('../src/pages/AgentConfig/AgentCreate.tsx', import.meta.url),
  'utf8',
)
const detailSource = readFileSync(
  new URL('../src/pages/AgentConfig/AgentDetail.tsx', import.meta.url),
  'utf8',
)
const knowledgeApiSource = readFileSync(
  new URL('../src/pages/KnowledgeBase/api.ts', import.meta.url),
  'utf8',
)

test('智能体配置不再展示或保存硬编码知识库绑定', () => {
  const configSources = `${createSource}\n${detailSource}`

  assert.doesNotMatch(
    configSources,
    /AVAILABLE_KNOWLEDGE_BASES|INITIAL_KB|ALL_KB|公司财务数据|市场研究报告|客户案例库|用户行为数据|技术文档库/,
  )
  assert.doesNotMatch(createSource, /knowledgeBases:\s*selectedKBs/)
  assert.doesNotMatch(detailSource, /setShowKbPicker|setPendingKbIds|confirmKbPicker/)
})

test('智能体配置知识库入口明确禁用并展示服务不可用原因', () => {
  for (const source of [createSource, detailSource]) {
    assert.match(source, /KNOWLEDGE_BASE_WRITE_AVAILABILITY\.reason/)
    assert.match(source, /<button[\s\S]*?disabled[\s\S]*?aria-describedby="agent-(?:create|detail)-kb-unavailable"/)
    assert.match(source, /role="note"[\s\S]*?KNOWLEDGE_BASE_WRITE_AVAILABILITY\.reason/)
  }
})

test('授权专家缺失生命周期状态时保持未知而不是猜为 active', () => {
  const employeeMapping = knowledgeApiSource.slice(
    knowledgeApiSource.indexOf('export async function fetchKnowledgeEmployees'),
    knowledgeApiSource.indexOf('export async function uploadKnowledgeFile'),
  )

  assert.match(employeeMapping, /status:\s*employee\.status/)
  assert.doesNotMatch(employeeMapping, /status:\s*employee\.status\s*\?\?\s*['"]active['"]/)
})
