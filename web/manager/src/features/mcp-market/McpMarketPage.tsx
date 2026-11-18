import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useMcpMarketApi } from "./useMcpMarketApi";
import type { McpMarket, McpMarketServer } from "./types";

function statusBadge(item: McpMarketServer): { label: string; variant: "success" | "warning" | "neutral" } | null {
  if (!item.enabled) return null;
  if (!item.published) return { label: "已启用 · 平台已下架", variant: "warning" };
  if (item.update_available) return { label: "已启用 · 有更新", variant: "warning" };
  return { label: "已启用", variant: "success" };
}

/** 企业端 MCP 市场：把平台已发布的 MCP 启用到本企业，成员即可在对话中自行安装（设计 §11.3）。 */
const AUTH_LABEL: Record<McpMarketServer["auth"], string> = {
  none: "无需鉴权",
  oauth: "成员浏览器登录",
  bearer: "成员访问令牌",
};

export function McpMarketPage(): ReactNode {
  const api = useMcpMarketApi();
  const [market, setMarket] = useState<McpMarket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setMarket(await api.list()); }
    catch (err) { setError(err instanceof ApiError ? err.message : "MCP 市场加载失败"); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  async function act(item: McpMarketServer, action: () => Promise<unknown>, done: string, failure: string) {
    setBusy(item.server_id);
    setNotice(null);
    setError(null);
    try {
      await action();
      setNotice(done);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : failure);
    } finally {
      setBusy(null);
    }
  }

  const servers = market?.servers ?? [];
  return (
    <VStack as="section" gap={5}>
      <VStack gap={1}>
        <Heading level={1}>MCP 市场</Heading>
        <Text color="secondary">MCP 由平台审核登记。启用后，本企业成员可以在对话中或「设置 · 个人能力」自行安装；需要鉴权的由成员用自己的账号登录或填自己的令牌，企业端不保存成员凭据。停用只影响以后的安装，成员已装的不受影响。</Text>
      </VStack>
      {notice && <Banner status="success" title={notice} />}
      {error && <Banner status="error" title={error} />}
      {market && !market.platform_available && <Banner status="warning" title="平台 MCP 目录暂时不可用，只列出本企业已启用的 MCP。" />}
      {market === null && !error ? <Text color="secondary">正在加载…</Text> : servers.length === 0 ? <EmptyState title="暂无平台发布的 MCP" /> : (
        <VStack gap={3}>
          {servers.map((item) => {
            const badge = statusBadge(item);
            const canEnable = item.published && (!item.enabled || item.update_available);
            return (
              <Card key={item.server_id} padding={4}>
                <HStack justify="between" align="start" wrap="wrap" gap={3}>
                  <VStack gap={1} style={{ minWidth: 0, flex: 1 }}>
                    <HStack gap={2} align="center" wrap="wrap">
                      <Heading level={3}>{item.display_name}</Heading>
                      {badge && <Badge label={badge.label} variant={badge.variant} />}
                      {item.auth !== "none" && <Badge label={AUTH_LABEL[item.auth]} variant="info" />}
                    </HStack>
                    <Text color="secondary">{item.summary || "暂无用途说明"}</Text>
                    <Text color="secondary" style={{ wordBreak: "break-all" }}>{item.url}</Text>
                    <Text color="secondary">标识 {item.ref} · 工具：{item.tools.length ? item.tools.join("、") : "以成员登录后实际工具为准"}</Text>
                  </VStack>
                  <HStack gap={2}>
                    {item.enabled && (
                      <Button label="停用" size="sm" variant="destructive" isLoading={busy === item.server_id} isDisabled={busy !== null && busy !== item.server_id}
                        onClick={() => void act(item, () => api.disable(item.server_id), `${item.display_name} 已停用（成员已装的不受影响）`, "停用失败")} />
                    )}
                    {canEnable && (
                      <Button label={item.enabled ? "更新" : "启用"} size="sm" variant="primary" isLoading={busy === item.server_id} isDisabled={busy !== null && busy !== item.server_id}
                        onClick={() => void act(item, () => api.enable(item.server_id), `${item.display_name} 已${item.enabled ? "更新到平台最新修订" : "启用"}`, "启用失败")} />
                    )}
                  </HStack>
                </HStack>
              </Card>
            );
          })}
        </VStack>
      )}
    </VStack>
  );
}
