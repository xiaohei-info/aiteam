import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
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

export function LoginPage(): React.ReactNode {
  const { session, signIn } = useSession();
  const i18n = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [tenantId, setTenantId] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (session) {
    const from = (location.state as LocationState | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
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
        setError("登录失败，请检查凭据");
        return;
      }
      signIn(result.token);
      const from = (location.state as LocationState | null)?.from ?? "/";
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败，请检查凭据");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-bg-canvas">
      <GlassPanel className="w-[360px] rounded-window p-xl">
        <form
          className="flex flex-col gap-md"
          data-testid="login-form"
          onSubmit={handleSubmit}
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
