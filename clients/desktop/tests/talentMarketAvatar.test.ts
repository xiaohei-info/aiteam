import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 人才市场展示的是 Operator 目录模板头像（data URL / 同源路径），
// 与员工头像走同一套 `getEmployeeAvatar` + `renderAvatar`，
// 缺少头像时回退到名称首字——不能直接写死首字，否则运营端/企业端有图、桌面端只有字。
const agentCard = readFileSync(
  new URL('../src/pages/TalentMarket/AgentCard.tsx', import.meta.url),
  'utf8',
)
const detailPanel = readFileSync(
  new URL('../src/pages/TalentMarket/TalentDetailPanel.tsx', import.meta.url),
  'utf8',
)

test('人才卡片用模板头像渲染，缺失时回退名称首字', () => {
  assert.match(agentCard, /renderAvatar\(getEmployeeAvatar\(agent\.name, agent\.preview_avatar_url\)/)
  assert.match(agentCard, /agent\.name\.slice\(0, 1\)/)
  assert.doesNotMatch(agentCard, /className="tm-agent-avatar" aria-hidden="true">\s*\{agent\.name\.slice\(0, 1\)\}/)
})

test('专家详情头像优先用详情接口的模板头像，回退到列表项', () => {
  assert.match(detailPanel, /const avatarUrl = detail\?\.preview_avatar_url \?\? agent\.preview_avatar_url/)
  assert.match(detailPanel, /renderAvatar\(getEmployeeAvatar\(name, avatarUrl\)/)
  assert.match(detailPanel, /name\.slice\(0, 1\)/)
})
