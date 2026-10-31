import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  getNextTheme,
  parseTheme,
  readStoredTheme,
  writeStoredTheme,
  type ThemeRoot,
  type ThemeStorage,
} from '../src/lib/theme.ts'

class MemoryThemeStorage implements ThemeStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

test('theme parsing accepts only supported persisted values', () => {
  assert.equal(parseTheme('black-gold'), 'black-gold')
  assert.equal(parseTheme('light'), 'light')

  for (const invalidValue of [null, undefined, '', 'dark', 'parchment', 'system', 1, {}]) {
    assert.equal(parseTheme(invalidValue), DEFAULT_THEME)
  }
})

test('theme preference persists and restores using the shared storage key', () => {
  const storage = new MemoryThemeStorage()

  assert.equal(readStoredTheme(storage), DEFAULT_THEME)
  assert.equal(writeStoredTheme('light', storage), true)
  assert.equal(storage.getItem(THEME_STORAGE_KEY), 'light')
  assert.equal(readStoredTheme(storage), 'light')

  storage.setItem(THEME_STORAGE_KEY, 'unsupported-theme')
  assert.equal(readStoredTheme(storage), DEFAULT_THEME)
})

test('theme storage failures degrade to the brand default without throwing', () => {
  const unavailableStorage: ThemeStorage = {
    getItem() {
      throw new Error('storage unavailable')
    },
    setItem() {
      throw new Error('storage unavailable')
    },
  }

  assert.equal(readStoredTheme(unavailableStorage), DEFAULT_THEME)
  assert.equal(writeStoredTheme('light', unavailableStorage), false)
})

test('theme application synchronizes data-theme and native color-scheme', () => {
  const attributes = new Map<string, string>()
  const root: ThemeRoot = {
    setAttribute(name, value) {
      attributes.set(name, value)
    },
    style: { colorScheme: '' },
  }

  applyThemeToDocument('light', root)
  assert.equal(attributes.get('data-theme'), 'light')
  assert.equal(root.style.colorScheme, 'light')

  applyThemeToDocument('black-gold', root)
  assert.equal(attributes.get('data-theme'), 'black-gold')
  assert.equal(root.style.colorScheme, 'dark')
  assert.equal(getNextTheme('black-gold'), 'light')
  assert.equal(getNextTheme('light'), 'black-gold')
})

test('the blocking head bootstrap applies the stored theme before the app entry', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const bootstrap = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8')

  assert.ok(html.indexOf('/theme-init.js') < html.indexOf('/src/main.tsx'))
  assert.match(bootstrap, /storedTheme === 'black-gold' \|\| storedTheme === 'light'/)
  assert.match(bootstrap, /setAttribute\('data-theme', theme\)/)
  assert.match(bootstrap, /style\.colorScheme/)
})
