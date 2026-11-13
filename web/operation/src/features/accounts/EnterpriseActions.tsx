import { useRef, useState, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { PlatformRole, hasRole } from "@aiteam/shared";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import type { AccountsApi } from "./useAccountsApi";
import type { EnterpriseAccount, EnterpriseActionBody } from "./types";
import { RechargeDialog } from "./RechargeDialog";
import { NotificationDialog } from "./NotificationDialog";
import { QuotaDialog } from "./QuotaDialog";
import { LifecycleDialogs, type LifecycleAction } from "./LifecycleDialogs";
import { EnterpriseModelAccessDialog } from "./EnterpriseModelAccessDialog";
import { ResetOwnerDialog } from "./ResetOwnerDialog";
import { EnterpriseProfileDialog } from "./EnterpriseProfileDialog";
import { DeletionDialog, type DeletionMode } from "./DeletionDialog";

/** 保留期（天），与服务端一致。 */
const RETENTION_DAYS = 30;

type ActionKind = EnterpriseActionBody["action"] | "model_access" | "reset_owner" | "profile" | DeletionMode;

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
  const isDeleting = status === "deleting";
  const isDeleted = status === "deleted";
  const { session } = useSession();
  const isSystemAdmin = hasRole(session, PlatformRole.SYSTEM_ADMIN);
  const retentionEnded = Boolean(
    enterprise.deleted_at && Date.now() - new Date(enterprise.deleted_at).getTime() > RETENTION_DAYS * 86_400_000,
  );

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

  const deletionActive = active === "delete" || active === "restore" || active === "purge" ? active : null;
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
        {isDeleting || isDeleted ? (
          <>
            {isSystemAdmin && isDeleting && <DropdownMenuItem label="继续删除（上次未完成）" onClick={() => setActive("delete")} />}
            {isSystemAdmin && isDeleted && !enterprise.purged_at && !retentionEnded && (
              <DropdownMenuItem label="恢复企业" onClick={() => setActive("restore")} />
            )}
            {isSystemAdmin && isDeleted && !enterprise.purged_at && retentionEnded && (
              <DropdownMenuItem label="清理数据" onClick={() => setActive("purge")} />
            )}
          </>
        ) : (
          <>
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
        <DropdownMenuItem label="编辑企业信息" onClick={() => setActive("profile")} />
        <DropdownMenuItem label="配置可用模型" onClick={() => setActive("model_access")} />
        {!isClosed && <DropdownMenuItem label="重置管理员密码" onClick={() => setActive("reset_owner")} />}
        {isSystemAdmin && isClosed && <DropdownMenuItem label="删除企业" onClick={() => setActive("delete")} />}
          </>
        )}
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
      {active === "model_access" && (
        <EnterpriseModelAccessDialog
          enterprise={enterprise}
          api={api}
          onClose={() => setActive(null)}
          onDone={onDone}
        />
      )}
      {active === "profile" && (
        <EnterpriseProfileDialog api={api} enterprise={enterprise} onClose={() => setActive(null)} onDone={onDone} />
      )}
      {active === "reset_owner" && (
        <ResetOwnerDialog api={api} enterprise={enterprise} onClose={() => { setActive(null); requestAnimationFrame(() => triggerRef.current?.focus()); }} />
      )}
      {deletionActive && (
        <DeletionDialog mode={deletionActive} api={api} enterprise={enterprise} onClose={() => setActive(null)} onDone={onDone} />
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
