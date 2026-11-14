/** 复制专家：只问新名称；源专家没有可用模型时才多问一个模型。复制成功后由父组件直接打开编辑抽屉。 */
import { useRef, useState, type ReactNode } from "react";
import { ApiError, newIdempotencyKey } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { ModelPicker } from "../platform-models/ModelPicker";
import { choiceKey, toPolicy, useRecruitModels } from "../platform-models/useRecruitModels";
import type { EmployeeConfig } from "./types";
import type { ExpertsApi } from "./useExpertsApi";

interface Props {
  api: ExpertsApi;
  source: EmployeeConfig;
  onClose: () => void;
  onCopied: (copy: EmployeeConfig) => void;
}

const MODEL_ERRORS = new Set(["model_required", "model_unavailable"]);

export function CopyExpertDialog({ api, source, onClose, onCopied }: Props): ReactNode {
  const models = useRecruitModels();
  const sourceModel = source.model_policy;
  const sourceKey = sourceModel.provider_ref && sourceModel.model ? choiceKey(sourceModel.provider_ref, sourceModel.model) : undefined;
  // 源专家的模型仍可用就沿用；没有或已不可用时才让用户选。
  const needsModel = !models.loading && (!sourceKey || !models.choices.some((choice) => choice.key === sourceKey));

  const [name, setName] = useState(`${source.display_name || "未命名专家"} - 副本`);
  const [modelKey, setModelKey] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forcePick, setForcePick] = useState(false);
  // 幂等键只用于「没收到响应」时原样重试；内容变了或服务端已答复，下次提交换新键。
  const attempt = useRef<{ body: string; key: string } | null>(null);

  const showPicker = needsModel || forcePick;
  const trimmed = name.trim();

  async function submit(): Promise<void> {
    if (trimmed.length > 64) {
      setError("名称不超过 64 个字");
      return;
    }
    const choice = models.choices.find((item) => item.key === modelKey);
    if (showPicker && !choice) {
      setError("请先选择一个可用模型");
      return;
    }
    const body = {
      display_name: trimmed,
      ...(showPicker && choice ? { model_policy: toPolicy(choice) } : {}),
    };
    const signature = JSON.stringify(body);
    if (attempt.current?.body !== signature) attempt.current = { body: signature, key: newIdempotencyKey() };
    setBusy(true);
    setError(null);
    try {
      const copy = await api.copyEmployee(source.employee_id, body, attempt.current.key);
      if (copy) onCopied(copy);
    } catch (err) {
      // 服务端有答复（status > 0）才换键；共享客户端把网络失败包成 status=0 的 network_error，此时保留原键重试。
      if (err instanceof ApiError && err.status !== 0) attempt.current = null;
      if (err instanceof ApiError && MODEL_ERRORS.has(err.code)) setForcePick(true);
      setError(err instanceof ApiError ? err.message : "复制失败，请稍后重试");
      setBusy(false);
    }
  }

  const close = () => { if (!busy) onClose(); };

  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) close(); }} purpose="form" width={460} aria-label="复制专家">
      <Layout
        header={<DialogHeader title="复制专家" onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Text color="secondary">
                将带走提示词、技能、知识和连接器配置；不会带走成员授权和个人记忆，复制后需重新授权并上线。
              </Text>
              <TextInput label="新专家名称" value={name} onChange={setName} isRequired isDisabled={busy} />
              {showPicker && (
                <ModelPicker
                  label="模型"
                  choices={models.choices}
                  loading={models.loading}
                  value={modelKey}
                  onChange={setModelKey}
                  isDisabled={busy}
                  testId="copy-model"
                />
              )}
              {error && <Banner status="error" title={error} />}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="取消" variant="ghost" onClick={close} isDisabled={busy} />
              <Button
                label="复制"
                variant="primary"
                onClick={() => void submit()}
                isLoading={busy}
                isDisabled={!trimmed || models.loading}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
