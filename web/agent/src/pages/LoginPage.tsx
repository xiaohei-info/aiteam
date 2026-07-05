/** 登录页（03 §9.4C 本地登录）。黑金玻璃质感；保留 i18n key 与字段，行为不变。 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "@aiteam/shared/api-client";
import { GlassPanel, Button } from "@aiteam/shared/ui";

import { useApiError, useApp } from "../lib/app-context";

const fieldCls =
  "rounded-md border border-gold/25 bg-surface px-md py-sm text-sm text-text-primary " +
  "outline-none focus:ring-2 focus:ring-gold";

export function LoginPage() {
  const { client, i18n, applyLogin } = useApp();
  const toMessage = useApiError();
  const navigate = useNavigate();

  const [mode, setMode] = useState<"login" | "reset">("login");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await client.login({ account, password });
      if (!result) {
        setError(i18n.t("error.unknown"));
        return;
      }
      applyLogin(result.token, result.claims);
      navigate("/workspace");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        // Manager 要求重置密码 → 切换到重置模式（保留已填 account/password/tenant）
        setMode("reset");
        setError(null);
        return;
      }
      setError(toMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReset(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!newPassword.trim() || !confirmPassword.trim()) {
      setError(i18n.t("agent.login.reset_failed"));
      return;
    }
    if (newPassword.trim() !== confirmPassword.trim()) {
      setError(i18n.t("agent.login.password_mismatch"));
      return;
    }
    setSubmitting(true);
    try {
      const result = await client.resetPassword({
        account,
        password,
        new_password: newPassword.trim(),
      });
      if (!result) {
        setError(i18n.t("agent.login.reset_failed"));
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

  function handleBackToLogin(): void {
    setMode("login");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
  }

  if (mode === "reset") {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-canvas">
        <GlassPanel className="flex w-[360px] flex-col gap-md rounded-window p-xl">
          <form className="flex flex-col gap-md" onSubmit={handleReset}>
            <h1 className="m-0 text-xl font-bold text-text-primary">
              {i18n.t("agent.login.reset_heading")}
            </h1>
            <p className="m-0 text-xs text-text-secondary">{account}</p>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-text-secondary">{i18n.t("agent.login.new_password")}</span>
              <input
                className={fieldCls}
                type="password"
                value={newPassword}
                autoComplete="new-password"
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-text-secondary">{i18n.t("agent.login.confirm_new_password")}</span>
              <input
                className={fieldCls}
                type="password"
                value={confirmPassword}
                autoComplete="new-password"
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </label>
            {error ? <div className="text-xs text-danger">{error}</div> : null}
            <Button type="submit" disabled={submitting} className="mt-sm">
              {submitting ? i18n.t("agent.login.loading") : i18n.t("agent.login.reset_submit")}
            </Button>
            <button
              type="button"
              className="m-0 border-none bg-transparent p-0 text-xs text-text-secondary underline"
              onClick={handleBackToLogin}
            >
              {i18n.t("agent.login.reset_back")}
            </button>
          </form>
        </GlassPanel>
      </div>
    );
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
          {error ? <div className="text-xs text-danger">{error}</div> : null}
          <Button type="submit" disabled={submitting} className="mt-sm">
            {submitting ? i18n.t("agent.login.loading") : i18n.t("agent.login.submit")}
          </Button>
        </form>
      </GlassPanel>
    </div>
  );
}
