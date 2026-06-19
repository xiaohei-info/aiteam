/** 设计系统导出（08 §12.2）。tokens 单一来源 + CSS 变量注入。 */

export {
  tokens,
  colorTokens,
  spaceTokens,
  radiusTokens,
  fontSizeTokens,
  zIndexTokens,
  tokensToCssVars,
} from "./tokens.js";
export type {
  ColorToken,
  SpaceToken,
  RadiusToken,
  FontSizeToken,
} from "./tokens.js";
