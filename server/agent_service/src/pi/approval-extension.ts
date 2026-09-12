import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ApprovalService, approvalRiskForTool, type ApprovalRequest } from "../approval-service.js";

export { ApprovalService, approvalRiskForTool, canonicalArgsHmac } from "../approval-service.js";
export type { ApprovalRequest, ApprovalRisk } from "../approval-service.js";

/**
 * Adapt a Pi ToolDefinition to the Agent approval gate without introducing a
 * second executor. SessionHost supplies the request fields and keeps the
 * original tool implementation as the only operation callback.
 */
export function withApprovalGate<T extends ToolDefinition>(
  tool: T,
  service: ApprovalService,
  request: (toolCallId: string, params: unknown, signal?: AbortSignal) => ApprovalRequest | undefined,
): T {
  const risk = approvalRiskForTool(tool.name);
  if (!risk) return tool;
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, context) => {
      const approval = request(toolCallId, params, signal);
      if (!approval) return execute(toolCallId, params, signal, onUpdate, context);
      return service.execute({ ...approval, riskLevel: approval.riskLevel ?? risk }, () => execute(toolCallId, params, signal, onUpdate, context));
    },
  } as T;
}

export const createApprovalGate = withApprovalGate;
