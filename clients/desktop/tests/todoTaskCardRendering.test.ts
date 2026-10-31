import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as todoHelpers from '../src/lib/todoTaskCard.ts'
import * as localCitationHelpers from '../src/lib/localDirectoryCitations.ts'
import type { ThinkingStep, ToolCall } from '../src/stores/chat.ts'

const nodeRequire = createRequire(import.meta.url)

// Render the actual row/process/card components; model the process toggle's state
// explicitly so the same click handler can be checked without a browser runtime.
function renderer() {
  let open = false
  let toggle: (() => void) | undefined
  let cardKeys: unknown[] = []
  const cache = new Map<string, any>()
  const runtime = nodeRequire('react/jsx-runtime')
  const jsx = (factory: any) => (type: any, props: any, key: unknown) => {
    if (type === 'button' && props.className === 'chat-thinking-toggle') toggle = props.onClick
    if (type === cache.get('TodoTaskCard')?.default && props.variant !== 'history') cardKeys.push(key)
    return factory(type, props, key)
  }
  function load(file: string): any {
    if (cache.has(file)) return cache.get(file)
    const source = readFileSync(new URL(`../src/components/Chat/${file}.tsx`, import.meta.url), 'utf8')
    const exports = {}
    const require = (id: string): any => {
      if (id === 'react') return { ...React, useState: () => [open, (value: boolean) => { open = value }] }
      if (id === 'react/jsx-runtime') return { ...runtime, jsx: jsx(runtime.jsx), jsxs: jsx(runtime.jsxs) }
      if (id === '../../lib/todoTaskCard') return todoHelpers
      if (id === '../../lib/localDirectoryCitations') return localCitationHelpers
      if (id === '../../lib/avatarUtils') return { getEmployeeAvatar: () => '', renderAvatar: () => null }
      if (id === './TextMessage') return { __esModule: true, default: ({ above, content }: any) => React.createElement('div', null, above, content) }
      // 本地目录引用卡片不是本套用例的对象；与 FileMessage 同样 stub 为空渲染。
      if (id === './LocalCitationCard') return { __esModule: true, default: () => null }
      if (id === './FileMessage' || id.endsWith('.css')) return { __esModule: true, default: () => null }
      if (id === 'react-markdown') return { __esModule: true, default: ({ children }: any) => React.createElement('p', null, children) }
      if (id === 'remark-gfm') return { __esModule: true, default: () => {} }
      if (id.startsWith('./')) return load(id.slice(2))
      return nodeRequire(id)
    }
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    vm.runInNewContext(`(function(require, exports) { ${code}\n})`)(require, exports)
    cache.set(file, exports)
    return exports
  }
  const { MessageRow } = load('MessageRow')
  return {
    render(calls: ToolCall[], streaming: boolean, steps?: ThinkingStep[]) {
      cardKeys = []
      return renderToStaticMarkup(React.createElement(MessageRow, {
        conversationId: 'c', userAvatar: '', displayContent: '', isThisStreaming: streaming, isThinkingPhase: streaming,
        msg: { id: 'reply', role: 'assistant', content: '', toolCalls: calls, thinkingSteps: steps },
      }))
    },
    click() { assert.ok(toggle); toggle() },
    keys: () => cardKeys,
  }
}

const initial: ToolCall = {
  id: 'initial', name: 'todo_update', input: { items: [{ id: 'draft', title: '整理报告', status: 'in_progress' }] },
}
const complete: ToolCall = {
  id: 'complete', name: 'todo_update', resultValue: { items: [{ id: 'draft', title: '整理报告', status: 'completed' }] },
}

test('streaming and settled rows show one current card with a stable key and collapsed process', () => {
  const view = renderer()
  const initialHtml = view.render([initial], true)
  assert.match(initialHtml, /进行中/)
  assert.deepEqual(view.keys(), ['reply'])
  for (const streaming of [true, false]) {
    const html = view.render([initial, complete], streaming)
    assert.equal((html.match(/aria-label="AI 员工任务清单"/g) ?? []).length, 1)
    assert.match(html, /全部完成/)
    assert.match(html, /aria-expanded="false"/)
    assert.match(html, /执行过程/)
    assert.doesNotMatch(html, /任务清单更新|进行中|chat-thinking-body/)
    assert.deepEqual(view.keys(), ['reply'])
  }
})

test('expanding the process exposes ordered snapshots and collapsing keeps only current state', () => {
  const view = renderer()
  const calls = [initial, complete]
  const steps: ThinkingStep[] = [
    { kind: 'tool', tool: initial }, { kind: 'reasoning', text: '完成报告后更新清单' }, { kind: 'tool', tool: complete },
  ]
  view.render(calls, true, steps)
  view.click()
  const expanded = view.render(calls, true, steps)
  assert.match(expanded, /aria-expanded="true"/)
  assert.equal((expanded.match(/aria-label="任务清单更新"/g) ?? []).length, 2)
  assert.equal((expanded.match(/aria-label="AI 员工任务清单"/g) ?? []).length, 1)
  assert.equal((expanded.match(/aria-live="polite"/g) ?? []).length, 1)
  assert(expanded.indexOf('未完成') < expanded.indexOf('完成报告后更新清单'))
  assert(expanded.indexOf('完成报告后更新清单') < expanded.indexOf('全部完成'))
  view.click()
  assert.doesNotMatch(view.render(calls, false, steps), /任务清单更新|未完成|进行中/)
})

test('failed updates stay visible as errors in the expanded process without replacing the card', () => {
  const view = renderer()
  const failed: ToolCall = { ...complete, isError: true, result: 'update failed' }
  assert.doesNotMatch(view.render([initial, failed], false), /全部完成/)
  view.click()
  const html = view.render([initial, failed], false)
  assert.match(html, /错误/)
  assert.match(html, /update failed/)
  assert.match(html, /未完成/)
})

test('each progress state renders a distinct icon and label and settled runs stop the spinner', () => {
  const view = renderer()
  const mixed: ToolCall = {
    id: 'mixed',
    name: 'todo_update',
    resultValue: {
      items: [
        { id: 'a', title: '整理素材', status: 'pending' },
        { id: 'b', title: '撰写正文', status: 'in_progress' },
        { id: 'c', title: '校对终稿', status: 'completed' },
      ],
    },
  }

  const live = view.render([mixed], true)
  assert.match(live, /待处理/)
  assert.match(live, /进行中/)
  assert.match(live, /已完成/)
  assert.match(live, /ttc-status-spinner/)
  assert.doesNotMatch(live, /未完成/)
  assert.match(live, /class="ttc-item in_progress"/)

  const settled = view.render([mixed], false)
  assert.doesNotMatch(settled, /进行中/)
  assert.doesNotMatch(settled, /ttc-status-spinner/)
  assert.match(settled, /未完成/)
  assert.match(settled, /1\/3 已完成 · 1 项未完成/)
  assert.match(settled, /class="ttc-item pending"/)
  assert.match(settled, /class="ttc-item unfinished"/)
  assert.match(settled, /class="ttc-item completed"/)
})

test('expanded history snapshots show unfinished instead of a spinning in-progress item', () => {
  const view = renderer()
  const steps: ThinkingStep[] = [{ kind: 'tool', tool: initial }]
  view.render([initial], true, steps)
  view.click()
  const html = view.render([initial], true, steps)
  assert.match(html, /aria-expanded="true"/)
  // 当前卡片仍在输出 → 进行中；展开的历史快照 → 终止态未完成。
  assert.match(html, /进行中/)
  assert.match(html, /未完成/)
})
