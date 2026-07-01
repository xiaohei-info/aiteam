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
  const [enterprise, setEnterprise] = useState("");
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
    if (!enterprise.trim() || !account.trim() || !password.trim()) {
      setError(i18n.t("manager.login.required"));
      return;
    }
    setLoading(true);
    try {
      const client = createManagerApiClient({ getToken: () => null });
      // 先解析企业标识→tenant_id（隐藏 UUID 细节）
      const resolveResult = await client.post<{ tenant_id: string }>("/api/auth/resolve-tenant", {
        body: { enterprise: enterprise.trim() },
      });
      if (!resolveResult) {
        setError(i18n.t("manager.login.enterprise_not_found"));
        return;
      }
      const tenantId = resolveResult.tenant_id;
      // 用 tenant_id 登录
      const result = await client.post<LoginResponse>("/api/auth/login", {
        body: { tenant_id: tenantId, account: account.trim(), password: password.trim() },
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
        // 需先 resolve 再传给 reset 流程；403 时已经过 resolve（login 里解析了），
        // 但前端没留 tenantId，需重新 resolve 或在 catch 前存下来。
        // 简单起见：再 resolve 一次（冗余但逻辑清晰）。
        try {
          const client2 = createManagerApiClient({ getToken: () => null });
          const resolveResult = await client2.post<{ tenant_id: string }>("/api/auth/resolve-tenant", {
            body: { enterprise: enterprise.trim() },
          });
          if (resolveResult) {
            setPendingReset({
              tenantId: resolveResult.tenant_id,
              account: account.trim(),
              oldPassword: password.trim(),
            });
            setMode("owner-reset");
            setError(null);
            return;
          }
        } catch {
          // resolve 失败，fallback 用原 error
        }
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
            <span className="text-xs text-text-secondary">{i18n.t("manager.login.enterprise")}</span>
            <input
              className={fieldCls}
              type="text"
              value={enterprise}
              onChange={(e) => setEnterprise(e.target.value)}
              autoComplete="organization"
              placeholder={i18n.t("manager.login.enterprise_placeholder")}
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
