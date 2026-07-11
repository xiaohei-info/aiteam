import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
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
  const [loading, setLoading] = useState(false);

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
    setLoading(true);
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
    } finally {
      setLoading(false);
    }
  }

  return (
    <Center minHeight="100vh" width="100%">
      <Card width={360} padding={6}>
        <form
          aria-label="运营端登录"
          data-testid="login-form"
          onSubmit={handleSubmit}
        >
          <VStack gap={4}>
            <Heading level={1}>{i18n.t("operation.title")}</Heading>
            <FormLayout>
              <TextInput
                label={i18n.t("operation.login.username")}
                type="text"
                value={username}
                onChange={setUsername}
                width="100%"
              />
              <TextInput
                label={i18n.t("operation.login.password")}
                type="password"
                value={password}
                onChange={setPassword}
                width="100%"
              />
            </FormLayout>
            {error ? <Banner status="error" title={error} /> : null}
            {loading ? (
              <Text role="status" aria-label="正在登录" type="supporting">
                正在登录…
              </Text>
            ) : null}
            <Button
              type="submit"
              label={i18n.t("operation.login.submit")}
              variant="primary"
              isDisabled={loading}
              isLoading={loading}
            />
          </VStack>
        </form>
      </Card>
    </Center>
  );
}
