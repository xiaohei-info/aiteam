import assert from 'node:assert/strict'
import test from 'node:test'
import { alreadyInstalledText, isAlreadyInstalledError, partitionInstallResults } from '../src/lib/alreadyInstalled.ts'

/**
 * 「已经装好了」不是失败，是状态。
 * 服务端 409（skill_exists / mcp_exists）要展示成中性提示；其它 409（如文件冲突）仍按错误处理。
 */

test('同名已装的 409 被识别为状态，不是错误', () => {
  const error = { status: 409, code: 'skill_exists', message: '「weekly-report」已经装好了（a1e01e86 版），现在就能用。' }
  assert.equal(isAlreadyInstalledError(error), true)
  assert.equal(alreadyInstalledText(error), '「weekly-report」已经装好了（a1e01e86 版），现在就能用。')

  const mcp = { status: 409, code: 'mcp_exists', message: '「notion」已经装好了，无需重复添加；需要换成这次填的配置才点替换。' }
  assert.equal(isAlreadyInstalledError(mcp), true)
  assert.equal(alreadyInstalledText(mcp), '「notion」已经装好了，无需重复添加；需要换成这次填的配置才点替换。')
})

test('其它 409 / 非 409 错误不当作「已安装」', () => {
  assert.equal(isAlreadyInstalledError({ status: 409, code: 'conflict', message: '源文件在检索后发生了变化' }), false)
  assert.equal(isAlreadyInstalledError({ status: 422, code: 'skill_exists', message: '已安装' }), false)
  assert.equal(isAlreadyInstalledError(new Error('已安装自定义技能「x」版')), false)
  assert.equal(alreadyInstalledText({ status: 409, code: 'conflict', message: '别的冲突' }), null)
})

test('缺 message 时给出兜底文案，不显示空白', () => {
  const bare = { status: 409, code: 'mcp_exists', message: '   ' }
  assert.equal(alreadyInstalledText(bare), '这个能力已经装好了，无需重复添加。')
})

test('批量结果：已装的不计入失败', () => {
  const { installed, already, failed } = partitionInstallResults([
    { root: '01-weekly-report', name: 'weekly-report', ok: true },
    { root: '02-ppt-outline', name: '', ok: false, reason: '「ppt-outline」已经装好了（1c7e 版），无需重复安装。' },
    { root: '03-broken', name: '', ok: false, reason: 'name 只能用小写字母、数字和连字符。' },
  ])
  assert.deepEqual(installed.map((item) => item.root), ['01-weekly-report'])
  assert.deepEqual(already.map((item) => item.root), ['02-ppt-outline'])
  assert.deepEqual(failed.map((item) => item.root), ['03-broken'])
})

test('批量结果：没有已装项时 failed 仍是全部失败项', () => {
  const { installed, already, failed } = partitionInstallResults([
    { root: 'a', name: '', ok: false, reason: '加载失败' },
  ])
  assert.deepEqual(installed, [])
  assert.deepEqual(already, [])
  assert.deepEqual(failed.map((item) => item.root), ['a'])
})
