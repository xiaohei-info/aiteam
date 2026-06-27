import { test, expect } from "@playwright/test";
import { collectBrowserErrors, expectApiProblemJson, expectLoginPageSmoke } from "../support/smoke";

test("operation login shell and API contract smoke", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);

  await expectLoginPageSmoke(page, { tier: "operation", loginText: /运营|Operator|登录/i });
  await expectApiProblemJson(request, "operation");

  expect(browserErrors).toEqual([]);
});
