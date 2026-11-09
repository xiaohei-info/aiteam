import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

test('opening or revealing a reply file reuses one local copy keyed by the file id', () => {
  const artifactOpen = source('lib/artifactOpen.ts')
  assert.match(artifactOpen, /invoke<CachedFile>\('cache_conversation_file', \{[\s\S]*?cacheKey: `artifact:\$\{file\.id\}`,[\s\S]*?\}\)/)
})

test('the conversation files panel passes the same kind:id key to the host cache', () => {
  const panel = source('components/Chat/ConversationFiles.tsx')
  assert.match(panel, /const key = `\$\{file\.kind\}:\$\{file\.id\}`/)
  assert.match(panel, /invoke<CachedFile>\('cache_conversation_file', \{[\s\S]*?cacheKey: key,[\s\S]*?\}\)/)
})
