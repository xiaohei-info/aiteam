/**
 * @aiteam/shared — AI Team v1 前端共享包（08 §12.2）。
 *
 * 六大子能力，各端单一来源 import，禁止复制：
 *   contracts / api-client / timeline-client / role-state / i18n / design-system / page-shell
 *
 * 也提供 subpath exports（见 package.json）：`@aiteam/shared/api-client` 等。
 */

export * from "./contracts/index.js";
export * from "./api-client/index.js";
export * from "./timeline-client/index.js";
export * from "./role-state/index.js";
export * from "./i18n/index.js";
export * from "./design-system/index.js";
export * from "./page-shell/index.js";
