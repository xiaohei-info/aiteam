import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentApiClient, AgentRequestOptions } from '../src/api/agent/client.ts'
import { loginByAccount, resetPassword, syncAuthenticatedAgent } from '../src/api/agent/auth.ts'
import {
  invalidateSecureCredential,
  isPasswordResetRequired,
  resolveAuthenticatedTenantId,
  shouldInvalidateSessionOnUnauthorized,
  persistVerifiedCredential,
  readCredentialWithRetry,
  SessionPersistenceError,
} from '../src/lib/authSession.ts'
import {
  matchSavedCredentialProfile,
  parseSavedLoginCredentials,
} from '../src/lib/loginCredentials.ts'

test('authenticated bootstrap syncs the current member before checking runtime readiness', async () => {
  const requests: AgentRequestOptions[] = []
  const client = { request: async (options: AgentRequestOptions) => {
    requests.push(options)
    return options.method === 'POST' ? { ok: true } : { runtime: 'ready', experts: [{ available: false }] }
  } } as AgentApiClient
  assert.deepEqual(await syncAuthenticatedAgent(client, { tenant_id: 'tenant-1', user_id: 'member-1' }), { skippedEmployeeIds: [] })
  assert.deepEqual(requests, [
    { method: 'POST', path: '/api/agent/grants/sync', body: { tenant_id: 'tenant-1', member_id: 'member-1' } },
    { path: '/api/agent/grants/readiness' },
  ])
})

test('partial sync reports skipped employees without blocking bootstrap', async () => {
  const sync = (body: unknown) => syncAuthenticatedAgent({ request: async (options: AgentRequestOptions) => (
    options.method === 'POST' ? body : { runtime: 'ready' }
  ) } as AgentApiClient, { tenant_id: 'tenant-1', user_id: 'member-1' })
  assert.deepEqual(await sync({ ok: true, partial: true, skipped_employee_ids: ['e1', '', 3, 'e2'] }), { skippedEmployeeIds: ['e1', 'e2'] })
  assert.deepEqual(await sync({ ok: true, partial: false, skipped_employee_ids: [] }), { skippedEmployeeIds: [] })
  // 旧版随包 Agent 不返回 partial 字段。
  assert.deepEqual(await sync({ ok: true, upserted: 1, revoked: 0 }), { skippedEmployeeIds: [] })
})

test('failed sync stops bootstrap before readiness and reports a retryable error', async () => {
  let count = 0
  const client = { request: async () => { count++; throw new Error('Manager unavailable') } } as unknown as AgentApiClient
  await assert.rejects(syncAuthenticatedAgent(client, { tenant_id: 'tenant-1', user_id: 'member-1' }), /同步用户授权配置失败/)
  assert.equal(count, 1)
})

test('bootstrap rejects unconfirmed sync and blocked runtime', async () => {
  for (const ok of [false, true]) {
    const client = { request: async (options: AgentRequestOptions) => options.method === 'POST' ? { ok } : { runtime: 'blocked' } } as AgentApiClient
    await assert.rejects(syncAuthenticatedAgent(client, { tenant_id: 'tenant-1', user_id: 'member-1' }), /同步用户授权配置失败/)
  }
})

test('saved credentials are readable by a subsequent desktop session', async () => {
  let vault: string | null = null
  const credential = JSON.stringify({ token: 'test-token', account: 'test-account' })
  await persistVerifiedCredential(credential, async value => { vault = value }, async () => vault)
  assert.equal(await readCredentialWithRetry(async () => vault), credential)
})

test('transient credential vault failures retry without discarding saved credentials', async () => {
  let attempts = 0
  const result = await readCredentialWithRetry(async () => {
    attempts += 1
    if (attempts < 3) throw new Error('vault temporarily unavailable')
    return 'saved-session'
  }, async () => {})
  assert.equal(result, 'saved-session')
  assert.equal(attempts, 3)
})

test('missing credentials are not treated as transient vault errors', async () => {
  const result = await readCredentialWithRetry(async () => null, async () => {
    assert.fail('a missing entry must not be retried')
  })
  assert.equal(result, null)
})

test('persistent vault read failures stop after three attempts', async () => {
  let attempts = 0
  await assert.rejects(readCredentialWithRetry(async () => {
    attempts += 1
    throw new Error('vault locked')
  }, async () => {}), /vault locked/)
  assert.equal(attempts, 3)
})

