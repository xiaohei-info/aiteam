import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { normalizeRuntimeProviderConfig } from "../manager-client.js";
import { registerRuntimeProvider, type RuntimeProviderConfig } from "./model-runtime.js";

const pricing = {
  pricing_version: 1, pricing_status: "known", billing_mode: "token",
  input_usd_per_million: "0.30", output_usd_per_million: "1.20",
  cache_read_usd_per_million: "0.06", cache_write_usd_per_million: null,
  request_usd: null, currency: "USD", effective_from: "2026-08-24T00:00:00Z",
} as const;
const runtimeConfig = (overrides: Partial<RuntimeProviderConfig> = {}): RuntimeProviderConfig => ({
  base_url: "https://newapi.test/v1", api_protocol: "openai-completions", api_key: "k",
  model: "m", provider_ref: "p", provider_version: 1, model_version: 1, pricing, version: 1,
  ...overrides,
});

test("runtime provider config is strict and registers an in-memory model/key", async () => {
  const config = normalizeRuntimeProviderConfig({
    base_url: "https://newapi.test/v1",
    api_protocol: "openai-completions",
    api_key: "runtime-secret",
    model: "minimax-m3",
    provider_ref: "newapi-main",
    provider_version: 2,
    model_version: 4,
    pricing,
    version: 3,
    model_capabilities: { context_window: 96_000, max_tokens: 8_192, reasoning: false, input: ["text"] },
  });
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const model = await registerRuntimeProvider(runtime, config, "aiteam:test-provider");
  assert.equal(model.provider, "aiteam:test-provider");
  assert.equal(model.id, "minimax-m3");
  assert.equal(model.contextWindow, 96_000);
  assert.equal(model.maxTokens, 8_192);
  assert.equal(model.reasoning, false);
  assert.equal((await runtime.getAuth("aiteam:test-provider"))?.auth.apiKey, "runtime-secret");
  await runtime.removeRuntimeApiKey("aiteam:test-provider");
  runtime.unregisterProvider("aiteam:test-provider");
  assert.equal(runtime.getModel("aiteam:test-provider", "minimax-m3"), undefined);
});

test("runtime provider registration removes partial state when registration fails", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider = () => { throw new Error("registration failed"); };
  await assert.rejects(
    registerRuntimeProvider(runtime, runtimeConfig(), "aiteam:failed-registration"),
  );
  assert.equal(runtime.getProvider("aiteam:failed-registration"), undefined);
});

test("runtime provider registration removes partial state when key binding fails", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  runtime.setRuntimeApiKey = async () => { throw new Error("key binding failed"); };
  await assert.rejects(
    registerRuntimeProvider(runtime, runtimeConfig(), "aiteam:failed-key"),
  );
  assert.equal(runtime.getProvider("aiteam:failed-key"), undefined);
});

test("runtime provider registration removes partial state when model lookup fails", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  runtime.getModel = () => undefined;
  await assert.rejects(
    registerRuntimeProvider(runtime, runtimeConfig(), "aiteam:failed-model"),
  );
  assert.equal(runtime.getProvider("aiteam:failed-model"), undefined);
});

test("runtime config rejects unknown fields and protocols", () => {
  assert.throws(() => normalizeRuntimeProviderConfig({ ...runtimeConfig(), credential_id: "arbitrary" }));
});
