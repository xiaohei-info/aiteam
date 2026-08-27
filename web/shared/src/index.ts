/**
 * @aiteam/shared — AI Team v1 前端共享包（08 §12.2）。
 *
 * 各端共享业务与基础设施能力，禁止复制表现层组件：
 *   contracts / api-client / role-state / i18n / page-shell
 *
 * 也提供 subpath exports（见 package.json）：`@aiteam/shared/api-client` 等。
 */

export * from "./contracts/index.js";
export * from "./api-client/index.js";
export * from "./role-state/index.js";
export * from "./i18n/index.js";
export * from "./page-shell/index.js";
export * from "./theme/index.js";
