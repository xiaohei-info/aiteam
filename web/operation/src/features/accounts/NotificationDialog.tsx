import { useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/VStack";
import type { EnterpriseAccount } from "./types";

interface Props {
  isOpen: boolean;
  enterprise: EnterpriseAccount;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (message: string) => Promise<string | null>;
}

export function NotificationDialog({ isOpen, enterprise, isSubmitting, onClose, onSubmit }: Props): ReactNode {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (isSubmitting) return;
    setMessage("");
    setError(null);
    onClose();
  }

  async function submit() {
    const value = message.trim();
    if (!value) {
      setError("必填字段未填写");
      return;
    }
    setError(null);
    const nextError = await onSubmit(value);
    if (nextError) {
      setError(nextError);
      return;
    }
    setMessage("");
  }

  const title = `向${enterprise.enterprise_name}发送通知`;
  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => { if (!open) close(); }} purpose="form" width={520} aria-label={title}>
      <Layout
        header={<DialogHeader title={title} onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <FormLayout>
                <TextArea label="通知内容" value={message} onChange={setMessage} rows={5} isRequired isDisabled={isSubmitting} />
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
