import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { GlassPanel, Button, Field, Input } from "@aiteam/shared/ui";
import { useSession } from "../auth/session";
import { useI18n } from "../i18n/context";
import { createOperationApiClient } from "../api/client";

interface LocationState {
  from?: string;
}

export function LoginPage(): React.ReactNode {
  const { session, signIn } = useSession();
  const i18n = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (session) {
    const from = (location.state as LocationState | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!username.trim() || !password.trim()) {
      setError(i18n.t("operation.login.required"));
      return;
    }
    try {
      const client = createOperationApiClient({ getToken: () => null });
      const result = await client.post<{ token: string }>("/api/operation/auth/login", {
        body: { username: username.trim(), password: password.trim() },
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
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-bg-canvas">
      <GlassPanel className="w-[360px] rounded-window p-xl">
        <form className="flex flex-col gap-md" data-testid="login-form" onSubmit={handleSubmit}>
          <h1 className="m-0 text-xl font-bold text-text-primary">{i18n.t("operation.title")}</h1>
          <Field label={i18n.t("operation.login.username")}>
            <Input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </Field>
          <Field label={i18n.t("operation.login.password")}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
          <Button type="submit" className="mt-sm">
            {i18n.t("operation.login.submit")}
          </Button>
        </form>
      </GlassPanel>
    </div>
  );
}
