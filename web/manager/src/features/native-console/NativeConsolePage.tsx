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
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";

export type NativeConsoleComponent = "lightrag" | "hindsight";

interface ConsoleSession {
  url: string;
  expires_in: number;
}

const COMPONENT_META: Record<NativeConsoleComponent, { title: string; description: string; label: string }> = {
  lightrag: {
    title: "知识库控制台",
    description: "通过 LightRAG 原生控制台管理本企业文档、索引和知识检索配置。",
    label: "LightRAG 原生控制台",
  },
  hindsight: {
    title: "记忆控制台",
    description: "通过 Hindsight 原生控制台管理本企业员工长期记忆和记忆存储状态。",
    label: "Hindsight 原生控制台",
  },
};

export function NativeConsolePage({ component }: { component: NativeConsoleComponent }): ReactNode {
  const { token, onUnauthorized } = useSession();
  const meta = COMPONENT_META[component];
  const api = useMemo(
    () => createManagerApiClient({ getToken: () => token, onUnauthorized }),
    [onUnauthorized, token],
  );
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const startSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const session = await api.post<ConsoleSession>(`/api/manager/native-console/${component}/session`);
      if (!session?.url) throw new Error(`${meta.title}地址未返回`);
      setFrameUrl(session.url);
    } catch (cause) {
      setFrameUrl(null);
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : `${meta.title}加载失败`);
    } finally {
      setLoading(false);
    }
  }, [api, component, meta.title]);

  useEffect(() => {
    void startSession();
    return () => { void api.del(`/api/manager/native-console/${component}/session`); };
  }, [api, component, startSession]);

  return (
    <VStack as="section" gap={5}>
      <HStack justify="between" align="center">
        <VStack gap={1}>
          <Heading level={1}>{meta.title}</Heading>
          <Text type="supporting">{meta.description}</Text>
        </VStack>
        <Button label="重新连接" variant="secondary" size="sm" onClick={() => void startSession()} isLoading={loading} />
      </HStack>
      <Banner
        status="info"
        title="企业专属原生控制台"
        description="当前 Manager 部署只连接本企业的组件实例。组件凭据由 Manager 服务端托管，不会发送到浏览器。"
      />
      {error && <Banner status="error" title={error} />}
      {loading ? (
        <Card role="status" aria-label={`${meta.title}加载中`}>
          <VStack gap={3}><Skeleton height={36} /><Skeleton height={640} index={1} /></VStack>
        </Card>
      ) : frameUrl ? (
        <Card padding={0}>
          <iframe
            title={meta.label}
            src={frameUrl}
            style={{ display: "block", width: "100%", minHeight: "760px", border: 0 }}
            referrerPolicy="same-origin"
          />
        </Card>
      ) : null}
    </VStack>
  );
}
