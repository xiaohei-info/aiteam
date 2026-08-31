export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ModelCapabilities = {
  reasoning?: boolean;
  thinking_levels?: ThinkingLevel[];
  thinking_level_map?: Partial<Record<ThinkingLevel, string | null>>;
  thinking_mode?: "toggle" | "effort" | "budget" | "none";
};

export function thinkingLevelsForModel(capabilities: ModelCapabilities | undefined): ThinkingLevel[] {
  if (capabilities?.thinking_levels?.length) return [...new Set(capabilities.thinking_levels)];
  const mapped = capabilities?.thinking_level_map;
  if (mapped) {
    const levels = THINKING_LEVELS.filter((level) => mapped[level] !== null && (level === "off" || mapped[level] !== undefined));
    if (levels.length) return levels;
  }
  if (capabilities?.reasoning === false) return ["off"];
  return ["off", "minimal", "low", "medium", "high"];
}

export function thinkingLabel(level: ThinkingLevel, capabilities: ModelCapabilities | undefined): string {
  if (level === "off") return "关闭思考";
  if (capabilities?.thinking_mode === "toggle" && level === "high") return "开启思考";
  const labels: Record<Exclude<ThinkingLevel, "off">, string> = {
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
  };
  return `${level}（${labels[level]}）`;
}
