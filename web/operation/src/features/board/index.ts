/**
 * 跨企业治理看板 feature（W-O.4）。
 *
 * 暴露组件与 API hook；外部只通过本 barrel 引用。
 */
export { BoardPage } from "./BoardPage.js";
export { EnterpriseDetailPage } from "./EnterpriseDetailPage.js";
export { OverviewCards } from "./OverviewCards.js";
export { useBoardApi } from "./useBoardApi.js";
export type {
  RollupBoard,
  EnterpriseRollup,
  AuditSummary,
  BoardApi,
} from "./useBoardApi.js";
