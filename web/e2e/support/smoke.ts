import { expect, type Page, type APIRequestContext } from "@playwright/test";

export type TierSmoke = {
  tier: "operation" | "manager" | "agent";
  loginText: RegExp;
};

export function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  return errors;
}

export async function expectLoginPageSmoke(page: Page, smoke: TierSmoke): Promise<void> {
  await page.goto("/login");
  await expect(page.getByText(smoke.loginText).first()).toBeVisible();
}

export async function expectApiProblemJson(request: APIRequestContext, tier: TierSmoke["tier"]): Promise<void> {
  const response = await request.get(`/api/${tier}/__missing_route__`);
  const contentType = response.headers()["content-type"] ?? "";
  expect(response.status()).toBe(404);
  expect(contentType).toContain("application/problem+json");
  expect(contentType).not.toContain("text/html");
  expect((await response.text()).toLowerCase()).not.toContain("<!doctype html");
}
