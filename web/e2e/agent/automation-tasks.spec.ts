import { expect } from "@playwright/test";
import { authTest as test } from "../support/fixtures";
import { seededEmployeeId, TIER_BASE_URL } from "../support/auth";

test("任务页管理真实日历调度，暂停后保留会话，删除后保留运行入口", async ({ authedPage: page, authedRequest }) => {
  const employeeId = seededEmployeeId();
  expect(employeeId, "requires the real seeded authorized employee").toBeTruthy();
  const name = `自动化 E2E ${Date.now()}`;
  let taskId: string | undefined;
  let conversationId: string | undefined;
  try {
    await page.goto(`${TIER_BASE_URL.agent}/tasks`);
    await expect(page.getByRole("heading", { name: "自动化任务", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByLabel("名称", { exact: true }).fill(name);
    await page.getByLabel("执行指令", { exact: true }).fill("汇总本地任务进度");
    await expect(page.getByLabel("执行员工").locator(`option[value="${employeeId}"]`)).toBeAttached();
    await page.getByLabel("执行员工").selectOption(employeeId!);
    await page.getByLabel("执行频率").selectOption("monthly");
    await page.getByLabel(/^每月日期/).fill("31");
    const response = page.waitForResponse(res => res.url().endsWith("/api/agent/automation-tasks") && res.request().method() === "POST");
    await page.getByRole("button", { name: "保存任务" }).click();
    const created = await response; expect(created.status()).toBe(201);
    const task = (await created.json()).data;
    taskId = task.task_id; conversationId = task.conversation_id;
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(page.getByRole("button", { name: "启用", exact: true })).toBeVisible();
    const conversation = await authedRequest.get(`/api/agent/conversations/${conversationId}`);
    expect(conversation.ok()).toBeTruthy();
    expect((await conversation.json()).data.schedule.enabled).toBe(false);
    await page.getByRole("button", { name: "删除任务", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    expect((await authedRequest.get(`/api/agent/conversations/${conversationId}`)).ok()).toBeTruthy();
    expect((await authedRequest.get(`/api/agent/automation-tasks/${taskId}/runs?include_deleted=true`)).ok()).toBeTruthy();
  } finally {
    if (taskId) {
      const task = await authedRequest.get(`/api/agent/automation-tasks/${taskId}`);
      if (task.ok()) await authedRequest.delete(`/api/agent/automation-tasks/${taskId}`, { headers: { "If-Match": (await task.json()).data.etag } });
    }
    if (conversationId) await authedRequest.delete(`/api/agent/conversations/${conversationId}`);
  }
});
