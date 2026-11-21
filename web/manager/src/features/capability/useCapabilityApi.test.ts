import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../../api/client", () => ({
  createManagerApiClient: vi.fn(() => ({ post, get: vi.fn(), put: vi.fn(), del: vi.fn(), listGet: vi.fn() })),
}));
vi.mock("../../auth/session", () => ({
  useSession: () => ({ token: "tok", onUnauthorized: () => undefined }),
}));

import { useCapabilityApi } from "./useCapabilityApi";

describe("useCapabilityApi 技能导入", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockResolvedValue({ origin: { kind: "text", label: "粘贴" }, results: [] });
  });

  it("检查与导入走本端接口；可见范围与停用作为附加字段带上", async () => {
    const { result } = renderHook(() => useCapabilityApi());
    await result.current.previewSkillImport({ source: "url", url: "https://example.com/s.md", visibility: "tenant", binding_policy: "opt_in" });
    expect(post).toHaveBeenCalledWith("/api/manager/skills/import/preview", {
      body: { source: "url", url: "https://example.com/s.md", visibility: "tenant", binding_policy: "opt_in" },
    });
    await result.current.importSkills({ source: "text", text: "x", roots: [""] });
    expect(post).toHaveBeenLastCalledWith("/api/manager/skills/import", { body: { source: "text", text: "x", roots: [""] } });
  });

  it("上传来源用 multipart，附加字段也进表单", async () => {
    const { result } = renderHook(() => useCapabilityApi());
    const file = new File(["# S"], "SKILL.md");
    await result.current.importSkills({ source: "file", files: [{ file, path: "SKILL.md" }], visibility: "tenant" });
    const body = post.mock.calls[0]![1].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("visibility")).toBe("tenant");
    expect(body.get("binding_policy")).toBeNull();
  });
});
