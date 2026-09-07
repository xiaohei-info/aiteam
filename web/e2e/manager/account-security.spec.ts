import { expect, test } from "@playwright/test";

test("Manager password session, factor enrollment, logout, Passkey login and removal use real routes", async ({ page, context }) => {
  const enterprise = process.env.E2E_FACTOR_ENTERPRISE;
  const account = process.env.E2E_FACTOR_ACCOUNT;
  const password = process.env.E2E_FACTOR_PASSWORD;
  if (!enterprise || !account || !password) throw new Error("account-security requires this run's isolated synthetic factor identity");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  try {
    await page.goto("/login");
    await page.getByLabel("企业代码/名称").fill(enterprise);
    await page.getByLabel("成员账号").fill(account);
    await page.getByLabel("登录密码", { exact: true }).fill(password);
    const login = page.waitForResponse((response) => response.url().endsWith("/api/auth/login"));
    await page.getByRole("button", { name: "登录", exact: true }).click();
    expect((await login).status()).toBe(200);
    await expect(page).not.toHaveURL(/\/login$/);
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "账号安全" })).toBeVisible();
    const enrolled = page.waitForResponse((response) => response.url().endsWith("/api/manager/passkeys") && response.request().method() === "POST");
    await page.getByRole("button", { name: "添加 Passkey" }).click();
    expect((await enrolled).status()).toBe(200);
    await expect(page.getByRole("button", { name: "删除 浏览器 Passkey" })).toBeVisible();
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem("aiteam.manager.token"))).toBeNull();
    await page.getByLabel("企业代码/名称").fill(enterprise);
    await page.getByLabel("成员账号").fill(account);
    const assertion = page.waitForResponse((response) => response.url().endsWith("/api/auth/passkey/login"));
    await page.getByRole("button", { name: "使用 Passkey 登录" }).click();
    expect((await assertion).status()).toBe(200);
    await expect(page).not.toHaveURL(/\/login$/);
    await page.goto("/settings");
    const removed = page.waitForResponse((response) => response.url().includes("/api/manager/passkeys/") && response.request().method() === "DELETE");
    await page.getByRole("button", { name: "删除 浏览器 Passkey" }).click();
    expect((await removed).status()).toBe(200);
    await expect(page.getByRole("button", { name: "删除 浏览器 Passkey" })).toHaveCount(0);
  } finally {
    if (!page.isClosed()) {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
      await cdp.detach();
    }
  }
});
