import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { createOperationApiClient } from "../../api/client";
import { useSession } from "../../auth/session";

interface ConsoleSession {
  url: string;
  expires_in: number;
}

export function GatewayPage(): ReactNode {
  const { token, onUnauthorized } = useSession();
  const api = useMemo(
    () => createOperationApiClient({ getToken: () => token, onUnauthorized }),
    [onUnauthorized, token],
  );
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const startSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const session = await api.post<ConsoleSession>("/api/operation/newapi-console/session");
      if (!session?.url) throw new Error("NewAPI 原生控制台地址未返回");
      setFrameUrl(session.url);
    } catch (cause) {
      setFrameUrl(null);
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : "NewAPI 原生控制台加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void startSession();
    return () => { void api.del("/api/operation/newapi-console/session"); };
  }, [api, startSession]);

  return (
    <VStack as="section" gap={5}>
      <HStack justify="between" align="center">
        <VStack gap={1}>
          <Heading level={1}>大模型网关</Heading>
          <Text type="supporting">通过 NewAPI 原生控制台管理平台渠道、上游模型和网关运行状态。</Text>
        </VStack>
        <Button label="重新连接" variant="secondary" size="sm" onClick={() => void startSession()} isLoading={loading} />
      </HStack>
      <Banner
        status="info"
        title="平台级 NewAPI 管理"
        description="这是 Operator 专属控制台。管理凭据由服务端托管，不会发送到浏览器；企业端只接收已发布的模型和受限 Relay 配置。"
      />
      {error && <Banner status="error" title={error} />}
      {loading ? (
        <Card role="status" aria-label="NewAPI 原生控制台加载中">
          <VStack gap={3}><Skeleton height={36} /><Skeleton height={640} index={1} /></VStack>
        </Card>
      ) : frameUrl ? (
        <Card padding={0}>
          <iframe
            title="NewAPI 原生控制台"
            src={frameUrl}
            style={{ display: "block", width: "100%", minHeight: "760px", border: 0 }}
            referrerPolicy="same-origin"
          />
        </Card>
      ) : null}
    </VStack>
  );
}
