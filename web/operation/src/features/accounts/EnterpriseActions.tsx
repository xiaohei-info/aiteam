import { useRef, useState, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { useI18n } from "../../i18n/context";
import type { AccountsApi } from "./useAccountsApi";
import type { EnterpriseAccount, EnterpriseActionBody } from "./types";
import { RechargeDialog } from "./RechargeDialog";
import { NotificationDialog } from "./NotificationDialog";
import { QuotaDialog } from "./QuotaDialog";
import { LifecycleDialogs, type LifecycleAction } from "./LifecycleDialogs";

type ActionKind = EnterpriseActionBody["action"];

interface Props {
  api: AccountsApi;
  enterprise: EnterpriseAccount;
  onDone: () => void;
}

export function EnterpriseActions({ api, enterprise, onDone }: Props): ReactNode {
  const i18n = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [active, setActive] = useState<ActionKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const status = enterprise.operation_status ?? enterprise.status;
  const isClosed = status === "closed";
  const isBanned = status === "banned";
  const isSuspended = status === "suspended";

  async function runAction(body: EnterpriseActionBody): Promise<string | null> {
    setSubmitting(true);
    try {
      await api.doAction(enterprise.org_id, body);
      setActive(null);
      onDone();
      requestAnimationFrame(() => triggerRef.current?.focus());
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "操作失败";
    } finally {
      setSubmitting(false);
    }
  }

  const lifecycleActive = active === "ban" || active === "unban" || active === "suspend" || active === "close" || active === "reactivate"
    ? active
    : null;

  return (
    <>
      <DropdownMenu
        button={{ label: i18n.t("operation.accounts.actions"), size: "sm", variant: "ghost", ref: triggerRef }}
        data-testid={`actions-toggle-${enterprise.org_id}`}
        menuWidth={220}
      >
        <DropdownMenuItem label={i18n.t("operation.accounts.actions.recharge")} onClick={() => setActive("recharge")} />
        <DropdownMenuItem label={i18n.t("operation.accounts.actions.notify")} onClick={() => setActive("notify")} />
        {!isClosed && !isBanned && !isSuspended && (
          <DropdownMenuItem label={i18n.t("operation.lifecycle.suspend")} onClick={() => setActive("suspend")} />
        )}
        {!isClosed && (isBanned ? (
          <DropdownMenuItem label={i18n.t("operation.accounts.actions.unban")} onClick={() => setActive("unban")} />
        ) : (
          <DropdownMenuItem label={i18n.t("operation.lifecycle.ban")} onClick={() => setActive("ban")} />
        ))}
        {!isClosed && (isSuspended || isBanned) && (
          <DropdownMenuItem label={i18n.t("operation.lifecycle.reactivate")} onClick={() => setActive("reactivate")} />
        )}
        {!isClosed && (
          <DropdownMenuItem label={i18n.t("operation.lifecycle.close")} onClick={() => setActive("close")} />
        )}
        <DropdownMenuItem label={i18n.t("operation.accounts.actions.adjust_quota")} onClick={() => setActive("adjust_quota")} />
      </DropdownMenu>

      {active === "recharge" && (
        <RechargeDialog
          isOpen
          enterprise={enterprise}
          isSubmitting={submitting}
          onClose={() => setActive(null)}
          onSubmit={(amount, paymentMethod) => runAction({ action: "recharge", amount, payment_method: paymentMethod })}
        />
      )}
      {active === "notify" && (
        <NotificationDialog
          isOpen
          enterprise={enterprise}
          isSubmitting={submitting}
          onClose={() => setActive(null)}
          onSubmit={(message) => runAction({ action: "notify", message })}
        />
      )}
      {active === "adjust_quota" && (
        <QuotaDialog
          isOpen
          enterprise={enterprise}
          isSubmitting={submitting}
          onClose={() => setActive(null)}
          onSubmit={(quota) => runAction({ action: "adjust_quota", quota })}
        />
      )}
      {lifecycleActive && (
        <LifecycleDialogs
          action={lifecycleActive as LifecycleAction}
          enterprise={enterprise}
          isSubmitting={submitting}
          onClose={() => setActive(null)}
          onSubmit={(body) => runAction(body)}
        />
      )}
    </>
  );
}
