/**
 * 一次性凭据展示（W-O.2）。
 *
 * 红线：bootstrap_secret 仅本次展示，不缓存不重发，不用 localStorage/sessionStorage。
 * 展示时脱敏（只显示首尾各4位），提供复制按钮。
 * 黑金玻璃质感，复用 shared 组件（GlassPanel/Button）。
 */
import { useState, type ReactNode } from "react";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";

interface Props {
  secret: string;
  enterpriseId: string;
}

export function BootstrapSecretDisplay({
  secret,
  enterpriseId,
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
      <p className="m-0 text-sm text-text-muted">
        enterprise_id: <code className="text-text-secondary">{enterpriseId}</code>
      </p>
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