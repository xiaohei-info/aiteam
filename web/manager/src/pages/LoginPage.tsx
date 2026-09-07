import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../auth/session";
import { useI18n } from "../i18n/context";
import { authenticatePasskey, type PasskeyOptions } from "../auth/passkey";
import { startOAuth } from "../auth/factors";
import { createManagerApiClient } from "../api/client";

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
  const [providers, setProviders] = useState<string[] | null>(null);

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
      if (err instanceof ApiError && err.status === 403 && ["password_reset_required", "password_expired"].includes(err.code ?? "")) {
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

  async function factorLogin(provider?: string): Promise<void> {
    setError(null); setLoading(true);
    try {
      if (!enterprise.trim()) throw new Error("请填写企业代码/名称");
      const client = createManagerApiClient({ getToken: () => null });
      const resolved = await client.post<{ tenant_id: string }>("/api/auth/resolve-tenant", { body: { enterprise: enterprise.trim() } });
      if (!resolved) throw new Error("企业未找到");
      if (provider) { await startOAuth(client, resolved.tenant_id, provider, "login"); return; }
      const params = new URLSearchParams({ tenant_id: resolved.tenant_id });
      if (account.trim()) params.set("account", account.trim());
      const options = await client.get<PasskeyOptions>(`/api/auth/passkey/authentication-options?${params}`);
      if (!options) throw new Error("Passkey 未配置");
      const assertion = await authenticatePasskey(options);
      const result = await client.post<LoginResponse>("/api/auth/passkey/login", { body: { tenant_id: resolved.tenant_id, ...assertion } });
      if (!result) throw new Error("Passkey 登录失败");
      signIn(result.token); navigate("/", { replace: true });
    } catch (err) { setError(err instanceof Error ? err.message : "登录失败"); }
    finally { setLoading(false); }
  }

  async function showProviders(): Promise<void> {
    try {
      const client = createManagerApiClient({ getToken: () => null });
      setProviders(await client.get<string[]>("/api/auth/oauth/providers") ?? []);
    } catch (err) { setError(err instanceof Error ? err.message : "登录方式加载失败"); }
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
      <Center minHeight="100vh" width="100%">
        <Card width={360} padding={6}>
          <form
            aria-label="负责人首次登录密码重置"
            data-testid="owner-reset-form"
            onSubmit={handleOwnerReset}
          >
            <VStack gap={4}>
              <Heading level={1}>{i18n.t("manager.login.owner_reset.heading")}</Heading>
              <Text type="supporting">账号：{pendingReset.account}</Text>
              <FormLayout>
                <TextInput
                  label={i18n.t("manager.login.new_password")}
                type="password"
                value={newPassword}
                  onChange={setNewPassword}
                  {...({ autoComplete: "new-password" } as Record<string, string>)}
                data-testid="new-password"
                  width="100%"
                />
                <TextInput
                  label={i18n.t("manager.login.confirm_new_password")}
                type="password"
                value={confirmPassword}
                  onChange={setConfirmPassword}
                  {...({ autoComplete: "new-password" } as Record<string, string>)}
                data-testid="confirm-new-password"
                  width="100%"
                />
              </FormLayout>
              {error ? <Banner status="error" title={error} /> : null}
              <Button
                type="submit"
                label={i18n.t("manager.login.owner_reset.submit")}
                variant="primary"
                isDisabled={loading}
                isLoading={loading}
              />
              <Button
                label={i18n.t("manager.login.owner_reset.back")}
                variant="ghost"
                onClick={handleBackToLogin}
              />
            </VStack>
          </form>
        </Card>
      </Center>
    );
  }

  return (
    <Center minHeight="100vh" width="100%">
      <Card width={360} padding={6}>
        <form
          aria-label="企业端登录"
          data-testid="login-form"
          onSubmit={handleLogin}
        >
          <VStack gap={4}>
            <Heading level={1}>{i18n.t("manager.title")}</Heading>
            <FormLayout>
              <TextInput
                label={i18n.t("manager.login.enterprise")}
              type="text"
              value={enterprise}
                onChange={setEnterprise}
                {...({ autoComplete: "organization" } as Record<string, string>)}
              placeholder={i18n.t("manager.login.enterprise_placeholder")}
                width="100%"
              />
              <TextInput
                label={i18n.t("manager.login.account")}
              type="text"
              value={account}
                onChange={setAccount}
                {...({ autoComplete: "username" } as Record<string, string>)}
                width="100%"
              />
              <TextInput
                label={i18n.t("manager.login.password")}
              type="password"
              value={password}
                onChange={setPassword}
                {...({ autoComplete: "current-password" } as Record<string, string>)}
                width="100%"
              />
            </FormLayout>
            {error ? <Banner status="error" title={error} /> : null}
            <Button
              type="submit"
              label={i18n.t("manager.login.submit")}
              variant="primary"
              isDisabled={loading}
              isLoading={loading}
            />
            <Button label="使用 Passkey 登录" isDisabled={loading} onClick={() => void factorLogin()} />
            {providers === null ? <Button label="其他登录方式" onClick={() => void showProviders()} /> : providers.map((provider) => <Button key={provider} label={`使用 ${provider} 登录`} isDisabled={loading} onClick={() => void factorLogin(provider)} />)}
          </VStack>
        </form>
      </Card>
    </Center>
  );
}
