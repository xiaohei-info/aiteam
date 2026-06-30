/**
 * 一次性凭据展示（W-O.2）。
 *
 * 红线：bootstrap_secret 仅本次展示，不缓存不重发，不用 localStorage/sessionStorage。
 * 展示时脱敏（只显示首尾各4位），提供复制按钮。
 * 黑金玻璃质感，复用 shared 组件（GlassPanel/Button）。
 *
 * 展示字段：enterprise_id / tenant_id / owner_phone / enterprise_code(可选) / must_reset
 * + 一次性 bootstrap_secret（脱敏）。
 */
import { useState, type ReactNode } from "react";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";

interface Props {
  secret: string;
  enterpriseId: string;
  tenantId: string;
  ownerPhone: string;
  enterpriseCode?: string | null;
  mustReset: boolean;
}

export function BootstrapSecretDisplay({
  secret,
  enterpriseId,
  tenantId,
  ownerPhone,
  enterpriseCode,
  mustReset,
}: Props): ReactNode {
  const i18n = useI18n();
  const [copied, setCopied] = useState(false);

  function masked(secret: string): string {
    if (secret.length <= 8) return "****";
    return secret.slice(0, 4) + "****" + secret.slice(-4);
  }

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 降级：clipboard API 不可用时不做任何事
    }
  }

  return (
    <GlassPanel
      data-testid="secret-display"
      className="flex flex-col gap-sm rounded-window border border-gold/30 p-lg"
    >
      <h2 className="m-0 text-base font-semibold text-text-primary">
        {i18n.t("operation.enterprise.bootstrap_secret")}
      </h2>
      <p className="m-0 text-sm text-warning">
        {i18n.t("operation.enterprise.secret_warning")}
      </p>
      <div className="rounded-md bg-surface px-md py-sm">
        <code className="text-sm text-gold-bright">{masked(secret)}</code>
      </div>
      <dl className="m-0 grid grid-cols-1 gap-x-lg gap-y-sm text-sm sm:grid-cols-2">
        <div className="flex gap-sm">
          <dt className="m-0 shrink-0 text-text-muted">
            {i18n.t("operation.enterprise.result_enterprise_id")}:
          </dt>
          <dd className="m-0 text-text-secondary">
            <code>{enterpriseId}</code>
          </dd>
        </div>
        <div className="flex gap-sm">
          <dt className="m-0 shrink-0 text-text-muted">
            {i18n.t("operation.enterprise.result_tenant_id")}:
          </dt>
          <dd className="m-0 text-text-secondary">
            <code>{tenantId}</code>
          </dd>
        </div>
        <div className="flex gap-sm">
          <dt className="m-0 shrink-0 text-text-muted">
            {i18n.t("operation.enterprise.result_owner_phone")}:
          </dt>
          <dd className="m-0 text-text-secondary">
            <code>{ownerPhone}</code>
          </dd>
        </div>
        {enterpriseCode ? (
          <div className="flex gap-sm">
            <dt className="m-0 shrink-0 text-text-muted">
              {i18n.t("operation.enterprise.result_enterprise_code")}:
            </dt>
            <dd className="m-0 text-text-secondary">
              <code>{enterpriseCode}</code>
            </dd>
          </div>
        ) : null}
        <div className="flex gap-sm sm:col-span-2">
          <dt className="m-0 shrink-0 text-text-muted">
            {i18n.t("operation.enterprise.result_must_reset")}:
          </dt>
          <dd className="m-0 text-text-secondary">
            {mustReset
              ? i18n.t("operation.enterprise.result_must_reset_yes")
              : i18n.t("operation.enterprise.result_must_reset_no")}
          </dd>
        </div>
      </dl>
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
          {copied
            ? i18n.t("operation.enterprise.copied")
            : i18n.t("operation.enterprise.copy")}
        </Button>
      </div>
    </GlassPanel>
  );
}
