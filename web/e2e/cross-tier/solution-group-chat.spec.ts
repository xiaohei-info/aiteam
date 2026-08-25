/**
 * Pi-native solution → fixed multi-session group chat vertical slice.
 *
 * This is intentionally API-first: the browser/API harness is the product boundary for
 * Operation/Manager/Agent, while Agent Pi execution is fake in local Playwright and may
 * use the externally configured provider in E2E_EXTERNAL deployments.
 */

import { test, expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiLogin, defaultCredentials, TIER_API_ORIGIN } from "../support/auth";

type JsonRecord = Record<string, unknown>;
type Login = { token: string };

type Expert = {
  employee_id: string;
  handle: string;
  display_name?: string;
  revoked?: boolean;
};

type Entry = {
  source_employee_id?: string;
  source_role?: string;
  logical_message_id?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    errorMessage?: string;
    stopReason?: string;
  };
};

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function body(response: APIResponse): Promise<JsonRecord> {
  return (await response.json()) as JsonRecord;
}

async function skipUnavailable(response: APIResponse, stage: string): Promise<boolean> {
  if ([401, 403, 503].includes(response.status())) {
    test.skip(true, `[${stage}] external prerequisite unavailable: HTTP ${response.status()} ${await response.text()}`);
    return true;
  }
  return false;
}

async function requireOk(response: APIResponse, stage: string): Promise<JsonRecord> {
  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`[${stage}] HTTP ${response.status()}: ${text.slice(0, 800)}`);
  }
  return body(response);
}

async function getEntries(request: APIRequestContext, token: string, conversationId: string): Promise<Entry[]> {
  const response = await request.get(
    `${TIER_API_ORIGIN.agent}/api/agent/conversations/${encodeURIComponent(conversationId)}/entries`,
    { headers: bearer(token), failOnStatusCode: false },
  );
  const payload = await requireOk(response, "agent-entries");
  const data = payload.data as JsonRecord | undefined;
  return Array.isArray(data?.entries) ? data.entries as Entry[] : [];
}

function assistantFrom(entries: Entry[], employeeId: string): Entry | undefined {
  return entries.find((entry) => entry.source_employee_id === employeeId && entry.message?.role === "assistant");
}

