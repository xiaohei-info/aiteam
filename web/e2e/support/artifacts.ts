/**
 * P1-F5 Browser E2E artifact 基线（最终执行 DAG §5.1 P1-F5、§8 诊断路径）。
 *
 * 单一事实源：失败时产出 report / trace / screenshot / video 的命名与目录在此集中定义，
 * playwright.config.ts 与各 spec 共用，避免命名漂移导致 CI artifact 路径对不上（DAG BE2E-Artifact-DI）。
 *
 * 铁律（DAG §10 非目标）：截图 / trace / video 只作失败诊断材料，**不作成功断言**。
 */

import type { PlaywrightTestConfig, TestInfo } from "@playwright/test";

/** Playwright HTML report 目录（失败可 `npx playwright show-report`）。 */
export const REPORT_DIR = "playwright-report";

/** 单测 artifact（trace.zip / screenshot.png / video.webm）输出根目录。 */
export const ARTIFACT_OUTPUT_DIR = "test-results";

type UseArtifacts = NonNullable<PlaywrightTestConfig["use"]>;

/**
 * 失败诊断 artifact 基线：trace / screenshot / video 仅在失败时保留。
 * 成功用例不产 artifact（省 CI 存储，且杜绝"截图当成功证据"）。
 */
export function artifactUse(): Pick<UseArtifacts, "trace" | "screenshot" | "video"> {
  return {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  };
}

/**
 * reporter 基线：CI 出 HTML report（不自动打开）+ list；本地仅 list。
 * HTML report 内嵌失败用例的 trace/screenshot/video 链接，是 DAG §8 Browser 层诊断入口。
 */
export function artifactReporter(isCI: boolean): PlaywrightTestConfig["reporter"] {
  return isCI
    ? [["html", { outputFolder: REPORT_DIR, open: "never" }], ["list"]]
    : "list";
}

/**
 * 统一 artifact 文件名：`<project>__<sanitized-title>.<ext>`。
 * 供 spec 内手动 `testInfo.attach`/落盘时命名一致，便于按 project/用例定位。
 */
export function artifactName(testInfo: Pick<TestInfo, "title" | "project">, ext: string): string {
  const project = slugify(testInfo.project?.name ?? "unknown") || "unknown";
  const slug = slugify(testInfo.title);
  const clean = ext.startsWith(".") ? ext.slice(1) : ext;
  return `${project}__${slug}.${clean}`;
}

/** 统一 slug 清洗：小写、非字母数字折叠为 `-`、去首尾 `-`、限长。project 与 title 共用。 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** 判断本次运行是否产出了失败 artifact（失败 + 配置保留）——供 DI 自检，不作成功断言。 */
export function expectsFailureArtifacts(status: TestInfo["status"]): boolean {
  return status === "failed" || status === "timedOut";
}
