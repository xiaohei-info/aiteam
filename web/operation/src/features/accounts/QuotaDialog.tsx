import { useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { EnterpriseAccount } from "./types";

interface Props {
  isOpen: boolean;
  enterprise: EnterpriseAccount;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (quota: string) => Promise<string | null>;
}

export function QuotaDialog({ isOpen, enterprise, isSubmitting, onClose, onSubmit }: Props): ReactNode {
  const [quota, setQuota] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (isSubmitting) return;
    setQuota(null);
    setError(null);
    onClose();
  }

  async function submit() {
    if (quota == null || quota < 0) {
      setError("必填字段未填写");
      return;
    }
    setError(null);
    const nextError = await onSubmit(String(quota));
    if (nextError) {
      setError(nextError);
      return;
    }
    setQuota(null);
  }

  const title = `调整${enterprise.enterprise_name}配额`;
  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => { if (!open) close(); }} purpose="form" width={480} aria-label={title}>
      <Layout
        header={<DialogHeader title={title} onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <FormLayout>
                <NumberInput label="新配额" value={quota} onChange={setQuota} min={0} step={1} isRequired isDisabled={isSubmitting} />
              </FormLayout>
              {error && <Banner status="error" title={error} />}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="取消" variant="ghost" onClick={close} isDisabled={isSubmitting} />
              <Button label="确认" onClick={() => void submit()} isLoading={isSubmitting} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
