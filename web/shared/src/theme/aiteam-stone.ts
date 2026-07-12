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
    "--text-heading-1-size": "1.875rem",
    "--text-heading-1-leading": "1.2",
    "--text-heading-2-leading": "1.25",
  },
  components: {
    heading: {
      "level:1": { letterSpacing: "-0.02em" },
      "level:2": { letterSpacing: "-0.012em" },
    },
    card: {
      base: { boxShadow: "var(--shadow-low)" },
      "variant:muted": { boxShadow: "none" },
    },
    "chat-composer": {
      base: {
        borderColor: "var(--color-border-emphasized)",
        boxShadow: "var(--shadow-med)",
      },
    },
  },
});
