/**
 * 登录页骨架（03 §9.4C 本地登录）。调本端 /api/agent/login，成功后写会话并跳工作台。
 * 对端 Manager 在线校验凭据（首次）；用户端只缓存 token + 本地验签（03 §9.8）。
 */

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { useApiError, useApp } from "../lib/app-context";

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
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1 className="login-card__title">{i18n.t("agent.login.title")}</h1>
        <label className="login-field">
          <span className="login-field__label">{i18n.t("agent.login.account")}</span>
          <input
            className="login-field__input"
            type="text"
            value={account}
            autoComplete="username"
            onChange={(e) => setAccount(e.target.value)}
            required
          />
        </label>
        <label className="login-field">
          <span className="login-field__label">{i18n.t("agent.login.password")}</span>
          <input
            className="login-field__input"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label className="login-field">
          <span className="login-field__label">{i18n.t("agent.login.tenant_hint")}</span>
          <input
            className="login-field__input"
            type="text"
            value={tenantHint}
            onChange={(e) => setTenantHint(e.target.value)}
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="login-submit" type="submit" disabled={submitting}>
          {submitting ? i18n.t("agent.login.loading") : i18n.t("agent.login.submit")}
        </button>
      </form>
    </div>
  );
}
