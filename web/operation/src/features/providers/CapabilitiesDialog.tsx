import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { CapabilitiesFields } from "./CapabilitiesFields";
import { capabilitiesToForm, formToCapabilitiesInput, type CapabilitiesForm } from "./channelForm";
import type { ModelCapabilitiesInput, PlatformModel } from "./types";

interface Props {
  model: PlatformModel;
  busy: boolean;
  onClose: () => void;
  onSave: (input: ModelCapabilitiesInput) => Promise<void>;
}

/** Context window, output cap, thinking levels and image input that the local Pi runtime uses for this model. */
export function CapabilitiesDialog({ model, busy, onClose, onSave }: Props) {
  const [form, setForm] = useState<CapabilitiesForm>(() => capabilitiesToForm(model));
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!busy) onClose(); };

  function submit() {
    const result = formToCapabilitiesInput(form);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    void onSave(result.value).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "保存失败"));
  }

  return (
    <Dialog isOpen purpose="form" width={600} aria-label="模型配置" onOpenChange={(open) => { if (!open) close(); }}>
      <Layout
        header={<DialogHeader title={`${model.model_id} · 模型配置`} onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              {error && <Banner status="error" title={error} />}
              <CapabilitiesFields modelId={model.model_id} form={form} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} />
              <Text type="supporting">保存后，员工下次同步配置时生效；已冻结的快照不受影响。</Text>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="取消" variant="ghost" onClick={close} isDisabled={busy} />
              <Button label="保存配置" variant="primary" onClick={submit} isLoading={busy} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
