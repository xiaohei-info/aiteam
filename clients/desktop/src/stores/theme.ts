import { create } from 'zustand'
import {
  DEFAULT_THEME,
  applyThemeToDocument,
  getNextTheme,
  parseTheme,
  writeStoredTheme,
  type Theme,
} from '../lib/theme'

export type { Theme } from '../lib/theme'

interface ThemeStore {
  theme: Theme
  persistenceError: string | null
  setTheme: (theme: Theme) => void
  toggle: () => void
}

const initialTheme: Theme = DEFAULT_THEME
writeStoredTheme(initialTheme)
applyThemeToDocument(initialTheme)

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: initialTheme,
  persistenceError: null,

  setTheme: (theme) => {
    const nextTheme = parseTheme(theme)
    const persisted = writeStoredTheme(nextTheme)
    applyThemeToDocument(nextTheme)
    set({
      theme: nextTheme,
      persistenceError: persisted ? null : '主题已在当前会话生效，但无法保存到此设备。',
    })
  },

  toggle: () => {
    const nextTheme = getNextTheme(get().theme)
    const persisted = writeStoredTheme(nextTheme)
    applyThemeToDocument(nextTheme)
    set({
      theme: nextTheme,
      persistenceError: persisted ? null : '主题已在当前会话生效，但无法保存到此设备。',
    })
  },
}))
