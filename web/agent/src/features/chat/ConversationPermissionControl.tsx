import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import type { AgentApiClient } from "../../lib/api-client";
import { updateConversation, type Conversation, type ConversationPermissionMode } from "./useChatApi";

const MODES: Array<{ value: ConversationPermissionMode; label: string; description: string }> = [
  { value: "read-only", label: "只读", description: "可读取和分析本地工作区，禁止写入，网络关闭。" },
  { value: "workspace-write", label: "工作区可写", description: "可修改当前会话工作区，不能访问 Agent 数据目录，网络仍关闭。" },
  { value: "full-access", label: "完全访问", description: "解除本地 sandbox，可访问文件系统和网络。仅在可信任务中使用。" },
];

export interface ConversationPermissionControlProps {
  client: AgentApiClient;
  conversation: Conversation;
  onChanged: (conversation: Conversation) => void;
}

export function ConversationPermissionControl({ client, conversation, onChanged }: ConversationPermissionControlProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ConversationPermissionMode>(conversation.permission_mode ?? "read-only");
  const [fullAccessConfirmed, setFullAccessConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode(conversation.permission_mode ?? "read-only");
    setFullAccessConfirmed(false);
  }, [conversation.id, conversation.permission_mode]);

  const current = MODES.find((item) => item.value === (conversation.permission_mode ?? "read-only")) ?? MODES[0]!;

  async function save(): Promise<void> {
    if (mode === "full-access" && !fullAccessConfirmed) {
      setError("请先确认完全访问风险，再保存权限");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateConversation(client, conversation.id, { permission_mode: mode });
      if (updated) onChanged(updated);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "权限设置保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        label={`运行权限：${current.label}`}
        tooltip="设置本会话的本地执行权限"
        variant="ghost"
        size="sm"
        onClick={() => { setError(null); setFullAccessConfirmed(false); setMode(conversation.permission_mode ?? "read-only"); setOpen(true); }}
      />
      <Dialog
        isOpen={open}
        purpose="form"
        width={520}
        aria-label="运行权限"
        onOpenChange={(next) => { if (!next && !saving) setOpen(false); }}
      >
        <VStack gap={4}>
          <DialogHeader title="运行权限" onOpenChange={(next) => { if (!next && !saving) setOpen(false); }} />
          <Text type="supporting">权限只作用于当前会话；群聊会同时作用于协调者和群成员的本地 Session。</Text>
          <FormLayout>
            <Selector
              label="权限档位"
              options={MODES.map(({ value, label }) => ({ value, label }))}
              value={mode}
              onChange={(value) => { setError(null); setFullAccessConfirmed(false); setMode(value as ConversationPermissionMode); }}
              isDisabled={saving}
            />
          </FormLayout>
          <Text type="supporting">{MODES.find((item) => item.value === mode)?.description}</Text>
          {mode === "full-access" ? (
            <>
              <Banner
                status="warning"
                title="完全访问风险"
                description="该模式会解除文件系统和网络隔离，并跳过本地 sandbox。只对可信任务启用。"
              />
              <CheckboxInput
                label="我确认仅在可信任务中启用完全访问"
                description="启用后，本会话中的 Agent 可访问文件系统和网络。"
                value={fullAccessConfirmed}
                onChange={setFullAccessConfirmed}
                isDisabled={saving}
              />
            </>
          ) : null}
          {error ? <Banner status="error" title={error} /> : null}
          <HStack justify="end" gap={2}>
            <Button label="取消" variant="ghost" onClick={() => setOpen(false)} isDisabled={saving} />
            <Button label="保存权限" variant="primary" onClick={() => void save()} isLoading={saving} />
          </HStack>
        </VStack>
      </Dialog>
    </>
  );
}