test('failed or unreadable credential writes never report successful persistence', async () => {
  await assert.rejects(persistVerifiedCredential('session', async () => {}, async () => null), SessionPersistenceError)
  await assert.rejects(persistVerifiedCredential('session', async () => {}, async () => 'old-session'), SessionPersistenceError)
  await assert.rejects(persistVerifiedCredential('session', async () => {
    throw new Error('native detail that must not reach the UI')
  }, async () => null), (error: unknown) => {
    assert.ok(error instanceof SessionPersistenceError)
    assert.ok(!error.message.includes('native detail'))
    return true
  })
})

test('Agent success rejects missing tenant claims', () => {
  assert.throws(() => resolveAuthenticatedTenantId('tenant-1', null), /empty tenant_id/)
  assert.throws(() => resolveAuthenticatedTenantId('tenant-1', ''), /empty tenant_id/)
  assert.equal(resolveAuthenticatedTenantId('tenant-1', 'tenant-1'), 'tenant-1')
})

test('empty or conflicting tenant identities are rejected before persistence', () => {
  assert.throws(
    () => resolveAuthenticatedTenantId('', null),
    /empty tenant_id/,
  )
  assert.throws(
    () => resolveAuthenticatedTenantId('tenant-1', 'tenant-2'),
    /do not match/,
  )
})

test('only the documented forbidden reset details enter forced password reset', () => {
  for (const detail of [
    'password reset required before login',
    'password expired (90d); reset required',
  ]) {
    assert.equal(isPasswordResetRequired({
      status: 403,
      code: 'forbidden',
      problem: { code: 'forbidden', detail },
    }), true)
  }

  for (const error of [
    { status: 403, code: 'forbidden', problem: { detail: 'member is not active' } },
    { status: 403, code: 'permission_denied', problem: { detail: 'password reset required' } },
    { status: 401, code: 'unauthorized', problem: { detail: 'password reset required' } },
  ]) {
    assert.equal(isPasswordResetRequired(error), false)
  }
})

test('public credential failures do not invalidate the pending reset flow', () => {
  assert.equal(shouldInvalidateSessionOnUnauthorized(401, null), false)
  assert.equal(shouldInvalidateSessionOnUnauthorized(401, ''), false)
  assert.equal(shouldInvalidateSessionOnUnauthorized(401, 'active-token'), true)
  assert.equal(shouldInvalidateSessionOnUnauthorized(403, 'active-token'), false)
})

test('late unauthorized responses cannot invalidate a newly authenticated session', () => {
  assert.equal(shouldInvalidateSessionOnUnauthorized(401, 'old-token', 'new-token'), false)
  assert.equal(shouldInvalidateSessionOnUnauthorized(401, 'old-token', null), false)
  assert.equal(shouldInvalidateSessionOnUnauthorized(401, 'current-token', 'current-token'), true)
})

test('account login resolves tenant before sending the credential request', async () => {
  const requests: AgentRequestOptions[] = []
  const client = {
    request: async (options: AgentRequestOptions) => {
      requests.push(options)
      if (options.path === '/api/auth/resolve-tenant-by-account') {
        return { tenant_id: 'tenant-1' }
      }
      return {
        token: 'token-1',
        claims: { user_id: 'member-1', tenant_id: null, roles: ['member'] },
      }
    },
  } as AgentApiClient

  const result = await loginByAccount(client, { account: 'member@example.com', password: 'Old-Pass-1!' })

  assert.equal(result.claims.tenant_id, null)
  assert.deepEqual(requests, [
    {
      method: 'POST',
      path: '/api/auth/resolve-tenant-by-account',
      body: { account: 'member@example.com' },
    },
    {
      method: 'POST',
      path: '/api/agent/login',
      body: {
        tenant_id: 'tenant-1',
        account: 'member@example.com',
        password: 'Old-Pass-1!',
      },
    },
  ])
})

