import { describe, it, expect, vi } from "vitest";
import { ApiClient, type ApiClientConfig } from "./client.js";
import { ApiError } from "./errors.js";
import type { Problem } from "../contracts/envelope.js";

function jsonResponse(status: number, body: unknown, contentType = "application/json"): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": contentType },
  });
}

function makeClient(fetchImpl: typeof fetch, extra: Partial<ApiClientConfig> = {}) {
  return new ApiClient({ tier: "manager", baseUrl: "https://m.test", fetch: fetchImpl, ...extra });
}

describe("ApiClient envelope unwrap", () => {
  it("get unwraps Envelope.data", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: { id: "e1" } }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const result = await client.get<{ id: string }>("/api/manager/employees/e1");
    expect(result).toEqual({ id: "e1" });
  });

  it("listGet returns items + page", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { data: [{ id: "a" }], page: { next_cursor: "c2", has_more: true } }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const result = await client.listGet<{ id: string }>("/api/manager/employees");
    expect(result.items).toEqual([{ id: "a" }]);
    expect(result.page).toEqual({ next_cursor: "c2", has_more: true });
  });

  it("204 yields null data", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    expect(await client.del("/api/manager/employees/e1")).toBeNull();
  });
});

describe("ApiClient problem+json decode", () => {
  it("non-2xx problem becomes ApiError with code/detail/request_id", async () => {
    const problem: Problem = {
      type: "https://docs.aiteam.local/problems/validation_error",
      title: "Validation Error",
      status: 422,
      code: "validation_error",
      detail: "display_name 必填",
      request_id: "req_123",
    };
    const fetchMock = vi.fn(async () => jsonResponse(422, problem, "application/problem+json"));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.post("/api/manager/employees", { body: {} })).rejects.toMatchObject({
      name: "ApiError",
      status: 422,
      code: "validation_error",
      message: "display_name 必填",
      requestId: "req_123",
    });
  });

  it("401 triggers onUnauthorized and throws", async () => {
    const onUnauthorized = vi.fn();
    const problem: Problem = {
      type: "x",
      title: "Unauthorized",
      status: 401,
      code: "unauthorized",
    };
    const fetchMock = vi.fn(async () => jsonResponse(401, problem, "application/problem+json"));
    const client = makeClient(fetchMock as unknown as typeof fetch, { onUnauthorized });
    await expect(client.get("/api/manager/me")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("malformed error body still becomes ApiError", async () => {
    const fetchMock = vi.fn(async () => new Response("oops", { status: 500 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.get("/api/manager/me")).rejects.toMatchObject({
      code: "malformed_response",
      status: 500,
    });
  });

  it("network failure becomes ApiError network_error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.get("/api/manager/me")).rejects.toMatchObject({
      code: "network_error",
      status: 0,
    });
  });
});

describe("ApiClient request shaping", () => {
  it("injects Authorization, Idempotency-Key, Content-Type and query", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: { ok: true } }));
    const client = makeClient(fetchMock as unknown as typeof fetch, {
      getToken: () => "tok_abc",
    });
    await client.post("/api/manager/employees", {
      body: { name: "x" },
      idempotencyKey: "idem-1",
      query: { dryRun: true, skip: undefined },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://m.test/api/manager/employees?dryRun=true");
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok_abc");
    expect(headers.get("Idempotency-Key")).toBe("idem-1");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect((init as RequestInit).body).toBe(JSON.stringify({ name: "x" }));
  });
});

describe("ApiClient cross-tier guard (02 §10.1)", () => {
  it("rejects calling another tier prefix", async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.get("/api/operation/enterprises")).rejects.toMatchObject({
      code: "cross_tier_call_forbidden",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows own tier and /api/auth", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: null }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await client.get("/api/manager/me");
    await client.post("/api/auth/login", { body: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
