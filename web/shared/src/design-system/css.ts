/**
 * 由 tokens 生成 Tailwind v4 @theme CSS + 玻璃质感基样（含 @supports 降级）。
 * 唯一生成入口——消费端 @import 生成物，不手抄取值。
 */
import {
  colorTokens, glassTokens, spaceTokens, radiusTokens, fontSizeTokens, kebab,
} from "./tokens.js";

export function buildTokensCss(): string {
  const lines: string[] = [];
  lines.push("@theme {");
  for (const [k, v] of Object.entries(colorTokens)) lines.push(`  --color-${kebab(k)}: ${v};`);
  for (const [k, v] of Object.entries(spaceTokens)) lines.push(`  --spacing-${k}: ${v};`);
  for (const [k, v] of Object.entries(radiusTokens)) lines.push(`  --radius-${k}: ${v};`);
  for (const [k, v] of Object.entries(fontSizeTokens)) lines.push(`  --text-${k}: ${v};`);
  for (const [k, v] of Object.entries(glassTokens)) lines.push(`  --glass-${kebab(k)}: ${v};`);
  lines.push("}");
  lines.push("");
  // 玻璃基样：默认毛玻璃；不支持 backdrop-filter 时退化为实色暗面板（不丢可用性）。
  lines.push(".glass {");
  lines.push(`  background: ${glassTokens.bgPanel};`);
  lines.push(`  backdrop-filter: blur(${glassTokens.blurPanel}) saturate(150%);`);
  lines.push(`  -webkit-backdrop-filter: blur(${glassTokens.blurPanel}) saturate(150%);`);
  lines.push(`  border: 1px solid ${glassTokens.border};`);
  lines.push(`  box-shadow: ${glassTokens.shadow}, inset 0 1px 0 ${glassTokens.highlight};`);
  lines.push("}");
  lines.push("@supports not (backdrop-filter: blur(1px)) {");
  lines.push(`  .glass { background: ${glassTokens.bgSolid}; }`);
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}