test('password reset client sends the exact Agent contract and accepts its new session', async () => {
  let request: AgentRequestOptions | null = null
  const client = {
    request: async (options: AgentRequestOptions) => {
      request = options
      return {
        token: 'replacement-token',
        claims: { user_id: 'owner-1', tenant_id: 'tenant-1', roles: ['owner'] },
      }
    },
  } as AgentApiClient

  const result = await resetPassword(client, {
    tenant_id: 'tenant-1',
    account: 'owner@example.com',
    old_password: 'Bootstrap-1!',
    new_password: 'Replacement-2!',
  })

  assert.equal(result.token, 'replacement-token')
  assert.deepEqual(request, {
    method: 'POST',
    path: '/api/agent/reset-password',
    body: {
      tenant_id: 'tenant-1',
      account: 'owner@example.com',
      old_password: 'Bootstrap-1!',
      new_password: 'Replacement-2!',
    },
  })
})

test('failed keyring deletion leaves a non-restorable tombstone', async () => {
  let persisted = '{"token":"old-token"}'
  const operations: string[] = []

  await invalidateSecureCredential(
    async () => {
      operations.push('write-tombstone')
      persisted = ''
    },
    async () => {
      operations.push('delete')
      throw new Error('keyring deletion denied')
    },
  )

  assert.deepEqual(operations, ['write-tombstone', 'delete'])
  assert.equal(persisted, '')
})

test('tombstone write failures are surfaced because invalidation is not safe', async () => {
  let deleteAttempted = false

  await assert.rejects(
    invalidateSecureCredential(
      async () => { throw new Error('keyring write denied') },
      async () => { deleteAttempted = true },
    ),
    /keyring write denied/,
  )
  assert.equal(deleteAttempted, false)
})

test('SSE 身份复核只在 whoami 确认当前凭证 401 时退出', async () => {
  const { verifyUnauthorizedSession } = await import('../src/lib/authSession.ts')
  assert.equal(await verifyUnauthorizedSession('current', () => 'current', async () => 401), 'confirmed')
  assert.equal(await verifyUnauthorizedSession('current', () => 'current', async () => 200), 'rejected')
  for (const status of [403, 500, 503]) {
    assert.equal(await verifyUnauthorizedSession('current', () => 'current', async () => status), 'unavailable')
  }
  assert.equal(await verifyUnauthorizedSession('current', () => 'current', async () => { throw new Error('offline') }), 'unavailable')
})

test('复核期间换号或旧连接返回 401，不能清除新会话', async () => {
  const { verifyUnauthorizedSession } = await import('../src/lib/authSession.ts')
  assert.equal(await verifyUnauthorizedSession('old', () => 'new', async () => { assert.fail('旧凭证不应复核') }), 'stale')
  let current = 'old'
  assert.equal(await verifyUnauthorizedSession('old', () => current, async () => { current = 'new'; return 401 }), 'stale')
  assert.equal(await verifyUnauthorizedSession(null, () => null, async () => 401), 'stale')
})

test('按企业标识与账号匹配多用户本地加密档案', () => {
  const profiles = [
    { enterprise: 'acme', account: 'alice@acme.com', updated_at: 200 },
    { enterprise: 'globex', account: 'alice@acme.com', updated_at: 300 },
    { enterprise: 'acme', account: 'bob@acme.com', updated_at: 100 },
    { enterprise: '', account: 'solo@example.com', updated_at: 400 },
  ]

  assert.deepEqual(
    matchSavedCredentialProfile(profiles, 'acme', 'alice@acme.com'),
    { enterprise: 'acme', account: 'alice@acme.com', updated_at: 200 },
  )
  assert.deepEqual(
    matchSavedCredentialProfile(profiles, 'GLOBEX', 'Alice@Acme.com'),
    { enterprise: 'globex', account: 'alice@acme.com', updated_at: 300 },
  )
  assert.deepEqual(
    matchSavedCredentialProfile(profiles, '', 'bob@acme.com'),
    { enterprise: 'acme', account: 'bob@acme.com', updated_at: 100 },
  )
  assert.deepEqual(
    matchSavedCredentialProfile(profiles, 'any-enterprise', 'solo@example.com'),
    { enterprise: '', account: 'solo@example.com', updated_at: 400 },
  )
  assert.deepEqual(
    parseSavedLoginCredentials('{"enterprise":" acme ","account":" alice@acme.com ","password":"Secret!"}'),
    { enterprise: 'acme', account: 'alice@acme.com', password: 'Secret!' },
  )
})
