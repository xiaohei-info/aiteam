/** 登录页（03 §9.4C 本地登录）。黑金玻璃质感；保留 i18n key 与字段，行为不变。 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, Button } from "@aiteam/shared/ui";

import { useApiError, useApp } from "../lib/app-context";

const fieldCls =
  "rounded-md border border-gold/25 bg-surface px-md py-sm text-sm text-text-primary " +
  "outline-none focus:ring-2 focus:ring-gold";

export function LoginPage() {
  const { client, i18n, applyLogin } = useApp();
  const toMessage = useApiError();
  const navigate = useNavigate();

  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [tenantHint, setTenantHint] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!tenantHint.trim()) {
      setError(i18n.t("agent.login.tenant_hint_required"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await client.login({
        account,
        password,
        tenant_hint: tenantHint.trim() || null,
      });
      if (!result) {
        setError(i18n.t("error.unknown"));
        return;
      }
      applyLogin(result.token, result.claims);
      navigate("/workspace");
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-bg-canvas">
      <GlassPanel className="flex w-[360px] flex-col gap-md rounded-window p-xl">
        <form className="flex flex-col gap-md" onSubmit={handleSubmit}>
          <h1 className="m-0 text-xl font-bold text-text-primary">{i18n.t("agent.login.title")}</h1>
          <label className="flex flex-col gap-xs">
            <span className="text-xs text-text-secondary">{i18n.t("agent.login.account")}</span>
            <input
              className={fieldCls}
              type="text"
              value={account}
              autoComplete="username"
              onChange={(e) => setAccount(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-xs">
            <span className="text-xs text-text-secondary">{i18n.t("agent.login.password")}</span>
            <input
              className={fieldCls}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-xs">
            <span className="text-xs text-text-secondary">{i18n.t("agent.login.tenant_hint")}</span>
            <input
              className={fieldCls}
              type="text"
              value={tenantHint}
              onChange={(e) => setTenantHint(e.target.value)}
            />
          </label>
          {error ? <div className="text-xs text-danger">{error}</div> : null}
          <Button type="submit" disabled={submitting} className="mt-sm">
            {submitting ? i18n.t("agent.login.loading") : i18n.t("agent.login.submit")}
          </Button>
        </form>
      </GlassPanel>
    </div>
  );
}
