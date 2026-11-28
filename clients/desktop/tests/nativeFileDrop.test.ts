import test from 'node:test'
import assert from 'node:assert/strict'
import { toClientPoint } from '../src/lib/nativeFileDrop.ts'

test('macOS：wry 给的是 AppKit 点坐标，已是 CSS 像素，不再除缩放', () => {
  assert.deepEqual(toClientPoint({ x: 300, y: 500 }, 2, true), { x: 300, y: 500 })
})

test('Windows：物理像素按 devicePixelRatio 换成 CSS 像素', () => {
  assert.deepEqual(toClientPoint({ x: 300, y: 500 }, 1.5, false), { x: 200, y: 500 / 1.5 })
})

test('缩放未知时原样返回', () => {
  assert.deepEqual(toClientPoint({ x: 3, y: 4 }, 0, false), { x: 3, y: 4 })
})
