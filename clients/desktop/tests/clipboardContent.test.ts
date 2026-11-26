import test from 'node:test'
import assert from 'node:assert/strict'
import { composePaste, placeholderFor, type PastePart } from '../src/components/Chat/clipboardContent.ts'

const png = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
const pdf = (name: string) => new File([new Uint8Array([4])], name, { type: 'application/pdf' })

test('纯文字原样插入，不产生附件', () => {
  assert.deepEqual(composePaste({ plain: '你好', parts: [], files: [] }), { text: '你好', files: [], unavailable: 0 })
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
  assert.equal(result.unavailable, 0)
})

test('HTML 里自带图片字节（data URL）时用自带的', () => {
  const own = png('图1.png')
  const parts: PastePart[] = [{ kind: 'text', text: '看 ' }, { kind: 'image', name: '图1.png', file: own }]
  const result = composePaste({ plain: '看', parts, files: [] })
  assert.equal(result.text, '看 [图片：图1.png]')
  assert.equal(result.files[0], own)
})

test('网页图文：图片只有网址时只贴文字，不下载、不留占位，只计数', () => {
  const parts: PastePart[] = [
    { kind: 'text', text: '远程 ' },
    { kind: 'image', name: 'logo.png', src: 'https://example.com/logo.png' },
    { kind: 'text', text: ' 结尾' },
  ]
  const result = composePaste({ plain: '远程 结尾', parts, files: [] })
  assert.equal(result.text, '远程 结尾')
  assert.equal(result.files.length, 0)
  assert.equal(result.unavailable, 1)
})

test('复制表格：文字加一张截图、富文本里没有图片时只贴文字', () => {
  const result = composePaste({ plain: '姓名\t部门\n张三\t研发', parts: [], files: [png('image.png')] })
  assert.equal(result.text, '姓名\t部门\n张三\t研发')
  assert.equal(result.files.length, 0)
  assert.equal(result.unavailable, 0)
})

test('占位文字区分图片与文件', () => {
  assert.equal(placeholderFor('a.png', 'image/png'), '[图片：a.png]')
  assert.equal(placeholderFor('a.pdf', 'application/pdf'), '[文件：a.pdf]')
})

test('飞书输入框复制：图片只有 native-resource 内部引用，不留占位，只计数', () => {
  const parts: PastePart[] = [
    { kind: 'image', name: 'image.png', src: 'native-resource://sdk/image?resource_type=image&key=img_t0_x' },
    { kind: 'text', text: '\n打工皇帝发had\n' },
  ]
  const result = composePaste({ plain: '\n打工皇帝发had', parts, files: [] })
  assert.equal(result.text, '打工皇帝发had')
  assert.equal(result.files.length, 0)
  assert.equal(result.unavailable, 1)
})

test('WPS 图文：HTML 图片指向沙盒临时文件，补上 RTF 里读出的图片后按原位置占位', () => {
  const parts: PastePart[] = [
    { kind: 'text', text: '第一段文字\n' },
    { kind: 'image', name: 'wps2.jpg', src: 'file:////Users/x/Library/Containers/com.kingsoft.wpsoffice.mac/Data/tmp/wps2.jpg' },
    { kind: 'text', text: '\n第二段文字' },
  ]
  const before = composePaste({ plain: '第一段文字\n\n第二段文字', parts, files: [] })
  assert.equal(before.unavailable, 1)
  const after = composePaste({ plain: '第一段文字\n\n第二段文字', parts, files: [png('图片1.png')] })
  assert.equal(after.unavailable, 0)
  assert.equal(after.text, '第一段文字\n[图片：图片1.png]\n第二段文字')
  assert.deepEqual(after.files.map((f) => f.name), ['图片1.png'])
})
