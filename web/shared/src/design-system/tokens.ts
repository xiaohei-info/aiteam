/**
 * 设计系统 · 黑金玻璃质感 design tokens（唯一来源）。
 * 框架无关的设计变量单一来源——经 design-system/css.ts 生成 Tailwind v4 @theme CSS，
 * 消灭旧"TS→多份 CSS 手工镜像"。各端只 @import 生成物，不复制取值。
 */

export const colorTokens = {
  bgCanvas: "#0c0a07",
  surface: "#16120d",
  surfaceRaised: "#1c1710",
  gold: "#cda349",
  goldBright: "#e7c873",
  goldDeep: "#b8862f",
  textPrimary: "#f3ecdc",
  textSecondary: "#b8ad97",
  textMuted: "#8a8068",
  success: "#4aa062",
  warning: "#e0a44a",
  danger: "#e5645a",
  info: "#6fb6d6",
} as const;

export const glassTokens = {
  blurPanel: "30px",
  blurSidebar: "18px",
  bgPanel: "rgba(22,18,13,0.72)",
  bgSidebar: "rgba(14,11,7,0.45)",
  bgSolid: "#16120d",
  border: "rgba(212,175,95,0.18)",
  highlight: "rgba(255,235,190,0.10)",
  shadow: "0 24px 70px rgba(0,0,0,0.55)",
} as const;

export const spaceTokens = {
  xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "32px", xxl: "48px",
} as const;

export const radiusTokens = {
  sm: "4px", md: "8px", lg: "12px", window: "16px", pill: "999px",
} as const;

export const fontSizeTokens = {
  xs: "12px", sm: "14px", md: "16px", lg: "20px", xl: "24px",
} as const;

export const zIndexTokens = {
  base: 0, dropdown: 1000, sticky: 1100, overlay: 1200, modal: 1300, toast: 1400,
} as const;

export const tokens = {
  color: colorTokens,
  glass: glassTokens,
  space: spaceTokens,
  radius: radiusTokens,
  fontSize: fontSizeTokens,
  zIndex: zIndexTokens,
} as const;

export type ColorToken = keyof typeof colorTokens;
export type GlassToken = keyof typeof glassTokens;
export type SpaceToken = keyof typeof spaceTokens;
export type RadiusToken = keyof typeof radiusTokens;
export type FontSizeToken = keyof typeof fontSizeTokens;

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export { kebab };
