import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const globalStyles = readFileSync(new URL('../src/styles/globals.css', import.meta.url), 'utf8')

test('全局键盘焦点使用统一金色外发光', () => {
  assert.match(globalStyles, /--brand-focus-ring:\s*0 0 0 3px rgba\(212, 175, 55, 0\.2\)/)
  assert.match(globalStyles, /:where\([\s\S]*?\):focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--brand\)/)
  assert.match(globalStyles, /:where\([\s\S]*?\):focus-visible\s*\{[\s\S]*?box-shadow:\s*var\(--brand-focus-ring\)/)
})

function listStyleFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return listStyleFiles(entryPath)
    return entry.name.endsWith('.css') ? [entryPath] : []
  })
}

test('组件高优先级 focus-visible 规则不会覆盖统一 3px 品牌 ring', () => {
  const sourceRoot = new URL('../src', import.meta.url)
  const styleFiles = listStyleFiles(sourceRoot.pathname)
  const focusRulePattern = /([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/g

  for (const file of styleFiles) {
    const css = readFileSync(file, 'utf8')
    for (const match of css.matchAll(focusRulePattern)) {
      const selector = match[1]
      const declarations = match[2]
      const overridesRing = /(?:outline|box-shadow)\s*:/.test(declarations)
      if (!overridesRing || /:focus-visible\s+(?:::|\.)/.test(selector)) continue

      assert.match(
        declarations,
        /box-shadow:\s*var\(--brand-focus-ring\)/,
        `${file} 中的 ${selector.trim()} 必须保留统一品牌 ring`,
      )
      assert.doesNotMatch(
        declarations,
        /outline:\s*(?:0|none)\s*;(?!(?:[\s\S]*box-shadow:\s*var\(--brand-focus-ring\)))/,
      )
    }
  }
})

test('Tailwind 交互类不会以 2px ring 或 outline-none 覆盖全局键盘焦点', () => {
  const sourceRoot = new URL('../src', import.meta.url)
  const sourceFiles = readdirSync(sourceRoot.pathname, { recursive: true })
    .filter((file): file is string => typeof file === 'string' && file.endsWith('.tsx'))

  for (const relativeFile of sourceFiles) {
    const source = readFileSync(path.join(sourceRoot.pathname, relativeFile), 'utf8')
    assert.doesNotMatch(source, /focus-visible:(?:outline-none|ring-2|ring-brand)/)
  }
})
