import assert from 'node:assert/strict'
import test from 'node:test'
import { composeCapabilityRequestMessage } from '../src/pages/Capabilities/askEmployeeMessage.ts'

test('composeCapabilityRequestMessage 把需求放主体，链接/JSON 只作线索', () => {
  const text = composeCapabilityRequestMessage({ requirement: '我需要一个能查物流的 MCP', link: '', json: '' })
  assert.match(text, /我的需求：我需要一个能查物流的 MCP/)
  assert.match(text, /发 capability_install 让我批准/)
  assert.match(text, /来源可以是 ClawHub、GitHub、公开网址或粘贴的内容，不做限制/)
  assert.doesNotMatch(text, /链接：/)
  assert.doesNotMatch(text, /配置 JSON/)
})

test('composeCapabilityRequestMessage 带上链接与 JSON，并保留原始内容', () => {
  const text = composeCapabilityRequestMessage({ requirement: '按模板写周报', link: 'https://clawhub.ai/a/skills/b', json: '{ "mcpServers": {} }' })
  assert.match(text, /链接：https:\/\/clawhub\.ai\/a\/skills\/b/)
  assert.match(text, /配置 JSON：\n\{ "mcpServers": \{\} \}/)
})
