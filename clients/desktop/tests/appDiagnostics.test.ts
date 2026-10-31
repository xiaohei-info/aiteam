import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createSafeDiagnostic, formatSafeDiagnostic, resolveSafeView } from '../src/lib/appDiagnostics.ts'
import { classifyBackendStartupFailure } from '../src/lib/backendStartup.ts'

test('safe diagnostics never include exception messages, credentials, query strings, or stack traces', () => {
  const secret = 'token=secret-token password=secret-password'
  const diagnostic = createSafeDiagnostic({
    code: 'UI_RENDER_FAILURE',
    stage: 'react-render',
    category: 'render',
    pathname: `/chat/private-conversation?${secret}`,
    now: new Date('2026-09-07T08:00:00.000Z'),
    errorId: 'AT-TEST-SAFE0001',
  })
  const output = formatSafeDiagnostic(diagnostic)

  assert.equal(diagnostic.view, 'chat')
  assert.match(output, /error_id=AT-TEST-SAFE0001/)
  assert.doesNotMatch(output, /secret|password|private-conversation|stack/i)
})

test('only known top-level routes are exposed as diagnostic views', () => {
  assert.equal(resolveSafeView('/group-chat/private-id'), 'group-chat')
  assert.equal(resolveSafeView('/customer-secret/private-id'), 'unknown')
  assert.equal(resolveSafeView('/'), 'root')
})

test('the global boundary is wired above the router without exposing raw React errors', () => {
  const boundarySource = readFileSync(
    new URL('../src/components/AppRecovery/GlobalErrorBoundary.tsx', import.meta.url),
    'utf8',
  )
  const entrySource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

  assert.match(boundarySource, /getDerivedStateFromError/)
  assert.match(boundarySource, /createRenderDiagnostic/)
  assert.doesNotMatch(boundarySource, /(error|info)\.(message|stack)|componentStack|console\./)
  assert.ok(entrySource.indexOf('<GlobalErrorBoundary>') < entrySource.indexOf('<BrowserRouter'))
})

test('backend startup diagnostics distinguish network, configuration, and readiness failures', () => {
  const network = classifyBackendStartupFailure(new TypeError('Failed to fetch bearer secret'), 'health')
  const configuration = classifyBackendStartupFailure({
    status: 0,
    code: 'client_insecure_api_url',
    message: 'http://user:password@example.com',
  }, 'health')
  const readiness = classifyBackendStartupFailure({ status: 503, message: 'database path secret' }, 'readiness')

  assert.equal(network.category, 'network')
  assert.equal(network.diagnosticCode, 'BACKEND_NETWORK_TIMEOUT')
  assert.equal(configuration.category, 'configuration')
  assert.equal(configuration.diagnosticCode, 'BACKEND_CONFIGURATION_ERROR')
  assert.equal(readiness.category, 'service')
  assert.equal(readiness.diagnosticCode, 'BACKEND_READY_TIMEOUT')

  const publicCopy = JSON.stringify([network, configuration, readiness])
  assert.doesNotMatch(publicCopy, /bearer secret|password@example|database path secret/i)
})
