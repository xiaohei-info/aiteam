import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilitySourceLabel, hasLocalDirectory } from '../src/pages/Capabilities/capabilityLabels.ts'

/** 来源文案：本地导入显示「自定义」，有明确平台的 URL 来源显示平台名。 */
test('来源显示：本地导入=自定义，ClawHub=平台名', () => {
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'user_import' }), '自定义')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'clawhub_catalog' }), 'ClawHub')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'enterprise_catalog' }), '企业自建技能')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'platform_catalog' }), '平台技能市场')
  assert.equal(capabilitySourceLabel({ kind: 'mcp', source: 'user_url' }), '手动地址')
})

test('只有本机导入的技能能在文件管理器里显示目录', () => {
  assert.equal(hasLocalDirectory({ kind: 'skill', source: 'user_import' }), true)
  assert.equal(hasLocalDirectory({ kind: 'skill', source: 'clawhub_catalog' }), true)
  // 企业/平台签名技能没有本机目录
  assert.equal(hasLocalDirectory({ kind: 'skill', source: 'enterprise_catalog' }), false)
  assert.equal(hasLocalDirectory({ kind: 'skill', source: 'platform_catalog' }), false)
  // MCP 不是本机目录
  assert.equal(hasLocalDirectory({ kind: 'mcp', source: 'user_url' }), false)
})
