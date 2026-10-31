import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateFitScale } from '../src/lib/fitScale.ts'

test('适应屏幕同时受画布宽度和高度约束', () => {
  assert.equal(calculateFitScale({
    contentWidth: 1000,
    contentHeight: 600,
    viewportWidth: 800,
    viewportHeight: 300,
  }), 0.5)

  assert.equal(calculateFitScale({
    contentWidth: 1000,
    contentHeight: 400,
    viewportWidth: 750,
    viewportHeight: 800,
  }), 0.75)
})

test('适应屏幕遵守 50% 到 200% 的缩放边界', () => {
  assert.equal(calculateFitScale({
    contentWidth: 200,
    contentHeight: 100,
    viewportWidth: 1000,
    viewportHeight: 800,
  }), 2)

  assert.equal(calculateFitScale({
    contentWidth: 4000,
    contentHeight: 3000,
    viewportWidth: 800,
    viewportHeight: 600,
  }), 0.5)
})

test('画布尚未渲染时安全回退到 100%', () => {
  assert.equal(calculateFitScale({
    contentWidth: 0,
    contentHeight: 0,
    viewportWidth: 800,
    viewportHeight: 600,
  }), 1)
})
