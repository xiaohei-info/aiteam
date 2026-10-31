import assert from 'node:assert/strict'
import test from 'node:test'
import { splitLocalContext } from '../src/lib/localContextBlock.ts'
import { entriesToMessages } from '../src/lib/piConverters.ts'
import { getHistoryEntryText } from '../src/lib/conversationHistorySearch.ts'
import type { ConversationEntry } from '../src/api/agent/types.ts'

// Same shape the FredServer gateway (services/gateway-local-context.ts) appends to a single-chat prompt.
const block = (action: string) => `<aiteam-local-context v="1" action="${action}">\n以下内容由用户电脑上的本机 Agent 检索得到……\n[1] 资料/readme.txt\n采样率 48k\n</aiteam-local-context>`

test('gateway local-context block is split off the trailing end of a user prompt', () => {
  assert.deepEqual(splitLocalContext(`CYCPLUS_Mix 的采样率？\n\n${block('search')}`), { text: 'CYCPLUS_Mix 的采样率？', localContext: 'search' })
  assert.deepEqual(splitLocalContext(`目录下有什么\n\n${block('list')}\n`), { text: '目录下有什么', localContext: 'list' })
  for (const text of [
    '普通消息',
    `${block('search')} 后面还有用户文字`,
    `前缀\n\n${block('delete')}`,
    '用户自己写了 </aiteam-local-context>',
  ]) assert.deepEqual(splitLocalContext(text), { text }, text)
})

test('history shows only what the user typed, marks the message and keeps the block out of search', () => {
  const entry = (role: 'user' | 'assistant', text: string): ConversationEntry => ({
    id: `${role}-1`, type: 'message', message: { role, content: [{ type: 'text', text }] as never },
  })
  const user = entry('user', `采样率是多少\n\n${block('search')}`)
  const [message] = entriesToMessages([user])
  assert.equal(message!.content, '采样率是多少')
  assert.equal(message!.localContext, 'search')
  assert.equal(getHistoryEntryText(user), '采样率是多少')
  // Only user prompts carry the gateway block; assistant text is never rewritten.
  const reply = entry('assistant', `引用如下\n\n${block('search')}`)
  assert.equal(entriesToMessages([reply])[0]!.content, `引用如下\n\n${block('search')}`)
  assert.equal(entriesToMessages([reply])[0]!.localContext, undefined)
})