async function waitForAssistant(
  request: APIRequestContext,
  token: string,
  conversationId: string,
  employeeIds: string[],
): Promise<Entry[]> {
  let latest: Entry[] = [];
  await expect.poll(async () => {
    latest = await getEntries(request, token, conversationId);
    return employeeIds.every((employeeId) => Boolean(assistantFrom(latest, employeeId)));
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toBe(true);

  const errors = latest
    .map((entry) => entry.message)
    .filter((message) => message?.role === "assistant" && message.stopReason === "error")
    .map((message) => message?.errorMessage ?? "provider error");
  if (errors.length > 0 && process.env.E2E_EXTERNAL === "true") {
    test.skip(true, `[agent-pi] external provider did not execute: ${errors.join(" | ").slice(0, 800)}`);
  }
  return latest;
}

async function prompt(
  request: APIRequestContext,
  token: string,
  conversationId: string,
  text: string,
  mentions: string[] = [],
): Promise<void> {
  const response = await request.post(
    `${TIER_API_ORIGIN.agent}/api/agent/conversations/${encodeURIComponent(conversationId)}/prompt`,
    {
      data: { text, ...(mentions.length > 0 ? { mentions } : {}) },
      headers: { ...bearer(token), "Content-Type": "application/json", "Idempotency-Key": `solution-group-${randomUUID()}` },
      failOnStatusCode: false,
    },
  );
  expect(response.status(), "Agent prompt must be accepted by the shared Pi prompt endpoint").toBe(202);
}

test.describe("Pi solution → fixed participant group chat", () => {
  test("Operator publish → Manager apply/authorize → Agent fixed sessions and @ routing", async ({ request }) => {
    const opLogin = await apiLogin(request, "operation", defaultCredentials("operation"));
    const managerLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    const agentLogin = await apiLogin(request, "agent", defaultCredentials("agent"));
    const opHeaders = bearer(opLogin.token);
    const managerHeaders = bearer(managerLogin.token);
    const agentHeaders = bearer(agentLogin.token);
    const tag = randomUUID().replace(/-/g, "").slice(0, 12);

    // 1. Choose an Operator-published provider/model rather than hard-coding a runtime.
    const providersResponse = await request.get(`${TIER_API_ORIGIN.operation}/api/operation/providers`, {
      headers: opHeaders,
      failOnStatusCode: false,
    });
    if (await skipUnavailable(providersResponse, "operator-provider")) return;
    const providersPayload = await requireOk(providersResponse, "operator-provider");
    const providers = Array.isArray(providersPayload.data) ? providersPayload.data as JsonRecord[] : [];
    const provider = providers.find((item) => item.status === "published");
    if (!provider || typeof provider.provider_id !== "string") {
      test.skip(true, "[operator-provider] no published Operator provider is available");
      return;
    }
    const modelsResponse = await request.get(`${TIER_API_ORIGIN.operation}/api/operation/providers/${provider.provider_id}/models`, {
      headers: opHeaders,
      failOnStatusCode: false,
    });
    if (await skipUnavailable(modelsResponse, "operator-model")) return;
    const modelsPayload = await requireOk(modelsResponse, "operator-model");
    const modelItems = ((modelsPayload.data as JsonRecord | undefined)?.items ?? []) as JsonRecord[];
    const priced = modelItems.find((item) => {
      const model = item.model as JsonRecord | undefined;
      const rate = item.rate as JsonRecord | undefined;
      return model?.status === "published" && rate?.pricing_status === "known";
    });
    const model = priced?.model as JsonRecord | undefined;
    if (!model || typeof model.model_id !== "string" || typeof provider.version !== "number" || typeof model.version !== "number") {
      test.skip(true, "[operator-model] no published priced model is available");
      return;
    }
    const modelRef = {
      provider_id: provider.provider_id,
      provider_version: provider.version,
      model_id: model.model_id,
      model_version: model.version,
    };

    // 2. Register and publish two expert templates, then publish a fixed coordinator solution.
    const expertIds: string[] = [];
    for (const role of ["finance", "operations"]) {
      const expertResponse = await request.post(`${TIER_API_ORIGIN.operation}/api/operation/catalog/expert-templates`, {
        data: {
          template_id: `e2e-solution-${role}-${tag}`,
          display_name: `E2E Solution ${role} ${tag}`,
          category: "E2E",
          system_prompt: `You are the ${role} solution expert. Reply briefly.`,
          platform_model_ref: modelRef,
          platform_skill_refs: [],
          description: `Pi solution ${role} expert`,
        },
        headers: { ...opHeaders, "Content-Type": "application/json" },
        failOnStatusCode: false,
      });
      if (await skipUnavailable(expertResponse, `operator-expert-${role}`)) return;
      const expertPayload = await requireOk(expertResponse, `operator-expert-${role}`);
      const expertData = expertPayload.data as JsonRecord;
      const templateId = expertData.template_id;
      expect(typeof templateId, "Operator expert registration returns template_id").toBe("string");
      expertIds.push(templateId as string);
      const publishResponse = await request.post(`${TIER_API_ORIGIN.operation}/api/operation/catalog/expert_template/${templateId}/publish`, {
        data: {}, headers: opHeaders, failOnStatusCode: false,
      });
      await requireOk(publishResponse, `operator-publish-${role}`);
    }

    const solutionId = `e2e-solution-group-${tag}`;
    const solutionResponse = await request.post(`${TIER_API_ORIGIN.operation}/api/operation/catalog/solution-templates`, {
      data: {
        solution_id: solutionId,
        display_name: `E2E Solution Group ${tag}`,
        description: "Pi fixed participant group E2E",
        expert_template_ids: expertIds,
        coordinator_template_id: expertIds[0],
        coordinator_instructions: "Direct @ mentions must go to the addressed participant.",
        tags: ["e2e", "pi"],
      },
      headers: { ...opHeaders, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    if (await skipUnavailable(solutionResponse, "operator-solution")) return;
    const solutionPayload = await requireOk(solutionResponse, "operator-solution");
    expect((solutionPayload.data as JsonRecord).coordinator_template_id).toBe(expertIds[0]);
    const publishSolutionResponse = await request.post(`${TIER_API_ORIGIN.operation}/api/operation/catalog/solution_template/${solutionId}/publish`, {
      data: {}, headers: opHeaders, failOnStatusCode: false,
    });
    await requireOk(publishSolutionResponse, "operator-solution-publish");

    // 3. Manager applies the exact published solution version to this tenant/member.
    const managerWhoamiResponse = await request.get(`${TIER_API_ORIGIN.manager}/api/manager/whoami`, {
      headers: managerHeaders, failOnStatusCode: false,
    });
    const managerWhoami = (await requireOk(managerWhoamiResponse, "manager-whoami")).data as JsonRecord;
    const tenantId = managerWhoami.tenant_id;
    const memberId = managerWhoami.user_id;
    expect(typeof tenantId).toBe("string");
    expect(typeof memberId).toBe("string");
    const applyResponse = await request.post(`${TIER_API_ORIGIN.manager}/api/manager/recruit/solutions`, {
      data: { solution_id: solutionId, solution_version: "1", member_ids: [memberId], department_ids: [] },
      headers: { ...managerHeaders, "Content-Type": "application/json", "Idempotency-Key": `e2e-apply-${tag}` },
      failOnStatusCode: false,
    });
    if (!applyResponse.ok()) {
      const text = await applyResponse.text();
      if (applyResponse.status() === 503 || /NewAPI|provider.?access|relay|credential/i.test(text)) {
        test.skip(true, `[manager-apply] provider/relay prerequisite unavailable: ${text.slice(0, 800)}`);
        return;
      }
      throw new Error(`[manager-apply] HTTP ${applyResponse.status()}: ${text.slice(0, 800)}`);
    }
    const applyPayload = await body(applyResponse);
    const instance = (applyPayload.data as JsonRecord).solution_instance as JsonRecord;
    const instanceId = instance.id;
    const coordinatorId = instance.coordinator_employee_id;
    const rosterIds = instance.expert_employee_ids as string[];
    expect(rosterIds).toHaveLength(2);
    expect(coordinatorId).toBe(rosterIds[0]);

    // 4. Agent syncs projections, and group creation submits only the solution instance ID.
    const syncResponse = await request.post(`${TIER_API_ORIGIN.agent}/api/agent/grants/sync`, {
      data: { tenant_id: tenantId, member_id: memberId, known_versions: {} },
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    expect(syncResponse.ok(), `[agent-sync] HTTP ${syncResponse.status()}`).toBeTruthy();
    expect((await body(syncResponse)).data).toMatchObject({ ok: true });

    const solutionProjectionResponse = await request.get(`${TIER_API_ORIGIN.agent}/api/agent/grants/solutions`, {
      headers: agentHeaders, failOnStatusCode: false,
    });
    const solutionProjection = await requireOk(solutionProjectionResponse, "agent-solution-projection");
    const projected = (solutionProjection.data as JsonRecord[]).find((item) => item.solution_instance_id === instanceId) as JsonRecord | undefined;
    expect(projected, `[agent-solution-projection] expected ${instanceId}; received ${JSON.stringify(solutionProjection.data).slice(0, 1200)}`).toBeTruthy();
    expect(projected?.coordinator_employee_id).toBe(coordinatorId);

    const groupResponse = await request.post(`${TIER_API_ORIGIN.agent}/api/agent/conversations`, {
      data: { title: `E2E group ${tag}`, kind: "group", solution_instance_id: instanceId },
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    const groupPayload = await requireOk(groupResponse, "agent-group-create");
    const group = groupPayload.data as JsonRecord;
    const conversationId = group.id as string;
    expect(group.solution_instance_id).toBe(instanceId);
    expect(group.coordinator_employee_id).toBe(coordinatorId);
    expect(group.entry_employee_id).toBeNull();
    expect((await getEntries(request, agentLogin.token, conversationId))).toHaveLength(0);

    const expertsResponse = await request.get(`${TIER_API_ORIGIN.agent}/api/agent/grants/experts`, {
      headers: agentHeaders, failOnStatusCode: false,
    });
    const expertsPayload = await requireOk(expertsResponse, "agent-roster");
    const experts = expertsPayload.data as Expert[];
    const roster = experts.filter((expert) => rosterIds.includes(expert.employee_id) && !expert.revoked);
    expect(roster).toHaveLength(2);
    const coordinator = roster.find((expert) => expert.employee_id === coordinatorId)!;
    const peer = roster.find((expert) => expert.employee_id !== coordinatorId)!;
    expect(coordinator.handle).toBeTruthy();
    expect(peer.handle).toBeTruthy();

    // 5. Ordinary group semantics: no @ → coordinator, one @ → that participant, many @ → both.
    await prompt(request, agentLogin.token, conversationId, "请返回无艾特路由结果");
    let entries = await waitForAssistant(request, agentLogin.token, conversationId, [coordinator.employee_id]);
    expect(assistantFrom(entries, coordinator.employee_id)).toBeTruthy();

    await prompt(request, agentLogin.token, conversationId, `@${peer.handle} 请返回单艾特路由结果`, [peer.handle]);
    entries = await waitForAssistant(request, agentLogin.token, conversationId, [peer.employee_id]);
    expect(assistantFrom(entries, peer.employee_id)).toBeTruthy();

    await prompt(request, agentLogin.token, conversationId, `@${coordinator.handle} @${peer.handle} 请分别返回多艾特结果`, [coordinator.handle, peer.handle]);
    entries = await waitForAssistant(request, agentLogin.token, conversationId, [coordinator.employee_id, peer.employee_id]);
    expect(assistantFrom(entries, coordinator.employee_id)).toBeTruthy();
    expect(assistantFrom(entries, peer.employee_id)).toBeTruthy();
    expect(entries.filter((entry) => entry.message?.role === "user" && entry.logical_message_id).length).toBeGreaterThanOrEqual(3);

    // 6. A second group conversation receives a fresh participant-session set and empty history.
    const secondGroupResponse = await request.post(`${TIER_API_ORIGIN.agent}/api/agent/conversations`, {
      data: { title: `E2E group second ${tag}`, kind: "group", solution_instance_id: instanceId },
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    const secondGroup = (await requireOk(secondGroupResponse, "agent-group-new-conversation")).data as JsonRecord;
    expect(secondGroup.id).not.toBe(conversationId);
    expect(await getEntries(request, agentLogin.token, secondGroup.id as string)).toHaveLength(0);

    // Abort is exposed on the same Conversation API as private chat.
    await prompt(request, agentLogin.token, conversationId, "请执行一个可取消的群聊消息");
    const abortResponse = await request.post(`${TIER_API_ORIGIN.agent}/api/agent/conversations/${conversationId}/abort`, {
      headers: agentHeaders, failOnStatusCode: false,
    });
    expect(abortResponse.ok(), `[agent-abort] HTTP ${abortResponse.status()}`).toBeTruthy();

    // 7. Revoke the solution grant; sync must remove the solution projection and reject new group creation.
    const grantsResponse = await request.get(`${TIER_API_ORIGIN.manager}/api/manager/grants`, {
      headers: managerHeaders, failOnStatusCode: false,
    });
    const grants = (await requireOk(grantsResponse, "manager-grants")).data as JsonRecord[];
    const solutionGrant = grants.find((grant) => grant.resource_type === "solution" && grant.resource_id === instanceId);
    expect(solutionGrant?.id).toBeTruthy();
    const deleteGrantResponse = await request.delete(`${TIER_API_ORIGIN.manager}/api/manager/grants/${solutionGrant?.id}`, {
      headers: managerHeaders, failOnStatusCode: false,
    });
    expect(deleteGrantResponse.ok(), `[manager-revoke-solution] HTTP ${deleteGrantResponse.status()}`).toBeTruthy();

    const knownVersion = typeof projected?.version === "string" ? projected.version : "1:1";
    const revokeSyncResponse = await request.post(`${TIER_API_ORIGIN.agent}/api/agent/grants/sync`, {
      data: { tenant_id: tenantId, member_id: memberId, known_versions: { [instanceId as string]: knownVersion } },
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    const revokeSync = await requireOk(revokeSyncResponse, "agent-revoke-sync");
    expect((revokeSync.data as JsonRecord).revoked).toBeGreaterThanOrEqual(1);

    const revokedCreateResponse = await request.post(`${TIER_API_ORIGIN.agent}/api/agent/conversations`, {
      data: { title: "must fail after revoke", kind: "group", solution_instance_id: instanceId },
      headers: { ...agentHeaders, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    expect(revokedCreateResponse.status(), "revoked solution cannot create a new group").toBe(403);
    expect(revokedCreateResponse.headers()["content-type"] ?? "").toContain("application/problem+json");

    // Existing history remains readable locally after revocation; revocation blocks new work.
    expect((await getEntries(request, agentLogin.token, conversationId)).length).toBeGreaterThan(0);
  });
});
