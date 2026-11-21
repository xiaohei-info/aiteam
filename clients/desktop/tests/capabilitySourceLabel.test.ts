import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilitySourceLabel, capabilitySourceTone, capabilityTitle, customSkillIntegrityLabel, hasLocalDirectory, installableSkillState, provenanceText, replaceConfirmText } from '../src/pages/Capabilities/capabilityLabels.ts'

/** 来源文案：本地导入显示「自定义」，有明确平台的 URL 来源显示平台名。 */
test('来源显示：本地导入=自定义，ClawHub=平台名', () => {
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'user_import' }), '自定义')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'clawhub_catalog' }), 'ClawHub')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'enterprise_catalog' }), '企业自建技能')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'platform_catalog' }), '平台技能市场')
  assert.equal(capabilitySourceLabel({ kind: 'mcp', source: 'user_url' }), '手动地址')
  assert.equal(capabilitySourceLabel({ kind: 'mcp', source: 'enterprise_catalog' }), '企业自建 MCP')
  assert.equal(capabilitySourceLabel({ kind: 'mcp', source: 'platform_catalog' }), '平台 MCP 目录')
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

test('名称带前缀、出处分「来自 / 改自」（与 web/shared namespace.ts 同一规则）', () => {
  assert.equal(capabilityTitle('taiyim', 'weather'), 'taiyim/weather')
  assert.equal(capabilityTitle('', 'self-improving'), 'self-improving')
  assert.equal(provenanceText({ kind: 'clawhub', label: 'ClawHub a/b', url: '', version: '', edited: false }), '来自 ClawHub a/b')
  assert.equal(provenanceText({ kind: 'platform', label: 'taiyim/weather', url: '', version: '8c2d', edited: true }), '改自 taiyim/weather v8c2d')
  assert.equal(provenanceText(null), '')
})

test('企业可装技能的本机状态：新版 Agent 给的 state 为准（含同名冲突），旧版退回按标识比对', () => {
  const skill = { skill_id: 'platform-p2', version: '2' }
  assert.deepEqual(installableSkillState({ ...skill, state: 'conflict', local_display_name: 'weather', local_ref: 'weather' }, []), { action: 'conflict', name: 'weather' })
  assert.deepEqual(installableSkillState({ ...skill, state: 'update', local_version: '1' }, []), { action: 'upgrade', from: '1' })
  assert.deepEqual(installableSkillState({ ...skill, state: 'installed' }, []), { action: 'installed' })
  assert.deepEqual(installableSkillState(skill, [{ kind: 'skill', ref: 'platform-p2', version: '1' }]), { action: 'upgrade', from: '1' })
  assert.deepEqual(installableSkillState(skill, []), { action: 'install' })
})


test('替换安装确认：写清移除的是哪一个、来源；自己导入的额外提醒改过的内容会删掉', () => {
  const skill = { display_name: '周报', skill_id: 'weekly-report', namespace: '太一科技', local_ref: 'weekly-report', local_display_name: '' }
  const mine = [{ kind: 'skill' as const, ref: 'weekly-report', display_name: '我的周报', source: 'user_import' as const }]
  assert.equal(replaceConfirmText(skill, mine), '将移除本机的「我的周报」（来源：自定义）及它的全部文件，改装「太一科技/周报」。这是你自己导入的技能，你改过的内容也会一起删掉，无法恢复。')
  const fromCatalog = [{ kind: 'skill' as const, ref: 'weekly-report', display_name: '周报', source: 'platform_catalog' as const }]
  assert.equal(replaceConfirmText(skill, fromCatalog), '将移除本机的「周报」（来源：平台技能市场）及它的全部文件，改装「太一科技/周报」。')
  assert.equal(replaceConfirmText({ ...skill, local_display_name: '旧周报' }, []), '将移除本机的「旧周报」及它的全部文件，改装「太一科技/周报」。')
})
