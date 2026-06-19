/**
 * api-client 错误模型（对齐 02 §11.2 problem+json）。
 *
 * 网络/解析失败也归一成 ApiError，使调用方只需 catch 一种错误类型——
 * 消除「HTTP 错误 vs 网络错误 vs 解析错误」的多分支特殊情况。
 */

import type { Problem } from "../contracts/envelope.js";

/** 统一前端 API 错误。`problem` 在服务端返回 problem+json 时存在。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem?: Problem;
  readonly requestId?: string;

  constructor(message: string, status: number, code: string, problem?: Problem) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (problem) {
      this.problem = problem;
      if (problem.request_id) {
        this.requestId = problem.request_id;
      }
    }
  }

  /** 由后端 problem+json 构造（前端统一展示 detail，回退 title）。 */
  static fromProblem(problem: Problem): ApiError {
    const message = problem.detail ?? problem.title ?? "请求失败";
    return new ApiError(message, problem.status, problem.code, problem);
  }

  /** 网络层失败（无 HTTP 响应）。 */
  static network(detail: string): ApiError {
    return new ApiError(detail, 0, "network_error");
  }

  /** 响应非 problem+json 且非成功 envelope（契约破损）。 */
  static malformed(status: number, detail: string): ApiError {
    return new ApiError(detail, status, "malformed_response");
  }
}
