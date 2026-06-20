/**
 * 一次性凭据展示（W-O.2）。
 *
 * 红线：bootstrap_secret 仅本次展示，不缓存不重发，不用 localStorage/sessionStorage。
 * 展示时脱敏（只显示首尾各4位），提供复制按钮。
 */
import { useState, type ReactNode } from "react";
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
    <section className="enterprise-page__secret" data-testid="secret-display">
      <h2>{i18n.t("operation.enterprise.bootstrap_secret")}</h2>
      <p className="enterprise-page__secret-warning">
        {i18n.t("operation.enterprise.secret_warning")}
      </p>
      <div className="enterprise-page__secret-value">
        <code>{masked(secret)}</code>
      </div>
      <p className="enterprise-page__secret-meta">
        enterprise_id: <code>{enterpriseId}</code>
      </p>
      <button
        type="button"
        className="enterprise-page__secret-copy"
        onClick={handleCopy}
      >
        {copied
          ? i18n.t("operation.enterprise.copied")
          : i18n.t("operation.enterprise.copy")}
      </button>
    </section>
  );
}
