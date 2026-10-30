import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const profileSource = readFileSync(new URL('../src/pages/Profile/ProfileInfo.tsx', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../src/pages/Settings/index.tsx', import.meta.url), 'utf8')

test('profile exposes session identity as read-only without fake profile or avatar writes', () => {
  assert.doesNotMatch(profileSource, /useState|handleSave|<input|<textarea|\bCamera\b|编辑资料/)
  assert.match(profileSource, /useAgentAuthStore/)
  assert.match(profileSource, /账号身份（只读）/)
  assert.match(profileSource, /登录账号/)
  assert.match(profileSource, /成员 ID/)
  assert.match(profileSource, /不提供资料编辑、头像上传或个人简介保存/)
  assert.match(profileSource, /由企业管理员在管理端维护/)
})

test('settings removes manual service credential inputs and states the managed boundary', () => {
  assert.doesNotMatch(settingsSource, /settings-api-url|settings-api-key|settings-fields|settings-field/)
  assert.doesNotMatch(settingsSource, /type="password"|https:\/\/api\.example\.com|sk-•/)
  assert.match(settingsSource, /由受控部署配置/)
  assert.match(settingsSource, /当前客户端不读取、保存或回显手工 API Key/)
  assert.match(settingsSource, /不支持覆盖服务地址/)
})

test('settings keeps real device preferences and labels their storage scope', () => {
  assert.doesNotMatch(settingsSource, /settings-appearance-title/)
  assert.match(settingsSource, /requestSystemNotificationPermission\(\)/)
  assert.match(settingsSource, /通知偏好仅保存在此设备的当前账号下/)
  assert.match(settingsSource, /readNotificationPreferenceResult/)
  assert.match(settingsSource, /notificationStorageError/)
})
