import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { countMcpUpdates, countSkillUpdates, hasSkillUpdate, reportCapabilityUpdates, resetCapabilityUpdates, useCapabilityUpdateCounts } from "./store";

beforeEach(() => resetCapabilityUpdates());

describe("企业端能力更新计数", () => {
  it("技能只数已安装、有新版本且新版本可装的；与列表行上的「更新」按钮同一判断", () => {
    const items = [
      { installed: true, update_available: true, published_version: "2.0.0" },
      { installed: false, update_available: true, published_version: "2.0.0" },
      { installed: true, update_available: false, published_version: "2.0.0" },
      { installed: true, update_available: true, published_version: null },
    ];
    expect(countSkillUpdates(items)).toBe(1);
    expect(items.map(hasSkillUpdate)).toEqual([true, false, false, false]);
  });

  it("MCP 只数已启用且有新修订的", () => {
    const server = (enabled: boolean, update_available: boolean) => ({ enabled, update_available }) as never;
    expect(countMcpUpdates({ servers: [server(true, true), server(false, true), server(true, false)] })).toBe(1);
    expect(countMcpUpdates(null)).toBe(0);
  });

  it("页面写回后订阅方立即拿到新数字，只改一侧时另一侧保留", () => {
    const { result } = renderHook(() => useCapabilityUpdateCounts());
    act(() => reportCapabilityUpdates({ skills: 2, mcps: 1 }));
    expect(result.current).toEqual({ skills: 2, mcps: 1 });
    act(() => reportCapabilityUpdates({ skills: 0 }));
    expect(result.current).toEqual({ skills: 0, mcps: 1 });
  });
});
