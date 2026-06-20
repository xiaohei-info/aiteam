/**
 * 企业端 api 聚合导出。
 *
 * 各 feature 从这里取 client 工厂与本端领域方法（按 OpenAPI operation_id 对齐）。
 * 脚手架阶段只暴露 factory，业务方法由后续卡（成员/专家/授权/治理）各自补。
 */
export { createManagerApiClient } from "./client.js";
export type { ApiClient } from "./client.js";
