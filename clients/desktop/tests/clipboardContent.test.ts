import test from 'node:test'
import assert from 'node:assert/strict'
import { composePaste, placeholderFor, type PastePart } from '../src/components/Chat/clipboardContent.ts'

const png = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
const pdf = (name: string) => new File([new Uint8Array([4])], name, { type: 'application/pdf' })

test('纯文字原样插入，不产生附件', () => {
  assert.deepEqual(composePaste({ plain: '你好', parts: [], files: [] }), { text: '你好', files: [], pending: [] })
})

test('只有截图时只作附件，不插占位文字', () => {
  const result = composePaste({ plain: '', parts: [], files: [png('image.png')] })
  assert.equal(result.text, '')
  assert.deepEqual(result.files.map((f) => f.name), ['image.png'])
})

test('访达复制文件时剪贴板里的文件名文字不算用户内容', () => {
  const result = composePaste({ plain: 'a.pdf\nb.png', parts: [], files: [pdf('a.pdf'), png('b.png')] })
  assert.equal(result.text, '')
  assert.deepEqual(result.files.map((f) => f.name), ['a.pdf', 'b.png'])
})

test('图文混排：多图按原位置留图片名占位，文字和图片一起进来', () => {
  const parts: PastePart[] = [
    { kind: 'text', text: '第一张 ' },
    { kind: 'image', name: 'image.png' },
    { kind: 'text', text: ' 第二张 ' },
    { kind: 'image', name: 'image.png' },
    { kind: 'text', text: ' 完' },
  ]
  const result = composePaste({ plain: '第一张 第二张 完', parts, files: [png('image.png'), png('image.png')] })
  assert.equal(result.text, '第一张 [图片：image.png] 第二张 [图片：image-2.png] 完')
  assert.deepEqual(result.files.map((f) => f.name), ['image.png', 'image-2.png'])
  assert.deepEqual(result.pending, [])
})

test('HTML 里自带图片字节（data URL）时用自带的', () => {
  const own = png('图1.png')
  const parts: PastePart[] = [{ kind: 'text', text: '看 ' }, { kind: 'image', name: '图1.png', file: own }]
  const result = composePaste({ plain: '看', parts, files: [] })
  assert.equal(result.text, '看 [图片：图1.png]')
  assert.equal(result.files[0], own)
})

test('只有地址的图片先留占位，交给调用方去取', () => {
  const parts: PastePart[] = [{ kind: 'text', text: '远程 ' }, { kind: 'image', name: 'logo.png', src: 'https://example.com/logo.png' }]
  const result = composePaste({ plain: '远程', parts, files: [] })
  assert.equal(result.text, '远程 [图片：logo.png]')
  assert.equal(result.files.length, 0)
  assert.deepEqual(result.pending, [{ name: 'logo.png', src: 'https://example.com/logo.png' }])
})

test('文字 + 不知道位置的文件：文件占位排在文字后面', () => {
  const result = composePaste({ plain: '请看附件', parts: [], files: [pdf('报告.pdf'), png('image.png')] })
  assert.equal(result.text, '请看附件\n[文件：报告.pdf]\n[图片：image.png]')
  assert.deepEqual(result.files.map((f) => f.name), ['报告.pdf', 'image.png'])
})

test('占位文字区分图片与文件', () => {
  assert.equal(placeholderFor('a.png', 'image/png'), '[图片：a.png]')
  assert.equal(placeholderFor('a.pdf', 'application/pdf'), '[文件：a.pdf]')
})
