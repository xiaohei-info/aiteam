import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AgentHttpServer } from "./server.js";
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
    assert.equal(((await list.json()) as { data: { items: unknown[] } }).data.items.length, 1);
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

test("Agent OpenAPI documents local attachment and artifact contracts", async () => {
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
    assert.equal(document.components.schemas.LocalFileMetadata.properties.kind.enum.includes("attachment"), true);
    const prompt = document.paths["/api/agent/conversations/{conversation_id}/prompt"].post;
    assert.deepEqual(prompt.requestBody.content["application/json"].schema, { $ref: "#/components/schemas/PromptRequest" });
    assert.equal(prompt.parameters.find((parameter: any) => parameter.name === "Idempotency-Key").required, true);
    assert.equal(prompt.parameters.find((parameter: any) => parameter.name === "Idempotency-Key").schema.maxLength, 256);
    assert.equal(prompt.parameters.find((parameter: any) => parameter.name === "conversation_id").schema.type, "string");
    assert.deepEqual(Object.keys(document.paths["/api/agent/conversations/{conversation_id}/attachments/{attachment_id}"].get.responses["200"].content).sort(), ["application/json", "application/octet-stream", "application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp", "text/markdown", "text/plain"]);
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
