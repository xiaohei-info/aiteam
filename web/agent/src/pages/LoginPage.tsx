/** Agent 本地登录：保留认证和首次密码重置语义，视图直接使用 Astryx。 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "@aiteam/shared/api-client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";

import { useApiError, useApp } from "../lib/app-context";

export function LoginPage(): React.ReactNode {
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
      <Center minHeight="100vh" width="100%">
        <Card width={360} padding={6}>
          <form aria-label="用户端首次登录密码重置" onSubmit={handleReset}>
            <VStack gap={4}>
              <Heading level={1}>{i18n.t("agent.login.reset_heading")}</Heading>
              <Text type="supporting">{account}</Text>
              <FormLayout>
                <TextInput
                  label={i18n.t("agent.login.new_password")}
                  type="password"
                  value={newPassword}
                  onChange={setNewPassword}
                  {...({ autoComplete: "new-password", required: true } as Record<string, string | boolean>)}
                  width="100%"
                />
                <TextInput
                  label={i18n.t("agent.login.confirm_new_password")}
                  type="password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  {...({ autoComplete: "new-password", required: true } as Record<string, string | boolean>)}
                  width="100%"
                />
              </FormLayout>
              {error ? <Banner status="error" title={error} /> : null}
              <Button
                type="submit"
                label={i18n.t("agent.login.reset_submit")}
                variant="primary"
                isDisabled={submitting}
                isLoading={submitting}
              />
              <Button label={i18n.t("agent.login.reset_back")} variant="ghost" onClick={handleBackToLogin} />
            </VStack>
          </form>
        </Card>
      </Center>
    );
  }

  return (
    <Center minHeight="100vh" width="100%">
      <Card width={360} padding={6}>
        <form aria-label="用户端登录" data-testid="login-form" onSubmit={handleSubmit}>
          <VStack gap={4}>
            <Heading level={1}>{i18n.t("agent.login.title")}</Heading>
            <FormLayout>
              <TextInput
                label={i18n.t("agent.login.account")}
                type="text"
                value={account}
                onChange={setAccount}
                {...({ autoComplete: "username", required: true } as Record<string, string | boolean>)}
                width="100%"
              />
              <TextInput
                label={i18n.t("agent.login.password")}
                type="password"
                value={password}
                onChange={setPassword}
                {...({ autoComplete: "current-password", required: true } as Record<string, string | boolean>)}
                width="100%"
              />
            </FormLayout>
            {error ? <Banner status="error" title={error} /> : null}
            <Button
              type="submit"
              label={i18n.t("agent.login.submit")}
              variant="primary"
              isDisabled={submitting}
              isLoading={submitting}
            />
          </VStack>
        </form>
      </Card>
    </Center>
  );
}
