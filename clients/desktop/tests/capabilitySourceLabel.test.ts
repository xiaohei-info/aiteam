import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilitySourceLabel, capabilitySourceTone, customSkillIntegrityLabel, hasLocalDirectory } from '../src/pages/Capabilities/capabilityLabels.ts'

/** 来源文案：本地导入显示「自定义」，有明确平台的 URL 来源显示平台名。 */
test('来源显示：本地导入=自定义，ClawHub=平台名', () => {
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'user_import' }), '自定义')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'clawhub_catalog' }), 'ClawHub')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'enterprise_catalog' }), '企业自建技能')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'platform_catalog' }), '平台技能市场')
  assert.equal(capabilitySourceLabel({ kind: 'mcp', source: 'user_url' }), '手动地址')
})

test('ClawHub 技能也有文件完整性标签（与本地导入一致）', () => {
  assert.deepEqual(customSkillIntegrityLabel({ source: 'clawhub_catalog', integrity: 'ok' }), { text: '文件未改动', attention: false })
  assert.deepEqual(customSkillIntegrityLabel({ source: 'clawhub_catalog', integrity: 'modified' }), { text: '文件被改动，已停用', attention: true })
  assert.equal(customSkillIntegrityLabel({ source: 'clawhub_catalog', integrity: undefined }), null)
  // 非本机来源不给这个标签
  assert.equal(customSkillIntegrityLabel({ source: 'enterprise_catalog', integrity: 'ok' }), null)
})

test('来源徽标的语气：平台/市场用品牌色，企业与本地中性，手动地址弱化', () => {
  assert.equal(capabilitySourceTone({ kind: 'skill', source: 'clawhub_catalog' }), 'brand')
  assert.equal(capabilitySourceTone({ kind: 'skill', source: 'platform_catalog' }), 'brand')
  assert.equal(capabilitySourceTone({ kind: 'skill', source: 'user_import' }), 'neutral')
  assert.equal(capabilitySourceTone({ kind: 'skill', source: 'enterprise_catalog' }), 'neutral')
  assert.equal(capabilitySourceTone({ kind: 'mcp', source: 'user_url' }), 'muted')
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
