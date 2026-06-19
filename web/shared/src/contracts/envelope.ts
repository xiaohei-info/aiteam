/**
 * 北向 envelope 与统一错误模型（02 §10.3.4 / §11.2，D2/D10）。
 *
 * 本文件是 `server/shared/contracts/envelope.py` 的前端镜像（只对齐、禁另立）：
 * - 成功响应：单对象 Envelope；列表 ListEnvelope（带 page）。不得自造 {ok}/{success}。
 * - 错误响应：application/problem+json（Problem）。前端统一展示 `detail`，调试看 `request_id`。
 *
 * 任何字段变更须先改服务端契约源，再同步本镜像（CLAUDE.md §8 高风险共享口径）。
 */

/** 列表分页（02 §10.3.7）。对外只暴露 opaque/numeric cursor，禁内部 {ts}-{seq}。 */
export interface Page {
  next_cursor: string | null;
  has_more: boolean;
}

/** 单对象成功响应：{ data, meta? }（02 §10.3.4）。 */
export interface Envelope<T> {
  data: T | null;
  meta?: Record<string, unknown> | null;
}

/** 列表成功响应：{ data[], page, meta? }（02 §10.3.4）。 */
export interface ListEnvelope<T> {
  data: T[];
  page: Page;
  meta?: Record<string, unknown> | null;
}

/** problem+json 的字段级校验错误项（02 §11.2 errors[]）。 */
export interface ProblemFieldError {
  loc: Array<string | number>;
  message: string;
  type: string;
}

/**
 * application/problem+json 统一错误模型（02 §11.2，单一事实源）。
 *
 * `message` 不作顶层字段（用 detail）。错误体禁含密码/token/provider key/会话内容/raw event。
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string | null;
  instance?: string | null;
  request_id?: string | null;
  errors?: ProblemFieldError[] | null;
  meta?: Record<string, unknown> | null;
}
