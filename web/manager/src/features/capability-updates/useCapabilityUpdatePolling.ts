/** 企业端检查时机：进入后一次、每 10 分钟、切回窗口（1 分钟内不重复）。只给能管理技能 / MCP 的角色查。 */
import { useEffect, useRef } from "react";
import { useMcpMarketApi } from "../mcp-market/useMcpMarketApi";
import { useSkillMarketApi } from "../skill-market/useSkillMarketApi";
import { countMcpUpdates, countSkillUpdates, reportCapabilityUpdates, resetCapabilityUpdates } from "./store";

export const CAPABILITY_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const CAPABILITY_FOCUS_MIN_GAP_MS = 60 * 1000;

export function useCapabilityUpdatePolling(enabled: boolean): void {
  const skillApi = useSkillMarketApi();
  const mcpApi = useMcpMarketApi();
  const lastChecked = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) { resetCapabilityUpdates(); return; }
    let cancelled = false;
    const check = async () => {
      lastChecked.current = Date.now();
      const [skills, mcps] = await Promise.allSettled([skillApi.list(), mcpApi.list()]);
      if (cancelled) return;
      // 读不到的一侧保留上次的数字，平台暂时不可达不让红点忽闪。
      reportCapabilityUpdates({
        ...(skills.status === "fulfilled" ? { skills: countSkillUpdates(skills.value) } : {}),
        ...(mcps.status === "fulfilled" ? { mcps: countMcpUpdates(mcps.value) } : {}),
      });
    };
    void check();
    const timer = window.setInterval(() => void check(), CAPABILITY_CHECK_INTERVAL_MS);
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      if (lastChecked.current === null || Date.now() - lastChecked.current >= CAPABILITY_FOCUS_MIN_GAP_MS) void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, skillApi, mcpApi]);
}
