/** Local conversation schedule configuration; execution state stays in the Pi event stream. */
import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";

import type { AgentApiClient } from "../../lib/api-client";
import type { Conversation } from "./useChatApi";
import { updateConversation } from "./useChatApi";

const MAX_PROMPT_LENGTH = 200_000;
const SCHEDULE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export type ScheduleMode = "one_shot" | "repeating";

export interface ScheduleDraft {
  scheduleId: string;
  revision: number;
  enabled: boolean;
  mode: ScheduleMode;
  at: string;
  intervalSeconds: number | null;
  promptTemplate: string;
}

export interface ScheduleControlProps {
  client: AgentApiClient;
  conversation: Conversation;
  onScheduleChanged: (conversation: Conversation) => void;
}

/** Validate the exact shape that the Agent schedule endpoint accepts. */
export function validateScheduleDraft(draft: ScheduleDraft): string | null {
  if (!SCHEDULE_ID_PATTERN.test(draft.scheduleId)) {
    return "调度 ID 必须是 1–128 个字母、数字或 . _ : - 字符。";
  }
  if (!Number.isInteger(draft.revision) || draft.revision < 1) {
    return "调度版本必须是正整数。";
  }
  if (draft.promptTemplate.trim().length === 0) {
    return "提示模板不能为空。";
  }
  if (draft.promptTemplate.length > MAX_PROMPT_LENGTH) {
    return "提示模板不能超过 200000 个字符。";
  }

  const at = draft.at.trim();
  if (!at || !ISO_TIMESTAMP_PATTERN.test(at) || !Number.isFinite(Date.parse(at))) {
    return "执行时间必须是带时区的 ISO 时间戳。";
  }

  if (draft.mode === "one_shot") {
    if (draft.intervalSeconds !== null) {
      return "一次性调度不能填写间隔秒数。";
    }
  } else if (draft.mode === "repeating") {
    if (draft.intervalSeconds === null || !Number.isInteger(draft.intervalSeconds) || draft.intervalSeconds < 1) {
      return "重复调度需要正整数间隔秒数。";
    }
  } else {
    return "调度类型无效。";
  }

  return null;
}

/** Build a canonical, allow-listed schedule payload after validation. */
export function buildSchedulePayload(draft: ScheduleDraft): Record<string, unknown> {
  const error = validateScheduleDraft(draft);
  if (error) throw new Error(error);

  const schedule: Record<string, unknown> = {
    schedule_id: draft.scheduleId,
    revision: draft.revision,
    enabled: draft.enabled,
    at: new Date(draft.at.trim()).toISOString(),
    one_shot: draft.mode === "one_shot",
    overlap: "skip",
    misfire: "skip",
    prompt_template: draft.promptTemplate,
  };
  if (draft.mode === "repeating") schedule.interval_seconds = draft.intervalSeconds;
  return schedule;
}

function intervalInputValue(intervalSeconds: number | null): string {
  return intervalSeconds === null ? "" : String(intervalSeconds);
}

function scheduleToDraft(schedule: Record<string, unknown> | null): ScheduleDraft {
  const revision = schedule?.revision;
  const interval = schedule?.interval_seconds;
  return {
    scheduleId: typeof schedule?.schedule_id === "string" ? schedule.schedule_id : "",
    revision: typeof revision === "number" && Number.isInteger(revision) && revision >= 1 ? revision : 1,
    enabled: schedule ? schedule.enabled !== false : true,
    mode: schedule ? (schedule.one_shot === true ? "one_shot" : "repeating") : "one_shot",
    at: typeof schedule?.at === "string" ? schedule.at : "",
    intervalSeconds: typeof interval === "number" && Number.isInteger(interval) && interval >= 1 ? interval : null,
    promptTemplate: typeof schedule?.prompt_template === "string" ? schedule.prompt_template : "",
  };
}

function updateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "没有权限修改此会话的调度配置。";
    if (error.status === 409) return "调度配置发生冲突，请刷新后重试。";
    if (error.status === 503) return "本地 Agent 服务暂不可用，请稍后重试。";
    if (error.status === 0) return "网络异常，调度配置未保存。";
    if (error.status === 422) return "调度配置无效，请检查填写内容。";
  }
  return "调度配置保存失败，请稍后重试。";
}

function currentScheduleText(schedule: Record<string, unknown>): { status: string; mode: string; at: string; interval: string; next: string } {
  const oneShot = schedule.one_shot === true;
  const at = typeof schedule.at === "string" ? schedule.at : "未设置";
  const interval = typeof schedule.interval_seconds === "number" ? `${schedule.interval_seconds} 秒` : "未设置";
  return {
    status: schedule.enabled === false ? "已禁用" : "已启用",
    mode: oneShot ? "一次性" : "重复",
    at,
    interval,
    next: oneShot ? `一次性 · ${at}` : `每 ${interval} · 起始 ${at}`,
  };
}

export function ScheduleControl({ client, conversation, onScheduleChanged }: ScheduleControlProps): React.ReactNode {
  const [draft, setDraft] = useState<ScheduleDraft>(() => scheduleToDraft(conversation.schedule));
  const [savedSchedule, setSavedSchedule] = useState<Record<string, unknown> | null>(() => conversation.schedule);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingClear, setPendingClear] = useState(false);
  const [intervalInput, setIntervalInput] = useState(() => intervalInputValue(draft.intervalSeconds));

  useEffect(() => {
    const nextDraft = scheduleToDraft(conversation.schedule);
    setDraft(nextDraft);
    setIntervalInput(intervalInputValue(nextDraft.intervalSeconds));
    setSavedSchedule(conversation.schedule);
    setError(null);
  }, [conversation.id, conversation.schedule]);

  async function saveSchedule(event: FormEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const intervalRaw = intervalInput.trim();
    const submittedDraft = draft.mode === "repeating"
      ? { ...draft, intervalSeconds: intervalRaw === "" ? null : Number(intervalRaw) }
      : { ...draft, intervalSeconds: null };
    const validationError = validateScheduleDraft(submittedDraft);
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    try {
      const updated = await updateConversation(client, conversation.id, { schedule: buildSchedulePayload(submittedDraft) });
      if (!updated) throw new Error("empty schedule update response");
      const nextDraft = scheduleToDraft(updated.schedule);
      setDraft(nextDraft);
      setIntervalInput(intervalInputValue(nextDraft.intervalSeconds));
      setSavedSchedule(updated.schedule);
      onScheduleChanged(updated);
    } catch (updateError) {
      setError(updateErrorMessage(updateError));
    } finally {
      setBusy(false);
    }
  }

  async function clearSchedule(): Promise<void> {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const updated = await updateConversation(client, conversation.id, { schedule: null });
      if (!updated) throw new Error("empty schedule clear response");
      setPendingClear(false);
      const nextDraft = scheduleToDraft(updated.schedule);
      setDraft(nextDraft);
      setIntervalInput(intervalInputValue(nextDraft.intervalSeconds));
      setSavedSchedule(updated.schedule);
      onScheduleChanged(updated);
    } catch (clearError) {
      setError(updateErrorMessage(clearError));
    } finally {
      setBusy(false);
    }
  }

  const current = savedSchedule ? currentScheduleText(savedSchedule) : null;
  const promptTooLong = draft.promptTemplate.length > MAX_PROMPT_LENGTH;

  return (
    <>
      <Card role="region" aria-label="会话调度" aria-busy={busy} data-testid="schedule-control">
        <VStack gap={3}>
          <HStack justify="between" align="center" wrap="wrap">
            <VStack gap={1}>
              <Heading level={2}>调度配置</Heading>
              <Text type="supporting">仅保存你明确配置的本地 Agent 调度提示，不上传会话内容。</Text>
            </VStack>
            {savedSchedule ? (
              <Button
                label="清除调度"
                variant="destructive"
                size="sm"
                isDisabled={busy}
                onClick={() => setPendingClear(true)}
                data-testid="schedule-clear"
              />
            ) : null}
          </HStack>

          {current ? (
            <VStack gap={1} role="group" aria-label="当前调度配置" data-testid="schedule-current">
              <Text type="label">当前配置</Text>
              <Text type="supporting">状态：{current.status} · 类型：{current.mode}</Text>
              <Text type="supporting">调度 ID：{typeof savedSchedule?.schedule_id === "string" ? savedSchedule.schedule_id : "未设置"}</Text>
              <Text type="supporting">执行时间：{current.at} · 间隔：{current.interval}</Text>
              <Text type="supporting" data-testid="schedule-next-config">下一次调度配置：{current.next}</Text>
            </VStack>
          ) : <Text type="supporting" data-testid="schedule-empty">暂无调度配置</Text>}

          {error ? <Banner status="error" title={error} data-testid="schedule-error" /> : null}
          {busy ? <Text role="status">正在保存调度配置…</Text> : null}

          <VStack as="form" gap={3} onSubmit={saveSchedule} aria-label="编辑调度配置">
            <Switch
              label="启用调度"
              description="关闭后保留配置，但本地调度器不会启动它。"
              value={draft.enabled}
              isDisabled={busy}
              isLoading={busy}
              onChange={(enabled) => setDraft((previous) => ({ ...previous, enabled }))}
            />
            <TextInput
              label="调度 ID"
              description="只允许字母、数字或 . _ : -，长度 1–128。"
              value={draft.scheduleId}
              isDisabled={busy}
              isRequired
              onChange={(scheduleId) => setDraft((previous) => ({ ...previous, scheduleId }))}
            />
            <Selector
              label="调度类型"
              options={[
                { value: "one_shot", label: "一次性" },
                { value: "repeating", label: "重复" },
              ]}
              value={draft.mode}
              isDisabled={busy}
              onChange={(mode) => {
                setDraft((previous) => ({
                  ...previous,
                  mode: mode as ScheduleMode,
                  intervalSeconds: mode === "one_shot" ? null : previous.intervalSeconds,
                }));
                setIntervalInput(mode === "one_shot" ? "" : intervalInputValue(draft.intervalSeconds));
              }}
            />
            <TextInput
              label="执行时间（ISO）"
              description="需要带时区，例如 2026-01-01T00:00:00Z。"
              placeholder="2026-01-01T00:00:00Z"
              value={draft.at}
              isDisabled={busy}
              isRequired
              onChange={(at) => setDraft((previous) => ({ ...previous, at }))}
            />
            <TextInput
              label="间隔秒数"
              description="重复调度必填；一次性调度不使用此项。"
              placeholder="3600"
              value={intervalInput}
              isDisabled={busy || draft.mode === "one_shot"}
              onChange={setIntervalInput}
            />
            <TextArea
              label="提示模板"
              description="调度器运行时使用的明确提示，不会读取或上传本会话内容。"
              value={draft.promptTemplate}
              maxLength={MAX_PROMPT_LENGTH}
              rows={5}
              isDisabled={busy}
              isRequired
              status={promptTooLong ? { type: "error", message: "提示模板不能超过 200000 个字符。" } : undefined}
              onChange={(promptTemplate) => setDraft((previous) => ({ ...previous, promptTemplate }))}
            />
            <HStack gap={2} wrap="wrap">
              <Button label="保存调度" type="submit" variant="primary" isDisabled={busy} isLoading={busy} />
            </HStack>
          </VStack>
        </VStack>
      </Card>
      <AlertDialog
        isOpen={pendingClear}
        onOpenChange={(open) => { if (!open && !busy) setPendingClear(false); }}
        title="清除调度配置"
        description={`清除会话「${conversation.title ?? conversation.id}」的调度配置后，本地调度器将不再使用它。`}
        cancelLabel="取消"
        actionLabel="确认清除"
        actionVariant="destructive"
        isActionLoading={busy}
        onAction={() => void clearSchedule()}
      />
    </>
  );
}
