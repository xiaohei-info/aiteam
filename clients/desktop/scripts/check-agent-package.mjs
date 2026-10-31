import assert from 'node:assert/strict'
import { createPublicKey } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentConfigState, checkAgentPackage, parseAgentEnv } from './check-agent.mjs'

// Release gate: a DMG must carry a real enterprise config. The shipped template has a
// placeholder Manager origin and empty public keys, so the packaged Agent refuses to
// start and the client only sees an opaque BACKEND_HEALTH_TIMEOUT.
const agent = fileURLToPath(new URL('../src-tauri/resources/agent/', import.meta.url))
for (const file of ['runtime/node', 'bin/start-agent.mjs', 'node_modules/tsx/dist/esm/index.mjs', 'config/agent.env']) {
  assert.ok(existsSync(path.join(agent, file)), `缺少新版 Agent 包文件：${file}。请将完整 macOS 包放入 src-tauri/resources/agent/。`)
}
const manifest = checkAgentPackage(agent)
// A template package can still be built for internal debugging, but only when the
// operator accepts that the Agent will not start until a local agent.env exists.
const templatePackage = !manifest.configured
const internalOnly = templatePackage && process.env.AITEAM_ALLOW_TEMPLATE_AGENT === '1'
if (templatePackage) {
  const state = agentConfigState(agent)
  const summary = `manager=${state.managerUrl || '未设置'}、JWKS=${state.hasJwks ? '有' : '无'}、技能验签公钥=${state.hasSkillKey ? '有' : '无'}`
  if (!internalOnly) {
    assert.fail(`随包 Agent 仍是配置模板（${summary}），部署到客户机后 Agent 会拒绝启动。请先用企业公共配置重新生成随包 config/agent.env（并刷新 manifest.json）后再打包；仅内部联调时可设置 AITEAM_ALLOW_TEMPLATE_AGENT=1 跳过此检查。`)
  }
  console.error(`[agent-package] 已按 AITEAM_ALLOW_TEMPLATE_AGENT=1 跳过企业公共配置检查（${summary}）：此包只能配合本机 agent.env 使用，不能直接交付客户。`)
}

const config = parseAgentEnv(readFileSync(path.join(agent, 'config/agent.env'), 'utf8'))
const value = key => config.get(key) ?? ''
const environment = value('AITEAM_ENV')
if (!internalOnly) {
  const state = agentConfigState(agent)
  const jwksPath = value('AITEAM_AGENT_JWKS_PATH')
  const jwksJson = value('AITEAM_AGENT_JWKS_JSON')
  assert.ok(!(jwksPath && jwksJson), 'JWKS JSON 和 PATH 必须二选一')
  // 与 Agent 启动检查一致：manager 模式与静态 JWKS 互斥。
  assert.ok(value('AITEAM_AGENT_JWKS_MODE') !== 'manager' || !(jwksPath || jwksJson), 'AITEAM_AGENT_JWKS_MODE=manager 不能与静态 JWKS（PATH/JSON）同时配置')
  if (jwksPath) {
    assert.ok(!path.isAbsolute(jwksPath) && !jwksPath.split(/[\\/]/).includes('..'), '随包公钥路径必须位于 config 目录内')
    assert.ok(existsSync(path.join(agent, 'config', jwksPath)), '缺少 env 引用的配套公钥文件')
  }
  const devAuth = value('AITEAM_AGENT_DEV_AUTH').toLowerCase() === 'true'
  if (environment === 'production') {
    assert.equal(devAuth, false, '生产包不允许 AITEAM_AGENT_DEV_AUTH=true')
    assert.ok(value('AITEAM_MANAGER_URL').startsWith('https://'), '生产包 AITEAM_MANAGER_URL 必须使用 HTTPS')
    assert.ok(!value('AITEAM_AGENT_UPSTREAM_URL') || value('AITEAM_AGENT_UPSTREAM_URL').startsWith('https://'), '生产包 AITEAM_AGENT_UPSTREAM_URL 必须使用 HTTPS')
    assert.equal(value('AITEAM_AGENT_JWT_ISSUER'), value('AITEAM_MANAGER_URL'), '生产包 AITEAM_AGENT_JWT_ISSUER 必须与 AITEAM_MANAGER_URL 逐字相同')
    assert.ok(value('AITEAM_AGENT_JWT_AUDIENCE'), '生产包缺少 AITEAM_AGENT_JWT_AUDIENCE')
    assert.ok(state.hasJwks, '生产包缺少企业公共 JWKS（AITEAM_AGENT_JWKS_PATH 或 AITEAM_AGENT_JWKS_JSON）')
    assert.ok(state.hasSkillKey, '生产包缺少技能验签公钥（AITEAM_SKILL_SIGNING_PUBLIC_KEY 或 AITEAM_SKILL_SIGNING_PUBLIC_KEYS）')
  } else if (!devAuth) {
    // A non-production package that still verifies Manager-issued JWTs must be complete.
    assert.ok(value('AITEAM_AGENT_JWT_ISSUER') && value('AITEAM_AGENT_JWT_AUDIENCE'), '未启用开发认证的 Agent 包必须配置 issuer 与 audience')
    assert.ok(state.hasJwks, '未启用开发认证的 Agent 包必须配置企业公共 JWKS')
  }
  const skillKey = value('AITEAM_SKILL_SIGNING_PUBLIC_KEY')
  if (skillKey) {
    assert.ok(value('AITEAM_SKILL_SIGNING_KEY_ID'), 'AITEAM_SKILL_SIGNING_PUBLIC_KEY 必须与 AITEAM_SKILL_SIGNING_KEY_ID 同时提供')
    assert.doesNotThrow(() => createPublicKey({ key: Buffer.from(skillKey, 'base64'), format: 'der', type: 'spki' }), 'AITEAM_SKILL_SIGNING_PUBLIC_KEY 必须是 base64 Ed25519 SPKI 公钥')
  }
}
console.log(`[agent-package] ${manifest.version} / ${manifest.target} / env=${environment || 'unset'} / configured=${manifest.configured}：运行目录与公共配置已检查。`)
