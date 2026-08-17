/**
 * 前端契约镜像聚合（Single Source of Truth = `server/shared/contracts/`）。
 *
 * 防跑偏铁律：各端只 import 本模块的类型，禁止自定义平行 DTO / 事件名 / cursor / 枚举。
 * 本模块只镜像**前端可见**的契约子集；服务端契约变更须先改 .py 源、再同步本镜像。
 */

export type {
  Page,
  Envelope,
  ListEnvelope,
  Problem,
  ProblemFieldError,
} from "./envelope.js";

export {
  ConversationState,
  DisplayState,
  EnterpriseRole,
  PlatformRole,
  AuthProvider,
  IsolationLevel,
} from "./enums.js";

export type { ConversationEntries, PiEntry, PiEvent, PiEventEnvelope } from "./events.js";

export type { TokenClaims, UserPrincipal, AuthSession } from "./auth.js";
