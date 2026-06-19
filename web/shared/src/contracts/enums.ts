/**
 * 枚举口径镜像（冻结）。来源 `server/shared/contracts/enums.py`，只对齐、禁重声明值集。
 *
 * - 会话主状态 / 展示态：07 §8（展示态不写入持久化主状态）。
 * - 角色枚举：03 §9.7（禁用旧 admin/manager/viewer）。
 * - 隔离档位：04 §6.1.1；provider：03 §9.3。
 *
 * 用 `as const` 对象 + 派生联合类型，既给运行期取值集合（供断言测试），又给编译期类型。
 */

/** Conversation 持久化主状态（固定枚举，07 §8）。 */
export const ConversationState = {
  DRAFT: "draft",
  ACTIVE: "active",
  PAUSED: "paused",
  MUTED: "muted",
  ARCHIVED: "archived",
} as const;
export type ConversationState =
  (typeof ConversationState)[keyof typeof ConversationState];

/** 会话展示态（07 §8）。**不写入持久化主状态**，仅前端/运行态镜像使用。 */
export const DisplayState = {
  IDLE: "idle",
  ROUTING: "routing",
  WAITING_REPLY: "waiting_reply",
  STREAMING: "streaming",
  BUSY: "busy",
  RESOLVED: "resolved",
  RECONNECTING: "reconnecting",
} as const;
export type DisplayState = (typeof DisplayState)[keyof typeof DisplayState];

/** 企业侧角色（03 §9.7）。禁用旧 admin/manager/viewer。 */
export const EnterpriseRole = {
  OWNER: "owner",
  ENTERPRISE_ADMIN: "enterprise_admin",
  FINANCE_ADMIN: "finance_admin",
  MEMBER: "member",
} as const;
export type EnterpriseRole = (typeof EnterpriseRole)[keyof typeof EnterpriseRole];

/** 平台侧角色（03 §9.7）。 */
export const PlatformRole = {
  SYSTEM_ADMIN: "system_admin",
  SYSTEM_OPERATOR: "system_operator",
} as const;
export type PlatformRole = (typeof PlatformRole)[keyof typeof PlatformRole];

/** 登录方式（03 §9.3）。 */
export const AuthProvider = {
  PASSWORD: "password",
  PHONE: "phone",
  WECHAT: "wechat",
} as const;
export type AuthProvider = (typeof AuthProvider)[keyof typeof AuthProvider];

/** Manager 租户隔离档位（04 §6.1.1，D20）。 */
export const IsolationLevel = {
  L1_SHARED_RLS: "l1_shared_rls",
  L2_SCHEMA_PER_TENANT: "l2_schema_per_tenant",
  L3_DB_PER_TENANT: "l3_db_per_tenant",
} as const;
export type IsolationLevel = (typeof IsolationLevel)[keyof typeof IsolationLevel];
