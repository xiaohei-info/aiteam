/**
 * 运营端 api 聚合导出。
 *
 * 各 feature 从这里取 client 工厂与本端领域方法（按 OpenAPI operation_id 对齐）。
 * 脚手架阶段只暴露 factory + ping/whoami 探活，业务方法由 W-O.2/3/4 各自补。
 */
export { createOperationApiClient } from "./client.js";
export type { ApiClient } from "./client.js";
