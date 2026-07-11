import { defineTheme } from "@astryxdesign/core/theme";
import { stoneTheme } from "@astryxdesign/theme-stone/built";

const systemSans =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

export const aiteamStone = defineTheme({
  name: "aiteam-stone",
  extends: stoneTheme,
  motion: { fast: 125, medium: 250, slow: 500, ratio: 0.75 },
  tokens: {
    "--color-accent": ["#3f5f88", "#9fc3ef"],
    "--color-accent-muted": ["#3f5f8814", "#9fc3ef24"],
    "--color-on-accent": ["#ffffff", "#17202b"],
    "--color-text-accent": ["#3f5f88", "#b7d2f3"],
    "--color-icon-accent": ["#3f5f88", "#b7d2f3"],
    "--color-text-secondary": ["#5b6066", "#b8bec5"],
    "--color-icon-secondary": ["#5b6066", "#b8bec5"],
    "--font-family-body": systemSans,
    "--font-family-heading": systemSans,
    "--font-family-code": '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  },
});
