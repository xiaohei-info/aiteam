/**
 * 设计系统 · design tokens（08 §12.2）。框架无关的设计变量单一来源。
 *
 * 取舍：共享层只下沉 tokens（颜色/间距/字号/圆角/层级），不绑定具体 UI 组件库——
 * 各端可在自己的工程里用 React/Vue 等渲染，但 token 取值统一从这里来，杜绝各端各调一套色。
 */

export const colorTokens = {
  brandPrimary: "#2563eb",
  brandPrimaryHover: "#1d4ed8",
  textPrimary: "#0f172a",
  textSecondary: "#475569",
  textMuted: "#94a3b8",
  bgCanvas: "#ffffff",
  bgSubtle: "#f8fafc",
  border: "#e2e8f0",
  success: "#16a34a",
  warning: "#d97706",
  danger: "#dc2626",
  info: "#0891b2",
} as const;

export const spaceTokens = {
  xs: "4px",
  sm: "8px",
  md: "16px",
  lg: "24px",
  xl: "32px",
  xxl: "48px",
} as const;

export const radiusTokens = {
  sm: "4px",
  md: "8px",
  lg: "12px",
  pill: "999px",
} as const;

export const fontSizeTokens = {
  xs: "12px",
  sm: "14px",
  md: "16px",
  lg: "20px",
  xl: "24px",
} as const;

export const zIndexTokens = {
  base: 0,
  dropdown: 1000,
  sticky: 1100,
  overlay: 1200,
  modal: 1300,
  toast: 1400,
} as const;

export type ColorToken = keyof typeof colorTokens;
export type SpaceToken = keyof typeof spaceTokens;
export type RadiusToken = keyof typeof radiusTokens;
export type FontSizeToken = keyof typeof fontSizeTokens;

/** 全部 token 聚合。 */
export const tokens = {
  color: colorTokens,
  space: spaceTokens,
  radius: radiusTokens,
  fontSize: fontSizeTokens,
  zIndex: zIndexTokens,
} as const;

/**
 * 把 tokens 展开为 CSS 自定义属性映射（`--ai-color-brand-primary` 等）。
 * 各端在根节点注入即可消费，无需复制取值。
 */
export function tokensToCssVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(colorTokens)) {
    vars[`--ai-color-${kebab(name)}`] = value;
  }
  for (const [name, value] of Object.entries(spaceTokens)) {
    vars[`--ai-space-${name}`] = value;
  }
  for (const [name, value] of Object.entries(radiusTokens)) {
    vars[`--ai-radius-${name}`] = value;
  }
  for (const [name, value] of Object.entries(fontSizeTokens)) {
    vars[`--ai-font-size-${name}`] = value;
  }
  for (const [name, value] of Object.entries(zIndexTokens)) {
    vars[`--ai-z-${name}`] = String(value);
  }
  return vars;
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
