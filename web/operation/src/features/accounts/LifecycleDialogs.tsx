import { useState, type ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { EnterpriseAccount, EnterpriseActionBody } from "./types";

export type LifecycleAction = "ban" | "unban" | "suspend" | "close" | "reactivate";

interface Props {
  action: LifecycleAction | null;
  enterprise: EnterpriseAccount;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (body: EnterpriseActionBody) => Promise<string | null>;
}

const ACTION_LABELS: Record<LifecycleAction, string> = {
  ban: "封禁",
  unban: "解封",
  suspend: "暂停",
  close: "注销",
  reactivate: "激活",
};

export function LifecycleDialogs({ action, enterprise, isSubmitting, onClose, onSubmit }: Props): ReactNode {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsReason = action === "suspend" || action === "close";
  const label = action ? ACTION_LABELS[action] : "";

  function close() {
    if (isSubmitting) return;
    setReason("");
    setConfirming(false);
    setError(null);
    onClose();
  }

  function continueToConfirmation() {
    if (action === "close" && !reason.trim()) {
      setError("必填字段未填写");
      return;
    }
    setError(null);
    setConfirming(true);
  }

  async function confirm() {
    if (!action) return;
    const body: EnterpriseActionBody = action === "suspend" || action === "close"
      ? { action, reason: reason.trim() }
      : { action };
    setError(null);
    const nextError = await onSubmit(body);
    if (nextError) {
      setError(nextError);
      return;
    }
    setReason("");
    setConfirming(false);
  }

  const reasonTitle = action ? `${label}${enterprise.enterprise_name}` : "";
  const confirmTitle = action && needsReason ? `确认${label}${enterprise.enterprise_name}` : reasonTitle;
  const description = action === "close"
    ? `注销后企业将无法继续使用服务。${error ? ` ${error}` : ""}`
    : action === "suspend"
      ? `暂停后企业将暂时无法使用服务。${error ? ` ${error}` : ""}`
      : `确定要${label}企业「${enterprise.enterprise_name}」吗？${error ? ` ${error}` : ""}`;

  return (
    <>
      {needsReason && (
        <Dialog
          isOpen={action != null && !confirming}
          onOpenChange={(open) => { if (!open) close(); }}
          purpose="form"
          width={480}
          aria-label={reasonTitle}
        >
          <Layout
            header={<DialogHeader title={reasonTitle} onOpenChange={(open) => { if (!open) close(); }} />}
            content={
              <LayoutContent>
                <VStack gap={4}>
                  <FormLayout>
                    <TextInput label="原因" value={reason} onChange={setReason} isOptional={action === "suspend"} isRequired={action === "close"} isDisabled={isSubmitting} />
                  </FormLayout>
                  {error && <Banner status="error" title={error} />}
                </VStack>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <HStack gap={2} hAlign="end">
                  <Button label="取消" variant="ghost" onClick={close} />
                  <Button label="继续" variant={action === "close" ? "destructive" : "secondary"} onClick={continueToConfirmation} />
                </HStack>
              </LayoutFooter>
            }
          />
        </Dialog>
      )}

      {error && confirming && <Banner status="error" title={error} />}
      <AlertDialog
        isOpen={action != null && (!needsReason || confirming)}
        onOpenChange={(open) => { if (!open) close(); }}
        title={confirmTitle}
        description={description}
        cancelLabel="取消"
        actionLabel={`确认${label}`}
        actionVariant={action === "unban" || action === "reactivate" ? "primary" : "destructive"}
        isActionLoading={isSubmitting}
        onAction={() => void confirm()}
      />
    </>
  );
}
