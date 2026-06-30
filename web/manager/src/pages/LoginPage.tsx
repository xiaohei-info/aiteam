import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "@aiteam/shared";
import { GlassPanel, Button } from "@aiteam/shared/ui";
import { useSession } from "../auth/session";
import { useI18n } from "../i18n/context";
import { createManagerApiClient } from "../api/client";

const fieldCls =
  "rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary " +
  "outline-none focus:ring-2 focus:ring-gold";

interface LocationState {
  from?: string;
}

interface LoginResponse {
  token: string;
}

interface OwnerIdentity {
  tenantId: string;
  account: string;
  oldPassword: string;
}

export function LoginPage(): React.ReactNode {
  const { session, signIn } = useSession();
  const i18n = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<"login" | "owner-reset">("login");
  const [tenantId, setTenantId] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pendingReset, setPendingReset] = useState<OwnerIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (session) {
    const from = (location.state as LocationState | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!tenantId.trim() || !account.trim() || !password.trim()) {
      setError(i18n.t("manager.login.required"));
      return;
    }
    setLoading(true);
    try {
      const client = createManagerApiClient({ getToken: () => null });
      const result = await client.post<LoginResponse>("/api/auth/login", {
        body: { tenant_id: tenantId.trim(), account: account.trim(), password: password.trim() },
      });
      if (!result) {
        setError(i18n.t("manager.login.login_failed"));
        return;
      }
      signIn(result.token);
      const from = (location.state as LocationState | null)?.from ?? "/";
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setPendingReset({
          tenantId: tenantId.trim(),
          account: account.trim(),
          oldPassword: password.trim(),
        });
        setMode("owner-reset");
        setError(null);
        return;
      }
      setError(err instanceof Error ? err.message : i18n.t("manager.login.login_failed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleOwnerReset(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!pendingReset) {
      setMode("login");
      return;
    }
    if (!newPassword.trim() || !confirmPassword.trim()) {
      setError(i18n.t("manager.login.required"));
      return;
    }
    if (newPassword.trim() !== confirmPassword.trim()) {
      setError(i18n.t("manager.login.password_mismatch"));
      return;
    }
    setLoading(true);
    try {
      const client = createManagerApiClient({ getToken: () => null });
      const result = await client.post<LoginResponse>("/api/auth/owner-reset", {
        body: {
          tenant_id: pendingReset.tenantId,
          account: pendingReset.account,
          old_password: pendingReset.oldPassword,
          new_password: newPassword.trim(),
        },
      });
      if (!result) {
        setError(i18n.t("manager.login.reset_failed"));
        return;
      }
      signIn(result.token);
      const from = (location.state as LocationState | null)?.from ?? "/";
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t("manager.login.reset_failed"));
    } finally {
      setLoading(false);
    }
  }

  function handleBackToLogin(): void {
    setMode("login");
    setPendingReset(null);
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
  }

  if (mode === "owner-reset" && pendingReset) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-canvas">
        <GlassPanel className="w-[360px] rounded-window p-xl">
          <form
            className="flex flex-col gap-md"
            data-testid="owner-reset-form"
            onSubmit={handleOwnerReset}
          >
            <h1 className="m-0 text-xl font-bold text-text-primary">
              {i18n.t("manager.login.owner_reset.heading")}
            </h1>
            <p className="m-0 text-xs text-text-secondary">
              {`${pendingReset.tenantId} · ${pendingReset.account}`}
            </p>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-text-secondary">{i18n.t("manager.login.new_password")}</span>
              <input
                className={fieldCls}
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                data-testid="new-password"
              />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-text-secondary">
                {i18n.t("manager.login.confirm_new_password")}
              </span>
              <input
                className={fieldCls}
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                data-testid="confirm-new-password"
              />
            </label>
            {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
            <Button type="submit" className="mt-sm" disabled={loading}>
              {i18n.t("manager.login.owner_reset.submit")}
            </Button>
            <button
              type="button"
              className="m-0 border-none bg-transparent p-0 text-xs text-text-secondary underline"
              onClick={handleBackToLogin}
            >
              {i18n.t("manager.login.owner_reset.back")}
            </button>
          </form>
        </GlassPanel>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-bg-canvas">
      <GlassPanel className="w-[360px] rounded-window p-xl">
        <form
          className="flex flex-col gap-md"
          data-testid="login-form"
          onSubmit={handleLogin}
        >
          <h1 className="m-0 text-xl font-bold text-text-primary">{i18n.t("manager.title")}</h1>
          <label className="flex flex-col gap-xs">
            <span className="text-xs text-text-secondary">{i18n.t("manager.login.tenant_id")}</span>
            <input
              className={fieldCls}
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              autoComplete="organization"
            />
          </label>
          <label className="flex flex-col gap-xs">
            <span className="text-xs text-text-secondary">{i18n.t("manager.login.account")}</span>
            <input
              className={fieldCls}
              type="text"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="flex flex-col gap-xs">
            <span className="text-xs text-text-secondary">{i18n.t("manager.login.password")}</span>
            <input
              className={fieldCls}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
          <Button type="submit" className="mt-sm" disabled={loading}>
            {i18n.t("manager.login.submit")}
          </Button>
        </form>
      </GlassPanel>
    </div>
  );
}
