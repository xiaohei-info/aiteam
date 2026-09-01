import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AgentHttpServer } from "./server.js";
import { HttpManagerClient } from "../manager-client.js";
import { createFixture } from "../test-fixture.js";

function pngBytes(size = 8): Buffer {
  const bytes = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

async function waitForEntries(url: string, token: string): Promise<unknown[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(url, { headers: { Authorization: token } });
    const body = (await response.json()) as { data: { entries: unknown[] } };
    if (body.data.entries.length > 0) return body.data.entries;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for Pi session entries");
}

test("Agent HTTP local files enforce conversation ownership and support lifecycle routes", async () => {
  const fixture = await createFixture();
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }),
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const upload = await fetch(`${base}/api/agent/conversations/c1/attachments`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "photo.png", mime_type: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64") }),
    });
    assert.equal(upload.status, 201);
    const uploaded = (await upload.json()) as { data: { id: string; byte_size: number } };
    assert.equal(uploaded.data.byte_size, 8);

    const list = await fetch(`${base}/api/agent/conversations/c1/attachments`, { headers: { Authorization: "Bearer test" } });
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { data: unknown[] }).data.length, 1);
    const download = await fetch(`${base}/api/agent/conversations/c1/attachments/${uploaded.data.id}`, { headers: { Authorization: "Bearer test" } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "image/png");
    assert.equal((await download.arrayBuffer()).byteLength, 8);

    const badMime = await fetch(`${base}/api/agent/conversations/c1/attachments`, {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "x.exe", mime_type: "application/x-msdownload", data: "eA==" }),
    });
    assert.equal(badMime.status, 422);
    const malformed = await fetch(`${base}/api/agent/conversations/c1/attachments`, {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "x.png", mime_type: "image/png", data: "not-base64" }),
    });
    assert.equal(malformed.status, 422);
    const mismatch = await fetch(`${base}/api/agent/conversations/c1/attachments`, {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "x.png", mime_type: "image/png", data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64") }),
    });
    assert.equal(mismatch.status, 422);
    const missing = await fetch(`${base}/api/agent/conversations/c1/attachments/${uploaded.data.id}`, { method: "DELETE", headers: { Authorization: "Bearer test" } });
    assert.equal(missing.status, 200);
    assert.equal((await missing.json() as { data: { deleted: boolean } }).data.deleted, true);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent speech transcription pulls Manager config and forwards only a local audio file", async () => {
  const fixture = await createFixture();
  const managerRequests: { url: string; init: RequestInit }[] = [];
  const upstreamRequests: { url: string; init: RequestInit }[] = [];
  const managerClient = new HttpManagerClient("https://manager.test", async (input, init) => {
    managerRequests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: {
      base_url: "https://relay.test/v1", api_protocol: "openai-completions", api_key: "tenant-token",
      model: "XingChenAGI/XingChenASR-V3.2-Ultra", provider_ref: "provider-1", provider_version: 1, model_version: 1, version: 1,
      pricing: { pricing_version: 1, pricing_status: "known", billing_mode: "request", input_usd_per_million: null, output_usd_per_million: null, cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: "0", currency: "USD", effective_from: new Date().toISOString() },
    } }), { status: 200 });
  });
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    managerClient,
    fetch: async (input, init) => {
      upstreamRequests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ text: "你好，世界", duration: 0.5 }), { status: 200, headers: { "content-type": "application/json" } });
    },
    authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }),
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/agent/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "recording.webm", mime_type: "audio/webm;codecs=opus", data: Buffer.from("local-audio").toString("base64") }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual((await response.json() as { data: { text: string; duration: number } }).data, { text: "你好，世界", duration: 0.5 });
    assert.equal(managerRequests[0]?.url, "https://manager.test/api/manager/provider-credentials/speech/runtime-config");
    assert.equal(managerRequests[0]?.init.body, JSON.stringify({}));
    assert.equal(upstreamRequests[0]?.url, "https://relay.test/v1/audio/transcriptions");
    assert.equal((upstreamRequests[0]?.init.headers as Record<string, string>).Authorization, "Bearer tenant-token");
    const form = upstreamRequests[0]?.init.body as FormData;
    assert.equal(form.get("model"), "XingChenAGI/XingChenASR-V3.2-Ultra");
    assert.equal((form.get("file") as File).name, "recording.webm");
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent speech transcription rejects unsupported MIME types before Manager access", async () => {
  const fixture = await createFixture();
  let managerCalls = 0;
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    managerClient: { pullSpeechRuntimeConfig: async () => { managerCalls += 1; throw new Error("must not call"); } } as any,
    authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }),
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/audio/transcriptions`, {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "x.txt", mime_type: "text/plain", data: "eA==" }),
    });
    assert.equal(response.status, 422);
    assert.equal(managerCalls, 0);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent conversation permissions default to read-only and update through the local API", async () => {
  const fixture = await createFixture();
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const created = await fetch(`${base}/api/agent/conversations`, {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "permission" }),
    });
    assert.equal(created.status, 201);
    const initial = (await created.json() as { data: { id: string; permission_mode: string } }).data;
    assert.equal(initial.permission_mode, "read-only");
    const updated = await fetch(`${base}/api/agent/conversations/${initial.id}`, {
      method: "PATCH", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ permission_mode: "workspace-write" }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as { data: { permission_mode: string } }).data.permission_mode, "workspace-write");
    const invalid = await fetch(`${base}/api/agent/conversations/${initial.id}`, {
      method: "PATCH", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ permission_mode: "unsafe" }),
    });
    assert.equal(invalid.status, 422);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent group creation binds an authorized coordinator and rejects cross-roster input", async () => {
  const fixture = await createFixture();
  const now = new Date().toISOString();
  fixture.store.replaceProjections([
    { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "coord", display_name: "Coordinator", revoked: false, synced_at: now },
    { employee_id: "worker", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "worker", display_name: "Worker", revoked: false, synced_at: now },
  ], [{ solution_instance_id: "solution-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", display_name: "Solution", expert_employee_ids: ["worker"] }], [
    { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "coord-snapshot", display_name: "Coordinator" },
    { employee_id: "worker", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "worker-snapshot", display_name: "Worker" },
  ]);
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unauthorized = await fetch(`${base}/api/agent/conversations`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ kind: "group", coordinator_employee_id: "coordinator", solution_instance_id: "solution-1" }) });
    assert.equal(unauthorized.status, 403);
    assert.equal((await unauthorized.json() as { code: string }).code, "coordinator_not_authorized");
    const created = await fetch(`${base}/api/agent/conversations`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ kind: "group", solution_instance_id: "solution-1" }) });
    assert.equal(created.status, 201);
    const metadata = (await created.json() as { data: { coordinator_employee_id: string; kind: string; solution_instance_id: string } }).data;
    assert.equal(metadata.kind, "group");
    assert.equal(metadata.coordinator_employee_id, "worker");
    assert.equal(metadata.solution_instance_id, "solution-1");
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent prompt rejects an explicitly inactive expert before reserving the idempotency key", async () => {
  const fixture = await createFixture();
  const projection = { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "test", provider_ref: "test-provider" } };
  const snapshot = { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: [] } };
  fixture.store.replaceProjections([{ ...projection, status: "draft" }], [], [snapshot]);
  fixture.store.updateConversation("c1", { entryEmployeeId: "employee-1" });
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = () => fetch(`${base}/api/agent/conversations/c1/prompt`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "inactive-prompt" }, body: JSON.stringify({ text: "hello" }) });
  try {
    const blocked = await request();
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { code: string }).code, "employee_not_runnable");

    fixture.store.replaceProjections([{ ...projection, status: "active" }], [], [snapshot]);
    fixture.faux.setResponses([fauxAssistantMessage("ok")]);
    assert.equal((await request()).status, 202);
    assert((await waitForEntries(`${base}/api/agent/conversations/c1/entries`, "Bearer test")).length > 0);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent prompt resolves only owned image attachment IDs into Pi", async () => {
  const fixture = await createFixture();
  fixture.store.replaceProjections([{ employee_id: "employee-1", tenant_id: "tenant-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "test" } }], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
  fixture.store.updateConversation("c1", { entryEmployeeId: "employee-1" });
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const upload = await fetch(`${base}/api/agent/conversations/c1/attachments`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ filename: "photo.png", mime_type: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64") }) });
    const attachment = (await upload.json()) as { data: { id: string } };
    fixture.faux.setResponses([fauxAssistantMessage("ok")]);
    const prompt = await fetch(`${base}/api/agent/conversations/c1/prompt`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "attachment-prompt" }, body: JSON.stringify({ text: "inspect", attachment_ids: [attachment.data.id] }) });
    assert.equal(prompt.status, 202);
    await waitForEntries(`${base}/api/agent/conversations/c1/entries`, "Bearer test");
    const referenced = fixture.store.getOwnedLocalFile(attachment.data.id, "c1", "tenant-1", "member-1");
    assert(referenced?.referenced_at);
    // A completed duplicate returns its receipt even if the mutable attachment is gone.
    fixture.store.deleteOwnedLocalFile(attachment.data.id, "c1", "tenant-1", "member-1");
    const completedDuplicate = await fetch(`${base}/api/agent/conversations/c1/prompt`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "attachment-prompt" }, body: JSON.stringify({ text: "inspect", attachment_ids: [attachment.data.id] }) });
    assert.equal(completedDuplicate.status, 202);
    const artifactUpload = await fetch(`${base}/api/agent/conversations/c1/artifacts`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ filename: "artifact.png", mime_type: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64") }) });
    assert.equal(artifactUpload.status, 201, await artifactUpload.clone().text());
    const artifact = (await artifactUpload.json()) as { data: { id: string } };
    const artifactPrompt = await fetch(`${base}/api/agent/conversations/c1/prompt`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "artifact-attachment" }, body: JSON.stringify({ text: "inspect", attachment_ids: [artifact.data.id] }) });
    assert.equal(artifactPrompt.status, 422);
    const inlineMismatch = await fetch(`${base}/api/agent/conversations/c1/prompt`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "inline-mismatch" }, body: JSON.stringify({ text: "inspect", images: [{ type: "image", data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"), mimeType: "image/png" }] }) });
    assert.equal(inlineMismatch.status, 422);
    const rejected = await fetch(`${base}/api/agent/conversations/c1/prompt`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "missing-attachment" }, body: JSON.stringify({ text: "inspect", attachment_ids: ["missing"] }) });
    assert.equal(rejected.status, 404);
    const rejectedRetry = await fetch(`${base}/api/agent/conversations/c1/prompt`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "missing-attachment" }, body: JSON.stringify({ text: "inspect", attachment_ids: ["missing"] }) });
    assert.equal(rejectedRetry.status, 409);
    assert.equal((await rejectedRetry.json() as { code: string }).code, "idempotency_unknown");
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent context HUD is authenticated and thinking changes apply to later prompts without sending non-images to Pi", async () => {
  const fixture = await createFixture();
  const reasoning = fauxProvider({
    api: "aiteam-context-api",
    provider: "aiteam-context",
    models: [{ id: "aiteam-context-1", name: "Context Test", reasoning: true, contextWindow: 2_000 }],
  });
  fixture.modelRuntime.registerNativeProvider(reasoning.provider);
  const host = fixture.createHost(reasoning.getModel());
  const now = new Date().toISOString();
  fixture.store.replaceProjections([
    { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: now, model_policy: { model: reasoning.getModel().id } },
  ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
  fixture.store.updateConversation("c1", { entryEmployeeId: "employee-1" });
  const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const initial = await fetch(`${base}/api/agent/conversations/c1/context`, { headers: { Authorization: "Bearer test" } });
    assert.equal(initial.status, 200);
    const initialContext = (await initial.json() as { data: { model: { id: string }; context_window: number; used_tokens: number | null; thinking_level: string } }).data;
    assert.equal(initialContext.model.id, "aiteam-context-1");
    assert.equal(initialContext.context_window, 2_000);
    assert.equal(initialContext.thinking_level, "off");
    assert.equal(initialContext.used_tokens === null || initialContext.used_tokens >= 0, true);

    const attachment = await fetch(`${base}/api/agent/conversations/c1/attachments`, {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "notes.md", mime_type: "text/markdown", data: Buffer.from("local notes").toString("base64") }),
    });
    assert.equal(attachment.status, 201);
    const attachmentId = (await attachment.json() as { data: { id: string } }).data.id;

    const changed = await fetch(`${base}/api/agent/conversations/c1/context`, {
      method: "PATCH", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ thinking_level: "high" }),
    });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json() as { data: { thinking_level: string } }).data.thinking_level, "high");

    reasoning.setResponses([(context) => {
      assert.equal(JSON.stringify(context.messages).includes('"type":"image"'), false);
      return fauxAssistantMessage("ok");
    }]);
    const prompt = await fetch(`${base}/api/agent/conversations/c1/prompt`, {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "context-prompt" },
      body: JSON.stringify({ text: "inspect local metadata", attachment_ids: [attachmentId] }),
    });
    assert.equal(prompt.status, 202);
    await waitForEntries(`${base}/api/agent/conversations/c1/entries`, "Bearer test");
    assert(fixture.store.getOwnedLocalFile(attachmentId, "c1", "tenant-1", "member-1")?.referenced_at);

    const later = await fetch(`${base}/api/agent/conversations/c1/thinking-level`, {
      method: "PUT", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ thinking_level: "low" }),
    });
    assert.equal(later.status, 200);
    assert.equal((await later.json() as { data: { thinking_level: string } }).data.thinking_level, "low");
  } finally {
    await http.close();
    await host.dispose();
    await fixture.close();
  }
});

test("Agent prompt rejects aggregate decoded image bytes over 20 MiB", async () => {
  const fixture = await createFixture();
  fixture.store.replaceProjections([{ employee_id: "employee-1", tenant_id: "tenant-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "test" } }], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
  fixture.store.updateConversation("c1", { entryEmployeeId: "employee-1" });
  const ids = Array.from({ length: 5 }, (_, index) => fixture.store.createLocalFile({ conversationId: "c1", tenantId: "tenant-1", memberId: "member-1", kind: "attachment", filename: `image-${index}.png`, mimeType: "image/png", data: pngBytes(4 * 1024 * 1024 + 1) }).id);
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const bodyLimit = await fetch(`http://127.0.0.1:${address.port}/api/agent/conversations/c1/prompt`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "body-limit" }, body: JSON.stringify({ text: "x".repeat(256 * 1024) }) });
    assert.equal(bodyLimit.status, 413);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/conversations/c1/prompt`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "aggregate-images" }, body: JSON.stringify({ text: "inspect", attachment_ids: ids }) });
    assert.equal(response.status, 413);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent OpenAPI documents local attachment, artifact, and SSE event contracts", async () => {
  const fixture = await createFixture();
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const document = await (await fetch(`http://127.0.0.1:${address.port}/openapi.json`)).json() as { paths: Record<string, any>; components: { schemas: Record<string, any> } };
    for (const [kind, id] of [["attachments", "attachment_id"], ["artifacts", "artifact_id"]] as const) {
      const collection = document.paths[`/api/agent/conversations/{conversation_id}/${kind}`];
      assert.equal(collection.post.parameters.find((item: any) => item.name === "conversation_id").required, true);
      assert.deepEqual(collection.post.requestBody.content["application/json"].schema, { $ref: "#/components/schemas/LocalFileUpload" });
      const item = document.paths[`/api/agent/conversations/{conversation_id}/${kind}/{${id}}`];
      assert.equal(item.get.parameters.find((parameter: any) => parameter.name === id).required, true);
      assert.equal(item.delete.responses["404"].$ref, "#/components/responses/NotFound");
    }
    assert.deepEqual(document.components.schemas.LocalFileUpload.required, ["filename", "mime_type", "data"]);
    assert.deepEqual(document.components.schemas.AudioTranscriptionRequest.required, ["filename", "mime_type", "data"]);
    assert.equal(document.paths["/api/agent/audio/transcriptions"].post.requestBody.content["application/json"].schema.$ref, "#/components/schemas/AudioTranscriptionRequest");
    assert.equal(document.components.schemas.LocalFileMetadata.properties.kind.enum.includes("attachment"), true);
    const prompt = document.paths["/api/agent/conversations/{conversation_id}/prompt"].post;
    assert.deepEqual(prompt.requestBody.content["application/json"].schema, { $ref: "#/components/schemas/PromptRequest" });
    assert.equal(prompt.parameters.find((parameter: any) => parameter.name === "Idempotency-Key").required, true);

    const eventOperation = document.paths["/api/agent/conversations/{conversation_id}/events"].get;
    assert.equal(eventOperation.description, "订阅当前会话的本地 Pi 实时事件（SSE）；事件字段见 [PiSseEventData](#/components/schemas/PiSseEventData)。");
    const eventStream = eventOperation.responses["200"].content["text/event-stream"];
    assert.equal(eventOperation.parameters.find((parameter: any) => parameter.name === "Last-Event-ID").in, "header");
    assert.equal(eventStream["x-event-data-schema"].$ref, "#/components/schemas/PiSseEventData");
    assert(eventStream.schema.description.includes("<a href='#/components/schemas/PiSseEventData' target='_self'>PiSseEventData</a>"));
    assert(eventOperation.responses["200"].description.includes("data"));
    assert.deepEqual(Object.keys(eventStream.examples).sort(), ["lifecycle", "thinking", "todoUpdate", "toolCall", "toolExecution"]);
    assert(eventStream.examples.thinking.value.includes('"thinking"'));
    assert(eventStream.examples.toolCall.value.includes('"toolcall_end"'));
    assert(eventStream.examples.todoUpdate.value.includes('"tool_kind":"todo"'));
    const navigationScript = await (await fetch(`http://127.0.0.1:${address.port}/docs/static/theme/aiteam-sse-schema-navigation.js`)).text();
    assert(navigationScript.includes("preventDefault"));
    assert(navigationScript.includes("scrollIntoView"));
    const eventSchema = document.components.schemas.PiSseEventData;
    assert.deepEqual(eventSchema.properties.type.enum, [
      "agent_start", "agent_end", "agent_settled", "message_update", "message_end",
      "tool_execution_start", "tool_execution_update", "tool_execution_end",
      "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end", "approval_required",
    ]);
    assert.equal(eventSchema.properties.message.$ref, "#/components/schemas/ConversationMessage");
    assert.equal(eventSchema.properties.assistantMessageEvent.$ref, "#/components/schemas/PiSseAssistantMessageEvent");
    assert.deepEqual(eventSchema.properties.tool_kind.enum, ["memory", "rag", "todo"]);
    assert.equal(prompt.parameters.find((parameter: any) => parameter.name === "Idempotency-Key").schema.maxLength, 256);
    assert.equal(prompt.parameters.find((parameter: any) => parameter.name === "conversation_id").schema.type, "string");
    assert.deepEqual(Object.keys(document.paths["/api/agent/conversations/{conversation_id}/attachments/{attachment_id}"].get.responses["200"].content).sort(), ["application/json", "application/msword", "application/octet-stream", "application/pdf", "application/rtf", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/xml", "application/yaml", "image/gif", "image/jpeg", "image/png", "image/webp", "text/css", "text/csv", "text/html", "text/javascript", "text/markdown", "text/plain", "text/typescript", "text/xml", "text/yaml"]);
    for (const [path, pathItem] of Object.entries(document.paths)) {
      const names = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
      const item = pathItem as Record<string, any>;
      const parameters = [
        ...(Array.isArray(item.parameters) ? item.parameters : []),
        ...Object.values(item).flatMap((operation: any) => Array.isArray(operation?.parameters) ? operation.parameters : []),
      ];
      for (const name of names) {
        const parameter = parameters.find((item: any) => item.name === name && item.in === "path");
        assert.equal(parameter?.required, true, `${path} must require ${name}`);
        assert.equal(parameter?.schema?.type, "string", `${path} must schema ${name}`);
      }
    }
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent OpenAPI gives every frontend operation structured parameters, responses, and examples", async () => {
  const fixture = await createFixture();
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const document = await (await fetch(`http://127.0.0.1:${address.port}/openapi.json`)).json() as { paths: Record<string, any>; components: { schemas: Record<string, any>; responses: Record<string, any> } };
    const frontendOperations: Array<{ path: string; method: string; operation: any }> = [];
    for (const [path, pathItem] of Object.entries(document.paths)) {
      if (!(path.startsWith("/api/agent/") || path.startsWith("/api/auth/"))) continue;
      for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        frontendOperations.push({ path, method, operation });
      }
    }
    assert.equal(frontendOperations.length, 45);
    for (const { path, method, operation } of frontendOperations) {
      const label = `${method.toUpperCase()} ${path}`;
      assert(operation.summary, `${label} missing summary`);
      assert(operation.description, `${label} missing description`);
      assert(operation.operationId, `${label} missing operationId`);
      for (const parameter of operation.parameters ?? []) {
        assert(parameter.description, `${label} parameter ${parameter.name} missing description`);
        if (parameter.in === "path") assert.equal(parameter.required, true, `${label} path parameter ${parameter.name} must be required`);
        assert(parameter.schema && Object.keys(parameter.schema).length > 0, `${label} parameter ${parameter.name} missing schema`);
        assert(parameter.example !== undefined, `${label} parameter ${parameter.name} missing example`);
      }
      for (const content of Object.values(operation.requestBody?.content ?? {}) as any[]) {
        assert(content.schema && Object.keys(content.schema).length > 0, `${label} request missing schema`);
        assert(content.examples && Object.keys(content.examples).length > 0, `${label} request missing example`);
      }
      assert(operation.responses["500"]?.$ref === "#/components/responses/InternalError", `${label} missing 500 response`);
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) < 400) continue;
        const reference = (response as any).$ref;
        const errorResponse = reference ? document.components.responses[reference.split("/").at(-1)!] : response;
        assert(errorResponse?.content?.["application/problem+json"]?.schema?.$ref === "#/components/schemas/Problem", `${label} ${status} must use problem+json`);
      }
      const successResponses = Object.entries(operation.responses).filter(([status]) => /^2/.test(status));
      if (!path.includes("/knowledge-bases")) {
        assert(successResponses.length > 0, `${label} missing success response`);
        for (const [status, response] of successResponses) {
          const content = (response as any).content ?? {};
          assert(Object.keys(content).length > 0, `${label} ${status} missing response content`);
          for (const [media, value] of Object.entries(content) as [string, any][]) {
            assert(value.schema && Object.keys(value.schema).length > 0, `${label} ${status} ${media} missing response schema`);
            assert(value.examples && Object.keys(value.examples).length > 0, `${label} ${status} ${media} missing response example`);
          }
          assert((response as any).headers?.["X-Request-ID"]?.$ref === "#/components/headers/RequestId", `${label} ${status} missing request ID header`);
        }
      }
    }
    const shortKnowledgeParams = document.paths["/api/agent/knowledge-bases/{knowledge_base_id}/{kind}"].get.parameters;
    assert.deepEqual(shortKnowledgeParams.map((parameter: any) => parameter.name), ["knowledge_base_id", "kind"]);
    assert.deepEqual(document.components.schemas.ConversationState.anyOf.map((branch: any) => branch.enum?.[0]), ["draft", "active", "paused", "muted", "archived"]);
    assert.equal(document.components.schemas.ConversationScheduleInput.anyOf.length, 2);
    assert.equal(document.components.schemas.LocalFileUpload.properties.data.maxLength, 6_990_508);
    assert(document.components.schemas.LocalFileUpload.properties.mime_type.enum.includes("application/pdf"));
    assert.deepEqual(document.components.schemas.ReadinessState.anyOf.map((branch: any) => branch.enum?.[0]), ["ready", "degraded", "blocked", "unknown"]);
    assert.equal(document.components.schemas.ExpertReadiness.properties.skills.items.$ref, "#/components/schemas/SkillReadiness");
    assert.equal(document.components.schemas.ExpertReadiness.properties.capabilities.items.$ref, "#/components/schemas/CapabilityReadiness");
    for (const name of ["BadRequest", "Unauthorized", "Forbidden", "NotFound", "Conflict", "TooLarge", "ValidationError", "ManagerUnavailable", "BadGateway", "InternalError", "Gone"]) {
      assert(document.components.responses[name]?.content?.["application/problem+json"]?.schema?.$ref === "#/components/schemas/Problem", `missing problem response ${name}`);
      assert(document.components.responses[name]?.content?.["application/problem+json"]?.examples, `missing problem example ${name}`);
    }
    const sse = document.paths["/api/agent/conversations/{conversation_id}/events"].get.responses["200"];
    assert.equal(sse.headers["Cache-Control"].schema.example, "no-cache, no-transform");
    assert.equal(sse.headers["X-Accel-Buffering"].schema.example, "no");
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent OpenAPI exposes complete operation metadata", async () => {
  const fixture = await createFixture();
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const document = await (await fetch(`http://127.0.0.1:${address.port}/openapi.json`)).json() as { paths: Record<string, Record<string, any>>; components: { securitySchemes: Record<string, unknown>; schemas: Record<string, any> } };
    assert(document.components.securitySchemes.bearerAuth);
    const ids = new Set<string>();
    for (const [path, pathItem] of Object.entries(document.paths)) {
      if (!path.startsWith("/api/")) continue;
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        assert(operation.summary, `${method} ${path} missing summary`);
        assert(operation.description, `${method} ${path} missing description`);
        assert(operation.tags?.length, `${method} ${path} missing tags`);
        assert(operation.operationId && !ids.has(operation.operationId), `${method} ${path} has duplicate operationId`);
        ids.add(operation.operationId);
        assert.deepEqual(operation.security, path.startsWith("/api/auth/") || path.endsWith("/login") || path.endsWith("/reset-password") || path.endsWith("/ping") ? [] : [{ bearerAuth: [] }]);
        assert(operation.responses["422"]?.$ref === "#/components/responses/ValidationError", `${method} ${path} missing unified validation response`);
      }
    }
    for (const [name, schema] of Object.entries(document.components.schemas)) {
      assert(schema.description, `schema ${name} missing description`);
      for (const [field, value] of Object.entries(schema.properties ?? {})) {
        const property = value as { $ref?: unknown; description?: unknown };
        if (value && typeof value === "object" && !property.$ref) assert(property.description, `schema ${name}.${field} missing description`);
      }
    }
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent HTTP prompt accepts an idempotent Pi prompt", async () => {
  const fixture = await createFixture();
  fixture.store.replaceProjections([{ employee_id: "employee-1", tenant_id: "tenant-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "test" } }], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
  fixture.store.updateConversation("c1", { entryEmployeeId: "employee-1" });
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    authenticate: (request) => {
      assert.equal(request.headers.authorization, "Bearer test");
      return { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] };
    },
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    fixture.faux.setResponses([fauxAssistantMessage("ok")]);
    const eventsAbort = new AbortController();
    const eventsResponse = await fetch(`${base}/api/agent/conversations/c1/events`, {
      headers: { Authorization: "Bearer test" },
      signal: eventsAbort.signal,
    });
    assert.equal(eventsResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert(eventsResponse.body);
    const reader = eventsResponse.body.getReader();
    const decoder = new TextDecoder();
    const connected = await reader.read();
    assert(decoder.decode(connected.value).includes(": connected"));

    const prompt = await fetch(`${base}/api/agent/conversations/c1/prompt`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(prompt.status, 202);
    const accepted = (await prompt.json()) as { data: { accepted: boolean } };
    assert.equal(accepted.data.accepted, true);

    let streamed = "";
    for (let attempt = 0; attempt < 10 && !streamed.includes('"type":"message_update"'); attempt += 1) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 1000)),
      ]);
      if (next.done) break;
      streamed += decoder.decode(next.value);
    }
    assert(streamed.includes("event: pi"));
    assert(streamed.includes('"type":"message_update"'));
    assert(streamed.includes('"source_employee_id":"employee-1"'));
    eventsAbort.abort();
    await reader.cancel().catch(() => undefined);

    const entries = await waitForEntries(`${base}/api/agent/conversations/c1/entries`, "Bearer test");
    assert(entries.length > 0);

    const duplicate = await fetch(`${base}/api/agent/conversations/c1/prompt`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(duplicate.status, 202);

    const conflict = await fetch(`${base}/api/agent/conversations/c1/prompt`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify({ text: "different" }),
    });
    assert.equal(conflict.status, 409);
    const conflictBody = (await conflict.json()) as { code: string };
    assert.equal(conflictBody.code, "idempotency_conflict");
    assert.equal(fixture.faux.state.callCount, 1, "duplicate idempotency key does not prompt twice");
  } finally {
    await http.close();
    await fixture.close();
  }
});
