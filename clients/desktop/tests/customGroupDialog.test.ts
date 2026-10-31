import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as helpers from '../src/lib/customGroupForm.ts'
import * as filters from '../src/lib/groupMemberFilters.ts'

const requireNode = createRequire(import.meta.url)

// Exercise the real component handlers with controlled hooks; no browser/native APIs.
async function dialog(options: { supported?: boolean; create?: (value: any) => Promise<void> } = {}) {
  const slots: any[] = []
  const effects: (() => unknown)[] = []
  let cursor = 0
  let mounted = false
  let elements: { type: any; props: any }[] = []
  const runtime = requireNode('react/jsx-runtime')
  const wrap = (factory: any) => (type: any, props: any, key: any) => {
    elements.push({ type, props })
    return factory(type, props, key)
  }
  const react = {
    ...React,
    useState: (initial: any) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef: (initial: any) => { const index = cursor++; return slots[index] ??= { current: initial } },
    useMemo: (factory: any) => factory(), useCallback: (callback: any) => callback,
    useEffect: (effect: any) => { if (!mounted) effects.push(effect) },
  }
  const require = (id: string): any => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return { ...runtime, jsx: wrap(runtime.jsx), jsxs: wrap(runtime.jsxs) }
    if (id === 'react-dom') return { createPortal: (node: any) => node }
    if (id === '../../api/agent') return { agentApi: {
      supportsCustomGroups: async () => options.supported ?? true,
      listExperts: async () => ({ experts: ['协调员', '技术专家'].map((name, i) => ({ employee_id: `e${i}`, display_name: name, role_title: name, persona: `${name}简介` })) }),
    } }
    if (id === '../../api/backend') return { backendApi: { getOrgTree: async () => ({ id: 'root', name: '公司', type: 'department', children: [] }) } }
    if (id === '../../hooks/useDialogFocus') return { useDialogFocus: () => ({ current: null }) }
    if (id === '../../hooks/useGlobalShortcut') return { useGlobalShortcutClose: () => {} }
    if (id === '../../lib/groupMemberFilters') return filters
    if (id === '../../lib/customGroupForm') return helpers
    if (id.endsWith('.css')) return {}
    return requireNode(id)
  }
  const source = readFileSync(new URL('../src/components/Chat/CreateGroupDialog.tsx', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports: any = {}
  vm.runInNewContext(`(function(require, exports) { ${code}\n})`, { document: { body: {} }, crypto: { randomUUID: () => 'stable-intent' }, requestAnimationFrame: () => {} })(require, exports)
  const render = () => {
    cursor = 0
    elements = []
    const html = renderToStaticMarkup(React.createElement(exports.default, { onClose() {}, onCreate: options.create ?? (async () => {}) }))
    mounted = true
    return html
  }
  render()
  for (const effect of effects) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  render()
  const find = (predicate: (node: any) => boolean) => { const node = elements.find(predicate); assert.ok(node); return node.props }
  return {
    render,
    change(id: string, value: string) { find(node => node.props.id === id).onChange({ target: { value, selectionStart: value.length } }); return render() },
    click(label: string) { find(node => node.type === 'button' && (node.props['aria-label'] === label || node.props.children === label)).onClick(); return render() },
    submit: () => find(node => node.type === 'button' && node.props.className === 'cad-btn-submit'),
  }
}

test('three-section auto form selects arbitrary members, sets coordinator and prevents duplicate submits', async () => {
  const submissions: any[] = []
  let release!: () => void
  const view = await dialog({ create: async value => { submissions.push(value); await new Promise<void>(resolve => { release = resolve }) } })
  assert.match(view.render(), /请详细描述群的用途/)
  assert.doesNotMatch(view.render(), /确认创建|联动模块|授权协作方案/)
  view.change('cgd-name', '课程群')
  view.change('cgd-description', '课程销售协作')
  view.click('选择 协调员')
  view.click('选择 技术专家')
  assert.equal(view.submit().disabled, false)
  const submit = view.submit().onClick
  submit(); submit()
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].id, 'stable-intent')
  assert.deepEqual(Array.from(submissions[0].member_employee_ids), ['e0', 'e1'])
  assert.equal(submissions[0].coordinator_employee_id, 'e0')
  assert.equal(submissions[0].orchestration.mode, 'auto')
  release()
})

test('custom mode preserves drafts and blocks removed references and missing coordinator', async () => {
  const submissions: any[] = []
  const view = await dialog({ create: async value => { submissions.push(value) } })
  view.change('cgd-name', '自定义群')
  view.click('选择 协调员')
  view.click('选择 技术专家')
  view.click('自定义')
  view.change('cgd-prompt', '1. @【协调员】 → @【技术专家】：完成报告。')
  assert.equal(view.submit().disabled, false, 'custom description is optional')
  view.click('自动')
  assert.equal(view.submit().disabled, true, 'auto requires description')
  view.click('自定义')
  assert.match(view.render(), /完成报告/)
  view.click('移除 技术专家')
  assert.equal(view.submit().disabled, true)
  assert.match(view.render(), /已移除或无效/)
  view.click('选择 技术专家')
  view.click('移除 协调员')
  assert.equal(view.submit().disabled, true)
  view.click('选择 协调员')
  view.change('cgd-coordinator', 'e1')
  view.submit().onClick()
  assert.equal(submissions[0].orchestration.prompt, '1. @{e0} → @{e1}：完成报告。')
})

test('unsupported services keep custom creation disabled with an actionable explanation', async () => {
  const view = await dialog({ supported: false })
  assert.match(view.render(), /请更新 Agent 服务/)
  assert.equal(view.submit().disabled, true)
})
