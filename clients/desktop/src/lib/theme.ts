export const THEME_STORAGE_KEY = 'app-theme'

export const THEME_OPTIONS = [
  {
    id: 'black-gold',
    label: '极夜黑金',
    shortLabel: '黑金',
    description: '深色沉浸背景，使用流光金强调重要操作。',
    colorScheme: 'dark',
  },
  {
    id: 'light',
    label: '雾光浅色',
    shortLabel: '浅色',
    description: '冷调浅灰层级，保留黑金品牌的金色决策点。',
    colorScheme: 'light',
  },
] as const

export type Theme = typeof THEME_OPTIONS[number]['id']
export type ThemeColorScheme = typeof THEME_OPTIONS[number]['colorScheme']

export const DEFAULT_THEME: Theme = 'black-gold'

export interface ThemeStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export interface ThemeRoot {
  setAttribute: (name: string, value: string) => void
  style: {
    colorScheme: string
  }
}

export function isTheme(value: unknown): value is Theme {
  return THEME_OPTIONS.some((option) => option.id === value)
}

export function parseTheme(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME
}

export function getThemeStorage(): ThemeStorage | null {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readStoredTheme(storage: ThemeStorage | null = getThemeStorage()): Theme {
  if (!storage) return DEFAULT_THEME

  try {
    return parseTheme(storage.getItem(THEME_STORAGE_KEY))
  } catch {
    return DEFAULT_THEME
  }
}

export function writeStoredTheme(
  theme: Theme,
  storage: ThemeStorage | null = getThemeStorage(),
): boolean {
  if (!storage) return false

  try {
    storage.setItem(THEME_STORAGE_KEY, theme)
    return true
  } catch {
    return false
  }
}

export function getNextTheme(theme: Theme): Theme {
  const index = THEME_OPTIONS.findIndex((option) => option.id === theme)
  return THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length].id
}

export function getThemeOption(theme: Theme) {
  return THEME_OPTIONS.find((option) => option.id === theme) ?? THEME_OPTIONS[0]
}

export function applyThemeToDocument(
  theme: Theme,
  root: ThemeRoot | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
  if (!root) return

  const option = getThemeOption(theme)
  root.setAttribute('data-theme', option.id)
  root.style.colorScheme = option.colorScheme
}
