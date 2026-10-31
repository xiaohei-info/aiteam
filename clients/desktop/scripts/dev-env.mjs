#!/usr/bin/env node
// Run the desktop app (`tauri dev`) against a named environment, or stop / inspect it.
//
// The WebView only talks to the bundled local Agent, so which backend the app uses is decided
// by the Agent's env file. The desktop host (src-tauri/src/agent.rs) honours AITEAM_AGENT_CONFIG
// before the packaged config and before <app data>/agent.env, so passing it explicitly keeps the
// environment independent of whatever was baked into the package or left in the app data dir.
//
//   pnpm dev:test    config/agent/taiyi-test.env
//   pnpm dev:prod    config/agent/production.env (supplied by the deployment owner)
//   pnpm dev:status  which environment the running instance is connected to
//   pnpm dev:stop    stop the running instance
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertEnterpriseConfig, normalizePublicJwks, parseEnterpriseEnv } from './configure-agent-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEV_PORT = 1420 // vite.config.ts uses strictPort
const APP_DATA = path.join(homedir(), 'Library/Application Support/com.aiteam.desktop')
const PLACEHOLDER_HOST = /(?:^|\.)example\.(?:com|org|net)$/u
const TAURI_DEV = /\btauri(?:\.js)?\s+dev\b/u

export const PROFILES = {
  test: { file: 'config/agent/taiyi-test.env', environment: 'test', label: '测试环境' },
  prod: { file: 'config/agent/production.env', environment: 'production', label: '生产环境' },
}

function isPlaceholderUrl(value) {
  try {
    return PLACEHOLDER_HOST.test(new URL(value).hostname)
  } catch {
    return false
  }
}

function assertCanonicalJwks(text, label) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    assert.fail(`${label}：不是合法 JSON`)
  }
  // The Agent rejects unknown JWKS members, so what it reads must already be the canonical public shape.
  assert.deepEqual(normalizePublicJwks(text, label), parsed, `${label}：含 Agent 不接受的字段，只允许 kty/alg/kid/n/e/use`)
}

// Throws an AssertionError with an actionable message. Nothing is stopped or started before it passes.
export function resolveProfile(name, base = root) {
  const profile = PROFILES[name]
  assert.ok(profile, `未知环境 ${name}，可用：${Object.keys(PROFILES).join(' / ')}`)
  const configPath = path.join(base, profile.file)
  if (!existsSync(configPath)) {
    assert.fail(name === 'prod'
      ? `缺少 ${profile.file}：复制 config/agent/production.env.example，填入部署方提供的正式地址与公钥后再切换`
      : `缺少 ${profile.file}`)
  }
  const values = parseEnterpriseEnv(readFileSync(configPath, 'utf8'), profile.file)
  const { environment, jwksPath, jwksJson } = assertEnterpriseConfig(values, profile.file)
  assert.equal(environment, profile.environment, `${profile.file}：AITEAM_ENV 是 ${environment}，${name} 环境必须是 ${profile.environment}`)
  const managerUrl = values.get('AITEAM_MANAGER_URL')
  const upstreamUrl = values.get('AITEAM_AGENT_UPSTREAM_URL') ?? managerUrl
  for (const [key, url] of [['AITEAM_MANAGER_URL', managerUrl], ['AITEAM_AGENT_UPSTREAM_URL', upstreamUrl]]) {
    assert.ok(!isPlaceholderUrl(url), `${profile.file}：${key} 仍是 example 占位地址`)
  }
  const managerJwksMode = values.get('AITEAM_AGENT_JWKS_MODE')?.toLowerCase() === 'manager'
  if (!managerJwksMode && values.get('AITEAM_AGENT_DEV_AUTH')?.toLowerCase() !== 'true') {
    assert.ok(jwksPath || jwksJson, `${profile.file}：未启用开发认证时必须配置公钥（AITEAM_AGENT_JWKS_PATH 或 AITEAM_AGENT_JWKS_JSON）`)
  }
  if (jwksJson) assertCanonicalJwks(jwksJson, 'AITEAM_AGENT_JWKS_JSON')
  if (jwksPath) {
    const jwksFile = path.resolve(path.dirname(configPath), jwksPath)
    assert.ok(existsSync(jwksFile), `${profile.file}：找不到公钥文件 ${jwksPath}`)
    assertCanonicalJwks(readFileSync(jwksFile, 'utf8'), jwksPath)
  }
  return { name, ...profile, configPath, managerUrl, upstreamUrl }
}

// agent.rs launches the sidecar as: start-agent.mjs --config <file> --host 127.0.0.1 --port 0 --data-dir <dir>
export function agentConfigFromCommand(command) {
  return /start-agent\.mjs --config (.+?) --host /u.exec(command)?.[1]
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function listeningPids(port) {
  return run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n').filter(Boolean).map(Number)
}

function processTable() {
  return run('ps', ['-axww', '-o', 'pid=,ppid=,command=']).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
  })
}

function parentOf(table, entry) {
  return table.find(candidate => candidate.pid === entry.ppid)
}

function cwdOf(pid) {
  return run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find(line => line.startsWith('n'))?.slice(1)
}

