import assert from 'node:assert/strict'
import test from 'node:test'
import { fileAccessErrorKind, withFileAccessRecovery } from '../src/lib/fileAccessPolicy.ts'

test('distinguishes application grants, OS denial and unrelated preview errors', () => {
  assert.equal(fileAccessErrorKind('LOCAL_ACCESS_REQUIRED: /Users/demo'), 'authorization')
  assert.equal(fileAccessErrorKind(new Error('目录访问权限已失效')), 'authorization')
  assert.equal(fileAccessErrorKind('LOCAL_OS_PERMISSION_DENIED: C:\\Docs'), 'system')
  assert.equal(fileAccessErrorKind('PowerPoint 文件暂不支持本地正文预览'), null)
  assert.equal(fileAccessErrorKind('No such file or directory'), null)
})

test('successful reads and non-permission errors never prompt', async () => {
  let prompts = 0
  const recover = async () => { prompts++; return true }
  assert.equal(await withFileAccessRecovery(async () => 'content', recover), 'content')
  await assert.rejects(withFileAccessRecovery(async () => { throw new Error('file missing') }, recover), /file missing/)
  assert.equal(prompts, 0)
})

test('explicit authorization retries the read once', async () => {
  let reads = 0
  let prompts = 0
  const content = await withFileAccessRecovery(async () => {
    reads++
    if (reads === 1) throw new Error('LOCAL_ACCESS_REQUIRED')
    return 'content'
  }, async () => { prompts++; return true })
  assert.equal(content, 'content')
  assert.equal(reads, 2)
  assert.equal(prompts, 1)
})

test('cancel preserves the original failure and does not retry', async () => {
  let reads = 0
  const original = new Error('LOCAL_ACCESS_REQUIRED')
  await assert.rejects(withFileAccessRecovery(async () => { reads++; throw original }, async () => false), error => error === original)
  assert.equal(reads, 1)
})

test('persistent OS restrictions do not create an infinite prompt/retry loop', async () => {
  let reads = 0
  let prompts = 0
  await assert.rejects(withFileAccessRecovery(async () => {
    reads++
    throw new Error('LOCAL_OS_PERMISSION_DENIED')
  }, async () => { prompts++; return true }), /LOCAL_OS_PERMISSION_DENIED/)
  assert.equal(reads, 2)
  assert.equal(prompts, 1)
})
