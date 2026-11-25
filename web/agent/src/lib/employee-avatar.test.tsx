/**
 * 员工头像取图适配测试。
 *
 * 红线：`/api/agent/employees/:id/avatar/content` 必须经带 Bearer 的 client 取字节，
 * 不能直接塞进 `<img src>`（img 带不了 Authorization）。
 */

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { stream, appRef } = vi.hoisted(() => {
  const streamFn = vi.fn();
  return { stream: streamFn, appRef: { current: null as null | { client: { stream: typeof streamFn }; token: string } } };
});

vi.mock("./app-context", () => ({ useOptionalApp: () => appRef.current }));

import { EmployeeAvatar, isProtectedEmployeeAvatar } from "./employee-avatar";

describe("isProtectedEmployeeAvatar", () => {
  it("只把本机员工头像路径视为受保护资源", () => {
    expect(isProtectedEmployeeAvatar("/api/agent/employees/e1/avatar/content")).toBe(true);
    expect(isProtectedEmployeeAvatar("/api/agent/employees/e1/avatar/content?v=3")).toBe(true);
    expect(isProtectedEmployeeAvatar("/api/manager/employees/e1/avatar/content")).toBe(false);
    expect(isProtectedEmployeeAvatar("data:image/png;base64,AAAA")).toBe(false);
    expect(isProtectedEmployeeAvatar("https://cdn.example/avatar.png")).toBe(false);
  });
});

describe("EmployeeAvatar", () => {
  beforeEach(() => {
    stream.mockReset();
    // 上下文值在真实应用里是 memo 化的，这里固定引用，避免 effect 因 client 换引用而反复重跑。
    appRef.current = { client: { stream }, token: "token-1" };
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:avatar"),
      revokeObjectURL: vi.fn(),
    }));
  });

  it("受保护路径先取 blob 再渲染 objectURL", async () => {
    stream.mockResolvedValue(new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 }));
    render(<EmployeeAvatar name="员工" src="/api/agent/employees/e1/avatar/content" />);

    await waitFor(() => expect(stream).toHaveBeenCalledWith("/api/agent/employees/e1/avatar/content", { headers: { Accept: "image/*" } }));
    await waitFor(() => {
      expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:avatar");
    });
  });

  it("data URL 不经过网络直接渲染", async () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    render(<EmployeeAvatar name="员工" src={dataUrl} />);

    await waitFor(() => {
      expect(document.querySelector("img")?.getAttribute("src")).toBe(dataUrl);
    });
    expect(stream).not.toHaveBeenCalled();
  });

  it("取图失败回退插画且不抛错", async () => {
    stream.mockRejectedValue(new Error("manager unavailable"));
    render(<EmployeeAvatar name="员工" src="/api/agent/employees/e1/avatar/content" />);

    await waitFor(() => expect(stream).toHaveBeenCalled());
    await waitFor(() => {
      expect(document.querySelector("img")).toBeNull();
      expect(document.querySelector("[data-aiteam-avatar='true']")).not.toBeNull();
    });
  });
});
