import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ME_CHANGED_EVENT, useMe } from "../useMe";

const session = { token: "tok", onUnauthorized: () => {} };
vi.mock("../../auth/session", () => ({ useSession: () => session }));

afterEach(() => vi.unstubAllGlobals());

function meBody(enterprise_name: string | null) {
  return {
    data: {
      enterprise_name,
      enterprise_code: "acme",
      account_masked: "138****0000",
      roles: ["owner"],
      has_password: true,
      password_policy: { min_length: 8, require_upper: true, require_lower: true, require_digit: true, require_symbol: false, max_age_days: 0 },
    },
  };
}

describe("useMe", () => {
  it("收到 me 变更事件后重新读取（设置页改了企业名，顶栏不用刷新页面）", async () => {
    let name: string | null = null;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(meBody(name)), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMe());
    await waitFor(() => expect(result.current?.account_masked).toBe("138****0000"));
    expect(result.current?.enterprise_name).toBeNull();
    const before = fetchMock.mock.calls.length;

    name = "新企业名";
    act(() => { window.dispatchEvent(new Event(ME_CHANGED_EVENT)); });
    await waitFor(() => expect(result.current?.enterprise_name).toBe("新企业名"));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });
});
