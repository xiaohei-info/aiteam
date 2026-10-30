import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Exercise the component's effects without a browser or extra test dependencies.
function createStatusHarness() {
  const slots: any[] = []
  let cursor = 0
  let effects: (() => void)[] = []
  let context: any = { used_tokens: 12000, context_window: 100000, percentage: 12 }
  let usage: any = { tokens: 34000, outcome: 'succeeded' }
  let fail = false
  let requests = 0
  const deferred: (() => void)[] = []
  const react = {
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(callback: () => any, deps: any[]) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
        effects.push(() => {
          previous?.cleanup?.()
          slots[index] = { deps, cleanup: callback() }
        })
      }
    },
  }
  const request = (value: any) => new Promise((resolve, reject) => {
    requests += 1
    deferred.push(() => fail ? reject(new Error('offline')) : resolve(value))
  })
  const exports: any = {}
  const source = readFileSync(new URL('../src/components/Chat/ConversationStatus.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  runInNewContext(compiled, {
    exports, AbortController,
    window: { setInterval: () => 1, clearInterval: () => {} },
    require(name: string) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) }
      if (name.endsWith('/agent')) return { agentApi: { getConversationContext: () => request(context) } }
      if (name.endsWith('/conversationUsage')) return { readConversationUsage: () => request(usage) }
      return {}
    },
  })
  return {
    render(generating = false, conversationId = 'conv_1', unavailable = false) {
      cursor = 0
      const tree = exports.ConversationStatus({ conversationId, generating, unavailable })
      const pending = effects; effects = []
      pending.forEach(effect => effect())
      return JSON.stringify(tree)
    },
    async resolve() { deferred.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve)) },
    update(nextContext: any, nextUsage: any) { context = nextContext; usage = nextUsage },
    fail() { fail = true },
    requests: () => requests,
  }
}

function assertPreviousTotals(tree: string) {
  assert.match(tree, /12\.0K\/100\.0K/)
  assert.match(tree, /34K tokens/)
}

test('sending and completion preserve totals until fresh values arrive', async () => {
  const harness = createStatusHarness()
  harness.render()
  await harness.resolve()
  assertPreviousTotals(harness.render())
  harness.update({ used_tokens: 15000, context_window: 100000, percentage: 15 }, { tokens: 39000, outcome: 'succeeded' })
  for (const generating of [true, false]) {
    assertPreviousTotals(harness.render(generating))
    assertPreviousTotals(harness.render(generating))
  }
  await harness.resolve()
  const refreshed = harness.render()
  assert.match(refreshed, /15\.0K\/100\.0K/)
  assert.match(refreshed, /39K tokens/)
})

test('employees that can no longer chat skip context and usage reads and hide the status bar', async () => {
  const harness = createStatusHarness()
  assert.equal(harness.render(false, 'conv_1', true), 'null')
  harness.render(true, 'conv_1', true)
  await harness.resolve()
  assert.equal(harness.requests(), 0)
})

test('refresh failures keep the previous totals and expose an error', async () => {
  const harness = createStatusHarness()
  harness.render(); await harness.resolve()
  harness.fail()
  harness.render(true); await harness.resolve()
  const tree = harness.render(true)
  assertPreviousTotals(tree)
  assert.match(tree, /消耗读取失败/)
})

test('missing usage after completion retains known tokens; switching conversations resets them', async () => {
  const harness = createStatusHarness()
  harness.render(); await harness.resolve()
  harness.update({ used_tokens: 12000, context_window: 100000, percentage: 12 }, { tokens: null, outcome: 'succeeded' })
  harness.render(true); await harness.resolve()
  harness.render(false); await harness.resolve()
  assertPreviousTotals(harness.render())
  harness.render(false, 'conv_2')
  const tree = harness.render(false, 'conv_2')
  assert.doesNotMatch(tree, /34K tokens|12\.0K\/100\.0K/)
})
