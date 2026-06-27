import { test, expect } from "@playwright/test";
import { collectBrowserErrors, expectApiProblemJson, expectLoginPageSmoke } from "../support/smoke";

test("manager login shell and API contract smoke", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);

  await expectLoginPageSmoke(page, { tier: "manager", loginText: /企业|Manager|登录/i });
  await expectApiProblemJson(request, "manager");

  expect(browserErrors).toEqual([]);
});
