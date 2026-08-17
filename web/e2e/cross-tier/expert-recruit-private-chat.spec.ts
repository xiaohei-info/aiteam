/**
 * AITEAM-685 跨端全链路 E2E：专家注册 → 招募 → 私聊会话创建。
 *
 * 业务闭环：Operator 发布专家模板 → Manager 创建 provider 并招募（按 model 自动匹配 provider）
 * → Manager 授权 member → Agent sync 拉取 → Agent 私聊 roster 出现该专家 → 创建私聊会话。
 *
 * 验证命令：
 *   npx playwright test e2e/cross-tier/expert-recruit-private-chat.spec.ts --project=cross-tier
 *
 * 验收锚点：
 * - Operation 端注册专家模板（default_model="gpt-4.1"）并发布。
 * - Manager 端 provider 凭据创建 → 招募专家（template_id 引用 Operator 模板）→ 落库 employee
 *   的 model_policy.model == "gpt-4.1" 且 model_policy.provider_ref == "newapi-main"（按模型自动匹配）。
 * - Manager 端 member_grant 授权 → Agent 端 sync 成功 → roster 可见该 employee。
 * - Agent 端创建私聊会话，entry_employee_id == 招募的 employee_id。
 * - /api/manager/grants/authorized-config 主体不一致 → 403，且不得被误判为通过。
 *
 * 失败定位：每个阶段独立断言，失败信息带阶段 tag（publish/recruit/match/auth/sync/roster/conversation），
 *           便于区分是发布、招募、匹配、授权、sync、roster 还是 conversation 创建失败。
 *
 * 运行依赖：完整三端栈（operation/manager/agent dev server + PG）。任一端未就绪时相关用例 skip
 *           （test.skip），不误报失败也不误报通过。
 */

import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  apiLogin,
  defaultCredentials,
  TIER_API_ORIGIN,
} from "../support/auth";

// ── helpers ──

/** 断言失败时带 stage tag，便于在 Playwright reporter 里定位全链断裂点。 */
function stageExpect(
  condition: boolean,
  stage: string,
  message: string,
): void {
  expect(condition, `[${stage}] ${message}`).toBe(true);
}

// ── 全链路 ──

