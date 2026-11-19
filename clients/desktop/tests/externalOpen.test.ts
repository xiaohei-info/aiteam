import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedExternalUrl } from '../src/lib/externalOpen.ts'

/**
 * 「打开浏览器」不能变成任意 URL 执行：只放行明确的平台主机 + https。
 * Rust 侧还会再校验一次，这里保证前端先拦一道并给出可读报错。
 */
test('只允许 clawhub.ai 的 https 地址', () => {
  assert.equal(isAllowedExternalUrl('https://clawhub.ai/pskoett/skills/x'), true)
  assert.equal(isAllowedExternalUrl('https://www.clawhub.ai/skills/x'), true)
  assert.equal(isAllowedExternalUrl('https://CLAWHUB.AI/skills/x'), true)
  // 前缀像但不是这个站点
  assert.equal(isAllowedExternalUrl('https://clawhub.ai.evil.example/skills/x'), false)
  assert.equal(isAllowedExternalUrl('https://evil.example/?u=clawhub.ai'), false)
  // 只放行 https
  assert.equal(isAllowedExternalUrl('http://clawhub.ai/skills/x'), false)
  // 任意其他站点不放行
  assert.equal(isAllowedExternalUrl('https://example.com/'), false)
  assert.equal(isAllowedExternalUrl('不是网址'), false)
  assert.equal(isAllowedExternalUrl(''), false)
})
