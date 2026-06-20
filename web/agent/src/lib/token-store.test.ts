/**
 * token-store 测试：存取/清除/坏 JSON 不崩。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { clearSession, loadSession, saveSession } from "./token-store";

const sampleClaims = {
  user_id: "u1",
  roles: ["member"],
  exp: 9999,
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("token-store", () => {
  it("save/load 往返一致", () => {
    saveSession({ token: "tok-1", claims: sampleClaims });
    const got = loadSession();
    expect(got).toEqual({ token: "tok-1", claims: sampleClaims });
  });

  it("clear 后 load 返回 null", () => {
    saveSession({ token: "tok-2", claims: sampleClaims });
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it("空存储 load 返回 null", () => {
    expect(loadSession()).toBeNull();
  });

  it("坏 JSON claims 回退为 null（不抛）", () => {
    window.localStorage.setItem("aiteam.agent.token", "tok-3");
    window.localStorage.setItem("aiteam.agent.claims", "{not json");
    expect(loadSession()).toBeNull();
  });
});
