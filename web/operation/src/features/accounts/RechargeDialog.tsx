import { useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { VStack } from "@astryxdesign/core/VStack";
import type { EnterpriseAccount } from "./types";

interface Props {
  isOpen: boolean;
  enterprise: EnterpriseAccount;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (amount: string, paymentMethod: string) => Promise<string | null>;
}

const PAYMENT_OPTIONS = [
  { value: "bank", label: "银行转账" },
  { value: "alipay", label: "支付宝" },
  { value: "wechat", label: "微信支付" },
];

export function RechargeDialog({ isOpen, enterprise, isSubmitting, onClose, onSubmit }: Props): ReactNode {
  const [amount, setAmount] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState("bank");
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (isSubmitting) return;
    setAmount(null);
    setPaymentMethod("bank");
    setError(null);
    onClose();
  }

  async function submit() {
    if (amount == null || amount <= 0 || !paymentMethod) {
      setError("必填字段未填写");
      return;
    }
    setError(null);
    const nextError = await onSubmit(String(amount), paymentMethod);
    if (nextError) {
      setError(nextError);
      return;
    }
    setAmount(null);
    setPaymentMethod("bank");
  }

  const title = `为${enterprise.enterprise_name}充值`;
  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => { if (!open) close(); }} purpose="form" width={480} aria-label={title}>
      <Layout
        header={<DialogHeader title={title} onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <FormLayout>
                <NumberInput label="充值金额" value={amount} onChange={setAmount} min={0} step={0.01} isRequired isDisabled={isSubmitting} />
                <Selector label="支付方式" value={paymentMethod} onChange={setPaymentMethod} options={PAYMENT_OPTIONS} isRequired isDisabled={isSubmitting} />
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
