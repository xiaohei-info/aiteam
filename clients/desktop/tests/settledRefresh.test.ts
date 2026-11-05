import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshWhenRunsSettle } from '../src/lib/settledRefresh.ts'

function harness(overrides: { isPrompting?: () => Promise<boolean>; reload?: () => Promise<unknown>; maxPolls?: number } = {}) {
  let emit: (event: { type?: string }) => void = () => {}
  const seen = { reloads: 0, unsubscribed: 0 }
  const close = refreshWhenRunsSettle({
    subscribe: (onEvent) => { emit = onEvent; return () => { seen.unsubscribed += 1 } },
    isPrompting: overrides.isPrompting ?? (async () => false),
    reload: overrides.reload ?? (async () => { seen.reloads += 1 }),
    pollMs: 1,
    maxPolls: overrides.maxPolls,
  })
  return { emit: (type: string) => emit({ type }), seen, close }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 20))

test('only a settled run reloads, after the Agent has finished copying its files', async () => {
  const states = [true, true, false]
  const polled: boolean[] = []
  const run = harness({ isPrompting: async () => { const state = states.shift() ?? false; polled.push(state); return state } })
  run.emit('agent_end')
  run.emit('tool_execution_end')
  await flush()
  assert.equal(run.seen.reloads, 0)
  run.emit('agent_settled')
  await flush()
  assert.deepEqual(polled, [true, true, false])
  assert.equal(run.seen.reloads, 1)
})

test('a run settling during a reload is picked up by one more reload', async () => {
  let release = () => {}
  let reloads = 0
  const run = harness({ reload: () => { reloads += 1; return new Promise<void>(resolve => { release = resolve }) } })
  run.emit('agent_settled')
  await flush()
  run.emit('agent_settled')
  run.emit('agent_settled')
  assert.equal(reloads, 1, 'no overlapping reloads')
  release()
  await flush()
  assert.equal(reloads, 2, 'later settles collapse into one')
  release()
  await flush()
  assert.equal(reloads, 2)
})

test('a run that stays busy still reloads once the polls run out', async () => {
  let polls = 0
  const run = harness({ isPrompting: async () => { polls += 1; return true }, maxPolls: 3 })
  run.emit('agent_settled')
  await flush()
  assert.equal(polls, 3)
  assert.equal(run.seen.reloads, 1)
})

test('closing stops polling and reloading; a failure leaves later settles working', async () => {
  const closing = harness({ isPrompting: async () => true })
  closing.emit('agent_settled')
  closing.close()
  await flush()
  assert.equal(closing.seen.reloads, 0)
  assert.equal(closing.seen.unsubscribed, 1)

  let fail = true
  let reloads = 0
  const flaky = harness({ reload: async () => { reloads += 1; if (fail) throw new Error('offline') } })
  flaky.emit('agent_settled')
  await flush()
  fail = false
  flaky.emit('agent_settled')
  await flush()
  assert.equal(reloads, 2)
})