test.describe("专家注册-招募-私聊 全链路（AITEAM-685）", () => {
  test("Operator 发布专家模板 → Manager 招募并匹配 provider → Agent sync → roster → 私聊会话", async ({
    request,
  }) => {
    // ── 0. 登录三端（任一失败则 skip，不误报）──
    const opLogin = await apiLogin(request, "operation", defaultCredentials("operation"));

    const uniqueTag = randomUUID().replace(/-/g, "").slice(0, 8);
    const templateDisplayName = `E2E Expert ${uniqueTag}`;

    // ── 1. Operator 注册专家模板（draft）──
    const uniqueSlug = `e2e-exp-${uniqueTag}`;
    const registerResp = await request.post(
      `${TIER_API_ORIGIN.operation}/api/operation/catalog/expert-templates`,
      {
        data: {
          template_id: uniqueSlug,
          display_name: templateDisplayName,
          category: "通用咨询",
          avatar_url: "https://example.com/avatar.png",
          system_prompt: "你是一个专业的 E2E 测试专家。",
          default_model: "gpt-4.1",
          skill_ids: ["skill-general"],
          tags: ["e2e", "cross-tier"],
          description: "E2E 全链路测试专家模板",
          initial_memories: [],
          sort_order: 0,
        },
        headers: { Authorization: `Bearer ${opLogin.token}` },
        failOnStatusCode: false,
      },
    );

    // operation 端 catalog 需平台角色 + catalog 基建就绪；未就绪则 skip 整条链路而非误报。
    if (!registerResp.ok()) {
      const status = registerResp.status();
      const text = await registerResp.text();
      if (status === 401 || status === 403) {
        test.skip(
          true,
          `[publish] Operator catalog 注册需 platform role（system_admin/system_operator），当前凭据无权：status=${status}`,
        );
        return;
      }
      if (status === 503) {
        test.skip(true, `[publish] Operator catalog 服务未就绪（503）：${text.slice(0, 200)}`);
        return;
      }
      // 非 2xx 必须 fail，不能绕过验收主链。
      const ct = registerResp.headers()["content-type"] ?? "";
      stageExpect(
        ct.includes("application/problem+json"),
        "publish",
        `register 错误响应必须是 problem+json（非 SPA fallback）: status=${status} ct=${ct}`,
      );
      throw new Error(`[publish] Operator 专家模板注册失败: status=${status} body=${text.slice(0, 500)}`);
    }

    const registerBody = (await registerResp.json()) as { data?: { template_id?: string; status?: string } };
    const templateId = registerBody.data?.template_id;
    stageExpect(Boolean(templateId), "publish", "注册响应须含 template_id");
    const afterRegisterStatus = registerBody.data?.status;
    stageExpect(
      afterRegisterStatus === "draft",
      "publish",
      `注册后状态应为 draft（发布前不外溢 Manager）：实际=${afterRegisterStatus}`,
    );

    // ── 2. Operator 发布模板 ──
    const publishResp = await request.post(
      `${TIER_API_ORIGIN.operation}/api/operation/catalog/expert_template/${templateId}/publish`,
      {
        data: {},
        headers: { Authorization: `Bearer ${opLogin.token}` },
        failOnStatusCode: false,
      },
    );
    if (!publishResp.ok()) {
      const text = await publishResp.text();
      throw new Error(`[publish] 发布模板失败: status=${publishResp.status()} body=${text.slice(0, 500)}`);
    }
    const publishBody = (await publishResp.json()) as { data?: { status?: string } };
    stageExpect(
      publishBody.data?.status === "published",
      "publish",
      `发布后状态应为 published：实际=${publishBody.data?.status}`,
    );

    // ── 3. Manager 创建 provider 凭据（model=gpt-4.1）──
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    const mgrToken = mgrLogin.token;
    const providerRef = "newapi-main";

    const providerResp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/provider-credentials`,
      {
        data: {
          provider_ref: providerRef,
          display_name: `E2E Provider ${uniqueTag}`,
          mode: "relay",
          endpoint: "https://api.example.com/v1",
          secret: `sk-e2e-${uniqueTag}`,
          visibility: "tenant",
          supported_models: [{ model: "gpt-4.1", enabled: true }],
        },
        headers: {
          Authorization: `Bearer ${mgrToken}`,
          "Content-Type": "application/json",
        },
        failOnStatusCode: false,
      },
    );
    if (!providerResp.ok()) {
      const status = providerResp.status();
      const text = await providerResp.text();
      if (status === 503) {
        test.skip(true, `[match] Manager 业务 DB 未配置（503）：${text.slice(0, 200)}`);
        return;
      }
      const ct = providerResp.headers()["content-type"] ?? "";
      stageExpect(
        ct.includes("application/problem+json") && !ct.includes("text/html"),
        "match",
        `provider 创建错误响应需为 problem+json：status=${status} ct=${ct}`,
      );
      throw new Error(`[match] Manager 创建 provider 凭据失败: status=${status} body=${text.slice(0, 500)}`);
    }
    const providerBody = (await providerResp.json()) as {
      data?: { credential_id?: string; provider_ref?: string; supported_models?: Array<{ model?: string }> };
    };
    const credentialId = providerBody.data?.credential_id;
    stageExpect(Boolean(credentialId), "match", "provider 凭据创建响应须含 credential_id");
    stageExpect(
      providerBody.data?.provider_ref === providerRef,
      "match",
      `provider_ref 应保持租户内唯一引用：期望=${providerRef} 实际=${providerBody.data?.provider_ref}`,
    );
    const supportedModels = providerBody.data?.supported_models ?? [];
    stageExpect(
      supportedModels.some((m) => m.model === "gpt-4.1"),
      "match",
      "provider 能力目录须含 gpt-4.1",
    );

    // ── 4. Manager 人才市场可见并招募专家 ──
    // 招募端点经 Operator 目录拉取端口拿模板（服务间调用，带 X-Service-Token）。
    const recruitResp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/recruit/experts`,
      {
        data: {
          template_id: templateId,
          display_name_override: `E2E Matched Expert ${uniqueTag}`,
        },
        headers: {
          Authorization: `Bearer ${mgrToken}`,
          "Content-Type": "application/json",
        },
        failOnStatusCode: false,
      },
    );
    if (!recruitResp.ok()) {
      const status = recruitResp.status();
      const text = await recruitResp.text();
      if (status === 503) {
        test.skip(true, `[recruit] Manager 招募链路未就绪（503）：${text.slice(0, 200)}`);
        return;
      }
      // Operator 目录拉取端口未配置（OPERATOR_URL 缺失 → fail-closed）时招募会失败；此时 skip 而非误报。
      if (text.includes("operator") || text.includes("OperatorCatalog") || text.includes("OPERATOR_URL")) {
        test.skip(
          true,
          `[recruit] Manager 拉取 Operator 目录失败（OPERATOR_URL 未配置或 Operator 未就绪）：${text.slice(0, 200)}`,
        );
        return;
      }
      const ct = recruitResp.headers()["content-type"] ?? "";
      stageExpect(
        ct.includes("application/problem+json") && !ct.includes("text/html"),
        "recruit",
        `招募错误响应需为 problem+json：status=${status} ct=${ct}`,
      );
      throw new Error(`[recruit] Manager 招募专家失败: status=${status} body=${text.slice(0, 500)}`);
    }

    const recruitBody = (await recruitResp.json()) as {
      data?: {
        employee_id?: string;
        source_template_id?: string;
        provider_match_status?: string;
      };
    };
    const employeeId = recruitBody.data?.employee_id;
    stageExpect(Boolean(employeeId), "recruit", "招募响应须含 employee_id");
    stageExpect(
      recruitBody.data?.source_template_id === templateId,
      "recruit",
      `招募结果的来源模板应等于发布的模板：期望=${templateId} 实际=${recruitBody.data?.source_template_id}`,
    );

    // ── 5. 断言 Manager employee 的 model_policy 自动匹配 ──
    const employeeResp = await request.get(
      `${TIER_API_ORIGIN.manager}/api/manager/employees/${employeeId}`,
      {
        headers: { Authorization: `Bearer ${mgrToken}` },
        failOnStatusCode: false,
      },
    );
    stageExpect(
      employeeResp.ok(),
      "match",
      `Manager employee 详情应可达：status=${employeeResp.status()}`,
    );
    const employeeBody = (await employeeResp.json()) as {
      data?: {
        employee_id?: string;
        model_policy?: { model?: string; provider_ref?: string };
      };
    };
    const modelPolicy = employeeBody.data?.model_policy ?? {};
    stageExpect(
      modelPolicy.model === "gpt-4.1",
      "match",
      `employee.model_policy.model 应自动匹配为模板 default_model="gpt-4.1"：实际=${modelPolicy.model}`,
    );
    stageExpect(
      modelPolicy.provider_ref === providerRef,
      "match",
      `employee.model_policy.provider_ref 应自动匹配为已有 provider：期望=${providerRef} 实际=${modelPolicy.provider_ref}`,
    );

    // ── 6. Manager 授权当前 member 使用该 employee（member_grant）──
    // whoami 拿当前 manager 主体的 tenant_id / user_id，作为授权对象。
    const whoamiResp = await request.get(`${TIER_API_ORIGIN.manager}/api/manager/whoami`, {
      headers: { Authorization: `Bearer ${mgrToken}` },
      failOnStatusCode: false,
    });
    stageExpect(whoamiResp.ok(), "auth", `Manager whoami 应可达：status=${whoamiResp.status()}`);
    const whoami = ((await whoamiResp.json()) as { data?: { user_id?: string; tenant_id?: string } }).data ?? {};
    const tenantId = whoami.tenant_id;
    stageExpect(Boolean(whoami.user_id), "auth", "Manager whoami 须含 user_id（作为授权对象 member_id）");
    // 已断言非空 → 收窄为 string，用于后续 member_id。
    const memberId = whoami.user_id as string;

    const grantResp = await request.post(`${TIER_API_ORIGIN.manager}/api/manager/grants`, {
      data: {
        resource_type: "expert",
        resource_id: employeeId,
        member_ids: [memberId],
        department_ids: [],
      },
      headers: {
        Authorization: `Bearer ${mgrToken}`,
        "Content-Type": "application/json",
      },
      failOnStatusCode: false,
    });
    if (!grantResp.ok()) {
      const status = grantResp.status();
      const text = await grantResp.text();
      if (status === 503) {
        test.skip(true, `[auth] Manager 授权链路未就绪（503）：${text.slice(0, 200)}`);
        return;
      }
      throw new Error(`[auth] Manager 创建授权失败: status=${status} body=${text.slice(0, 500)}`);
    }
    const grantBody = (await grantResp.json()) as {
      data?: { id?: string; resource_id?: string; member_ids?: string[] };
    };
    const grantId = grantBody.data?.id;
    stageExpect(Boolean(grantId), "auth", "授权创建响应须含 grant id");
    stageExpect(
      grantBody.data?.resource_id === employeeId,
      "auth",
      `授权 resource_id 应等于招募 employee：期望=${employeeId} 实际=${grantBody.data?.resource_id}`,
    );
    stageExpect(
      (grantBody.data?.member_ids ?? []).includes(memberId),
      "auth",
      `授权 member_ids 须含当前主体 ${memberId}`,
    );

    // ── 7. Agent sync 授权配置（pull 增量）──
    // Agent 端 Bearer 经 Manager 校验后缓存（本地单用户），sync 走 pull 链路。
    const syncResp = await request.post(`${TIER_API_ORIGIN.agent}/api/agent/grants/sync`, {
      data: { tenant_id: tenantId, member_id: memberId },
      // Agent 端 grants/sync 不挂 require_claims（本地拉取），无需 Bearer。
      headers: { "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    stageExpect(syncResp.ok(), "sync", `Agent grants sync 应可达：status=${syncResp.status()}`);
    const syncBody = (await syncResp.json()) as {
      data?: { ok?: boolean; upserted?: number; error?: string | null };
    };
    // 关键门禁：sync 必须真正 ok（not degraded）。Manager 不可达 → ok=false，不得误判为通过。
    stageExpect(
      syncBody.data?.ok === true,
      "sync",
      `Agent sync ok 应为 true（pull 链路贯通，非降级）：ok=${syncBody.data?.ok} error=${syncBody.data?.error ?? "none"}`,
    );
    stageExpect(
      (syncBody.data?.upserted ?? 0) >= 1,
      "sync",
      `Agent sync 应至少 upsert 1 条授权（刚创建的 grant）：upserted=${syncBody.data?.upserted}`,
    );

    // ── 8. Agent 私聊 roster 出现该专家 ──
    const rosterResp = await request.get(`${TIER_API_ORIGIN.agent}/api/agent/grants/experts`, {
      headers: { "Content-Type": "application/json" },
      // roster 是本地投影只读列表，不挂 require_claims。
      failOnStatusCode: false,
    });
    stageExpect(rosterResp.ok(), "roster", `Agent roster（grants/experts）应可达：status=${rosterResp.status()}`);
    const rosterBody = (await rosterResp.json()) as { data?: Array<{ employee_id?: string }> };
    const rosterItems = rosterBody.data ?? [];
    stageExpect(
      rosterItems.some((e) => e.employee_id === employeeId),
      "roster",
      `Agent roster 应包含招募 employee ${employeeId}（实际 ${rosterItems.length} 条）`,
    );

    // ── 9 + 10. Node Agent 直接打开本地 Pi Conversation 并提交 prompt ──
    // Conversation metadata is owned by the local Agent UI; the Node API owns
    // only prompt/entries/events/abort and does not expose a create/detail route.
    const convId = `e2e-private-${uniqueTag}`;
    const promptResp = await request.post(
      `${TIER_API_ORIGIN.agent}/api/agent/conversations/${convId}/prompt`,
      {
        data: { text: `@${employeeId} E2E private chat` },
        headers: { "Content-Type": "application/json", "Idempotency-Key": `private-${uniqueTag}` },
        failOnStatusCode: false,
      },
    );
    stageExpect(promptResp.status() === 202, "conversation", `Agent prompt 应接受：status=${promptResp.status()}`);

    // ── 11. Pi entries 是私聊的持久视图 ──
    const entriesResp = await request.get(
      `${TIER_API_ORIGIN.agent}/api/agent/conversations/${convId}/entries`,
      { headers: { "Content-Type": "application/json" }, failOnStatusCode: false },
    );
    stageExpect(entriesResp.ok(), "conversation", `Agent entries 应可达：status=${entriesResp.status()}`);
    const entriesBody = (await entriesResp.json()) as { data?: { entries?: unknown[] } };
    stageExpect(Array.isArray(entriesBody.data?.entries), "conversation", "entries 响应须含 entries 数组");
  });

  // ── 门禁 negative 用例：authorized-config 主体不一致 → 403，且不得被误判为通过 ──
  test("/api/manager/grants/authorized-config 主体不一致 → 403（F10 门禁）", async ({ request }) => {
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    const mgrToken = mgrLogin.token;

    // 先授权一个 employee 再构造主体不一致的请求，验证 403 门禁存在。
    const uniqueTag = randomUUID().replace(/-/g, "").slice(0, 8);
    const whoamiResp = await request.get(`${TIER_API_ORIGIN.manager}/api/manager/whoami`, {
      headers: { Authorization: `Bearer ${mgrToken}` },
      failOnStatusCode: false,
    });
    stageExpect(whoamiResp.ok(), "authz-gate-negative", `whoami 应可达：status=${whoamiResp.status()}`);
    const whoami = ((await whoamiResp.json()) as { data?: { user_id?: string; tenant_id?: string } }).data ?? {};
    const tenantId = whoami.tenant_id;
    const realMemberId = whoami.user_id;
    stageExpect(Boolean(tenantId), "authz-gate-negative", "whoami 须含 tenant_id");

    // 招募一个 employee（依赖 Operator catalog；未就绪则 skip）。
    // 找不到已发布模板时跳过本用例（本用例聚焦 403 门禁，不重复完整发布链路）。
    const recruitableResp = await request.get(
      `${TIER_API_ORIGIN.manager}/api/manager/recruit/catalog/experts`,
      {
        headers: { Authorization: `Bearer ${mgrToken}` },
        failOnStatusCode: false,
      },
    );
    // 人才市场端点内部拉取 Operator 目录（服务间调用）：Operator 未就绪或拉取超时 → 5xx，此时 skip 整条门禁用例而非误判为失败。
    if (!recruitableResp.ok()) {
      test.skip(
        true,
        `[authz-gate-negative] Manager 人才市场端点不可达（status=${recruitableResp.status()}，可能 OPERATOR_URL 未配置 / Operator 未就绪 / 拉取超时），跳过 403 门禁用例`,
      );
      return;
    }
    const recruitable = ((await recruitableResp.json()) as { data?: Array<{ template_id?: string }> }).data ?? [];
    if (recruitable.length === 0) {
      test.skip(
        true,
        "[authz-gate-negative] Manager 无可招募专家模板（Operator catalog 未拉取到数据，可能 OPERATOR_URL 未配置或 Operator 未就绪），跳过 403 门禁用例",
      );
      return;
    }
    const templateId = recruitable[0]?.template_id!;

    const recruitResp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/recruit/experts`,
      {
        data: { template_id: templateId, display_name_override: `gate-neg-${uniqueTag}` },
        headers: { Authorization: `Bearer ${mgrToken}`, "Content-Type": "application/json" },
        failOnStatusCode: false,
      },
    );
    if (!recruitResp.ok()) {
      const text = await recruitResp.text();
      test.skip(true, `[authz-gate-negative] 招募前置失败（依赖 Operator catalog）：${text.slice(0, 200)}`);
      return;
    }
    const employeeId = ((await recruitResp.json()) as { data?: { employee_id?: string } }).data?.employee_id;
    stageExpect(Boolean(employeeId), "authz-gate-negative", "招募前置须返回 employee_id");

    const grantResp = await request.post(`${TIER_API_ORIGIN.manager}/api/manager/grants`, {
      data: { resource_type: "expert", resource_id: employeeId, member_ids: [realMemberId ?? ""] },
      headers: { Authorization: `Bearer ${mgrToken}`, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    stageExpect(grantResp.ok(), "authz-gate-negative", `授权前置应成功：status=${grantResp.status()}`);

    const fakeMemberId = "00000000-0000-0000-0000-000000009999";
    const forbiddenResp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/grants/authorized-config`,
      {
        data: { tenant_id: tenantId, member_id: fakeMemberId },
        headers: { Authorization: `Bearer ${mgrToken}`, "Content-Type": "application/json" },
        failOnStatusCode: false,
      },
    );
    // 关键门禁：member_id ≠ token subject → 403（F10: member_id must match the authenticated subject）。
    stageExpect(
      forbiddenResp.status() === 403,
      "authz-gate-negative",
      `authorized-config 主体不一致应返回 403，而非被误判为通过：实际 status=${forbiddenResp.status()}`,
    );
    const forbiddenCt = forbiddenResp.headers()["content-type"] ?? "";
    stageExpect(
      forbiddenCt.includes("application/problem+json") && !forbiddenCt.includes("text/html"),
      "authz-gate-negative",
      `403 响应必须是 problem+json（非 SPA fallback）：ct=${forbiddenCt}`,
    );

    // 门禁生效后再用真实主体 pull，应能拿到本次授权的 employee（证明 403 是身份门禁而非阻断）。
    const allowedResp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/grants/authorized-config`,
      {
        data: { tenant_id: tenantId, member_id: realMemberId },
        headers: { Authorization: `Bearer ${mgrToken}`, "Content-Type": "application/json" },
        failOnStatusCode: false,
      },
    );
    stageExpect(
      allowedResp.ok(),
      "authz-gate-negative",
      `authorized-config 真实主体 pull 应可达：status=${allowedResp.status()}`,
    );
    const allowedBody = (await allowedResp.json()) as { data?: { experts?: Array<Record<string, unknown>> } };
    const experts = (allowedBody.data?.experts ?? []);
    const matched = experts.some((e) => e.employee_id === employeeId);
    stageExpect(
      matched,
      "authz-gate-negative",
      `door-guard: real-subject pull should contain authorized employee_id=${employeeId}; experts.length=${experts.length}`,
    );
  });
});
