import { useRef, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { AgentApiClient } from "../../lib/api-client";
import { decideApproval, makeIdempotencyKey, type ApprovalDecision, type ApprovalRecord, type ApprovalRiskLevel, type ApprovalStatus } from "./useChatApi";

const RISK_LABELS: Record<ApprovalRiskLevel, string> = {
  bash: "命令执行",
  write: "文件写入",
  edit: "文件编辑",
  external: "外部副作用",
  unknown: "未知副作用",
};

const INLINE_SECRET = /(?:bearer\s+|basic\s+|(?:sk|pk|rk)-)[a-z0-9._~+/=-]+|(?:token|secret|password|api[ _-]?key)\s*[:=]\s*[^\s,;]+/gi;
const INLINE_PATH = /(?:file:\/\/)?\/(?:Users|private|home|tmp|var|workspace|etc|root|opt|srv|usr)(?:\/[^\s"'<>]*)*|[A-Za-z]:\\[^\s"'<>]*/gi;

const STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: "待审批",
  approved: "已批准",
  executing: "执行中",
  succeeded: "已完成",
  rejected: "已拒绝",
  invalidated: "已失效",
  expired: "已过期",
  uncertain: "结果未知",
};

export interface ApprovalCardProps {
  client: AgentApiClient;
  approval: ApprovalRecord;
  onUpdated: (approval: ApprovalRecord) => void;
  onRefresh?: () => void | Promise<void>;
}

/**
 * Human approval UI for the owner-scoped projection. The browser only submits
 * the decision, expected CAS revision, and an idempotency key; it never echoes
 * canonical_args_hmac or the complete tool arguments.
 */
export function ApprovalCard({ client, approval, onUpdated, onRefresh }: ApprovalCardProps): ReactNode {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decisionKeys = useRef(new Map<ApprovalDecision, string>());
  const canDecide = approval.status === "pending" && !approval.consumed;
  const summary = safeSummary(approval.redacted_summary.trim()) || "本地工具调用需要人工确认";
  const status = STATUS_LABELS[approval.status] ?? approval.status;
  const risk = RISK_LABELS[approval.risk_level] ?? "未知副作用";

  async function decide(decision: ApprovalDecision): Promise<void> {
    if (!canDecide || busy) return;
    setBusy(decision);
    setError(null);
    const idempotencyKey = decisionKeys.current.get(decision) ?? makeIdempotencyKey();
    decisionKeys.current.set(decision, idempotencyKey);
    try {
      const updated = await decideApproval(
        client,
        approval.conversation_id,
        approval.id,
        decision,
        approval.decision_revision,
        idempotencyKey,
      );
      onUpdated(updated);
    } catch (cause) {
      setError(approvalErrorMessage(cause));
      if (isApprovalRefreshError(cause)) {
        decisionKeys.current.delete(decision);
        try {
          await onRefresh?.();
        } catch {
          // Keep the owner-safe decision error when the follow-up read also fails.
        }
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      data-testid={`approval-card-${approval.id}`}
      data-approval-status={approval.status}
      data-risk-level={approval.risk_level}
      role="article"
      aria-label={`审批请求：${risk}`}
    >
      <VStack gap={2}>
        <HStack justify="between" align="center" gap={2}>
          <Text weight="semibold">需要人工审批</Text>
          <Text type="supporting" data-testid="approval-status">{status}</Text>
        </HStack>
        <Text type="supporting">风险类型：{risk}</Text>
        <Text data-testid="approval-redacted-summary">{summary}</Text>
        <Text type="supporting">有效期至：{formatExpiry(approval.expires_at)}</Text>
        {approval.status === "uncertain" ? (
          <Banner status="warning" title="执行结果未知" description="请查看本机会话记录；不会自动重放或重复执行。" />
        ) : null}
        {error ? <Banner status="error" title={error} role="alert" /> : null}
        {canDecide ? (
          <HStack gap={2} justify="end">
            <Button
              label="拒绝"
              variant="secondary"
              isDisabled={busy !== null}
              isLoading={busy === "deny"}
              onClick={() => void decide("deny")}
            />
            <Button
              label="批准"
              variant="primary"
              isDisabled={busy !== null}
              isLoading={busy === "approve"}
              onClick={() => void decide("approve")}
            />
          </HStack>
        ) : null}
      </VStack>
    </Card>
  );
}

export function approvalErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === "approval_not_found" || cause.status === 404) return "审批已不存在或当前账号无权查看";
    if (cause.code === "approval_expired") return "审批已过期，请重新发起操作";
    if (cause.code === "approval_conflict" || cause.status === 409) return "审批状态已变化，正在刷新最新状态";
    if (cause.status === 401) return "登录状态已失效，请重新登录";
    if (cause.status === 403) return "当前账号无权决定此审批";
    if (cause.message) return cause.message;
  }
  return cause instanceof Error && cause.message ? cause.message : "审批操作失败，请稍后查看本地状态";
}

function isApprovalRefreshError(cause: unknown): boolean {
  return cause instanceof ApiError
    && (cause.code === "approval_not_found" || cause.code === "approval_expired" || cause.code === "approval_conflict" || cause.status === 404 || cause.status === 409);
}

function safeSummary(value: string): string {
  return value.replace(INLINE_SECRET, "[已隐藏]").replace(INLINE_PATH, "[路径已隐藏]").slice(0, 1_200);
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString("zh-CN", { hour12: false });
}