export function sameFile(left, right) {
  if (!left || !right) return false // realpathSync('') would resolve to the current directory
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// A process that exited between lookup and signal is fine; anything else (EPERM) is reported.
function sendSignal(pid, name) {
  try {
    process.kill(pid, name)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

// The `tauri dev` CLI of THIS checkout: the nearest ancestor of the process holding the dev-server port.
function findDevInstance() {
  const table = processTable()
  for (const pid of listeningPids(DEV_PORT)) {
    if (!sameFile(cwdOf(pid) ?? '', root)) continue
    const server = table.find(entry => entry.pid === pid)
    let current = server
    while (current) {
      if (TAURI_DEV.test(current.command)) return current
      current = parentOf(table, current)
    }
    return server
  }
  return undefined
}

function sidecarPid() {
  try {
    return JSON.parse(readFileSync(path.join(APP_DATA, 'agent-data/agent-port.json'), 'utf8')).pid
  } catch {
    return undefined
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(200)
  }
  return predicate()
}

async function stopDevInstance() {
  const instance = findDevInstance()
  if (!instance) return false
  const sidecar = sidecarPid()
  console.log(`停止已在运行的开发实例（PID ${instance.pid}）…`)
  sendSignal(instance.pid, 'SIGINT') // same as Ctrl+C: tauri dev stops the app and the dev server
  const stopped = () => !alive(instance.pid) && listeningPids(DEV_PORT).length === 0
  if (!(await waitUntil(stopped, 20_000))) {
    sendSignal(instance.pid, 'SIGTERM')
    assert.ok(await waitUntil(stopped, 5_000), '无法停止已在运行的开发实例，请在它所在的终端按 Ctrl+C 后重试')
  }
  // The sidecar exits with its host (it also exits when orphaned); wait so the next launch gets a clean port file.
  if (sidecar && !(await waitUntil(() => !alive(sidecar), 10_000))) {
    console.warn(`提示：旧的本机 Agent（PID ${sidecar}）仍未退出`)
  }
  return true
}

// Without AITEAM_AGENT_CONFIG the host uses <app data>/agent.env if present, else the packaged config staged under agent-config/.
export function describeConfig(configPath) {
  const known = Object.entries(PROFILES).find(([, profile]) => sameFile(configPath, path.join(root, profile.file)))
  if (known) return `${known[1].label}（pnpm dev:${known[0]}）`
  if (configPath === path.join(APP_DATA, 'agent.env')) return `应用数据目录里的自定义配置（${configPath}）`
  return configPath.startsWith(path.join(APP_DATA, 'agent-config') + path.sep) ? '随包配置（不是用 dev:test / dev:prod 启动的）' : '自定义配置'
}

function status() {
  const instance = findDevInstance()
  if (!instance) {
    console.log('开发实例：未运行')
    return
  }
  console.log(`开发实例：运行中（PID ${instance.pid}）`)
  const agentDir = path.join(root, 'src-tauri/resources/agent/')
  const configPath = processTable()
    .filter(entry => entry.command.startsWith(agentDir))
    .map(entry => agentConfigFromCommand(entry.command))
    .find(Boolean)
  if (!configPath) {
    console.log('本机 Agent：尚未启动')
    return
  }
  console.log(`环境：${describeConfig(configPath)}`)
  try {
    const values = parseEnterpriseEnv(readFileSync(configPath, 'utf8'), configPath)
    console.log(`AITEAM_ENV=${values.get('AITEAM_ENV')}  Manager ${values.get('AITEAM_MANAGER_URL')}  上游 Agent ${values.get('AITEAM_AGENT_UPSTREAM_URL') || '无'}`)
  } catch {
    console.log(`配置文件：${configPath}`)
  }
}

function start(profile) {
  if (profile.environment === 'production') console.warn('\n⚠️  生产环境：添加部门等写操作会真实生效，客户端无法撤销。\n')
  console.log(`${profile.label}  Manager ${profile.managerUrl}  上游 Agent ${profile.upstreamUrl || '无（本机执行会话）'}`)
  console.log(`配置 ${profile.file}\n`)
  const child = spawn('pnpm', ['tauri', 'dev'], { cwd: root, stdio: 'inherit', env: { ...process.env, AITEAM_AGENT_CONFIG: profile.configPath } })
  // In a terminal Ctrl+C already reaches `pnpm tauri dev` through the process group; elsewhere forward it.
  process.on('SIGINT', () => { if (!process.stdin.isTTY) child.kill('SIGINT') })
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  child.on('error', error => {
    console.error(`无法启动 pnpm tauri dev：${error.message}`)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}

async function main(argv) {
  assert.equal(process.platform, 'darwin', '目前只支持 macOS 桌面开发环境')
  const [command] = argv
  if (command === 'status') return status()
  if (command === 'stop') {
    console.log((await stopDevInstance()) ? '已停止。' : '没有运行中的开发实例。')
    return
  }
  if (!Object.hasOwn(PROFILES, command ?? '')) {
    console.error('用法：pnpm dev:test | dev:prod | dev:status | dev:stop')
    process.exitCode = 1
    return
  }
  const profile = resolveProfile(command) // validate first, so a bad profile never stops the running instance
  await stopDevInstance()
  start(profile)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof assert.AssertionError ? error.message : error)
    process.exitCode = 1
  })
}
