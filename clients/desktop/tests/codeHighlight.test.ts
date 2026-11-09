import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINES, shouldHighlightCode } from '../src/lib/codeHighlight.ts'

test('short code blocks are highlighted', () => {
  assert.equal(shouldHighlightCode('const a = 1'), true)
  assert.equal(shouldHighlightCode(''), true)
})

test('code at the limits is still highlighted, one past is not', () => {
  assert.equal(shouldHighlightCode('a'.repeat(MAX_HIGHLIGHT_CHARS)), true)
  assert.equal(shouldHighlightCode('a'.repeat(MAX_HIGHLIGHT_CHARS + 1)), false)
  assert.equal(shouldHighlightCode(Array(MAX_HIGHLIGHT_LINES).fill('x').join('\n')), true)
  assert.equal(shouldHighlightCode(Array(MAX_HIGHLIGHT_LINES + 1).fill('x').join('\n')), false)
})

test('a whole-page HTML block (hundreds of lines) is not highlighted', () => {
  assert.equal(shouldHighlightCode(Array(330).fill('<div class="row">content</div>').join('\n')), false)
})
