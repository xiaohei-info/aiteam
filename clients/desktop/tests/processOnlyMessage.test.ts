import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const nodeRequire = createRequire(import.meta.url)
function component(file: string): any {
  const source = readFileSync(new URL(`../src/components/Chat/${file}.tsx`, import.meta.url), 'utf8')
  const exports: Record<string, any> = {}
  const require = (id: string): any => {
    if (id === 'react' || id === 'react/jsx-runtime') return nodeRequire(id)
    if (id === './MessageBubble') return { __esModule: true, default: component('MessageBubble') }
    if (id === 'react-markdown') return { __esModule: true, default: ({ children }: any) => React.createElement('p', null, children) }
    return { __esModule: true, default: () => null }
  }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(`(function(require, exports) { ${code}\n})`)(require, exports)
  return exports.default
}

test('process-only messages render their process without an empty reply bubble', () => {
  const TextMessage = component('TextMessage')
  const html = renderToStaticMarkup(React.createElement(TextMessage, {
    conversationId: 'c', side: 'left', content: '', above: React.createElement('div', null, '任务清单'),
  }))
  assert.match(html, /任务清单/)
  assert.doesNotMatch(html, /无回复内容|mb-bubble/)
  const empty = renderToStaticMarkup(React.createElement(TextMessage, { conversationId: 'c', side: 'left', content: '' }))
  assert.match(empty, /无回复内容/)
  const reply = renderToStaticMarkup(React.createElement(TextMessage, {
    conversationId: 'c', side: 'left', content: 'JD', above: React.createElement('div', null, '任务清单'),
  }))
  assert.match(reply, /mb-bubble/)
  assert.match(reply, /JD/)
})

test('thinking phase keeps the reply bubble so 思考中 stays visible under the process block', () => {
  const TextMessage = component('TextMessage')
  const thinking = renderToStaticMarkup(React.createElement(TextMessage, {
    conversationId: 'c', side: 'left', content: '', isStreaming: true,
    above: React.createElement('div', null, '推理过程'),
  }))
  assert.match(thinking, /推理过程/)
  assert.match(thinking, /mb-bubble/)
  assert.match(thinking, /思考中/)

  const answered = renderToStaticMarkup(React.createElement(TextMessage, {
    conversationId: 'c', side: 'left', content: '已经写好正文', isStreaming: true,
    above: React.createElement('div', null, '推理过程'),
  }))
  assert.match(answered, /已经写好正文/)
  assert.doesNotMatch(answered, /思考中/)
})
