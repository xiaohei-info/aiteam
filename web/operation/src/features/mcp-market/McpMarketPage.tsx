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
import { AUTH_LABEL, McpServerDialog } from "./McpServerDialog";
import { useMcpMarketApi } from "./useMcpMarketApi";
import type { PlatformMcpServer, PlatformMcpServerInput } from "./types";

const STATUS: Record<PlatformMcpServer["status"], { label: string; variant: "success" | "warning" | "neutral" }> = {
  draft: { label: "草稿", variant: "neutral" },
  published: { label: "已发布", variant: "success" },
  unpublished: { label: "已下架", variant: "warning" },
};

/** 运营端平台 MCP 目录：登记 MCP（可无需鉴权 / 成员浏览器登录 / 成员访问令牌），发布后企业可在「MCP 市场」启用，成员再自行安装（设计 §11.3、MCP鉴权 2026-11-18）。 */
export function McpMarketPage(): ReactNode {
  const api = useMcpMarketApi();
  const [items, setItems] = useState<PlatformMcpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlatformMcpServer | "new" | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setItems(await api.list()); }
    catch (err) { setError(err instanceof ApiError ? err.message : "MCP 目录加载失败"); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  async function act(key: string, action: () => Promise<unknown>, done: string, failure: string) {
    setBusy(key);
    setNotice(null);
    setError(null);
    try {
      await action();
      setNotice(done);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : failure);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function save(input: PlatformMcpServerInput) {
    const target = editing;
    const ok = await act("save", () => (target && target !== "new" ? api.update(target.server_id, input) : api.create(input)),
      target && target !== "new" ? `${input.display_name} 已保存，修订号加 1` : `${input.display_name} 已登记为草稿`, "保存失败");
    if (ok) setEditing(null);
  }

  return (
    <VStack as="section" gap={5}>
      <HStack justify="between" align="center" wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>MCP 目录</Heading>
          <Text color="secondary">登记平台认可的 MCP 服务。发布后企业可在「MCP 市场」启用；需要鉴权的 MCP 由成员安装时用自己的账号登录或填自己的令牌，平台不保存成员令牌。</Text>
        </VStack>
        <Button label="登记 MCP" variant="primary" onClick={() => setEditing("new")} />
      </HStack>
      {notice && <Banner status="success" title={notice} />}
      {error && <Banner status="error" title={error} />}
      {items === null ? <Text color="secondary">正在加载…</Text> : items.length === 0 ? <EmptyState title="还没有登记 MCP" /> : (
        <VStack gap={3}>
          {items.map((item) => {
            const status = STATUS[item.status] ?? STATUS.draft;
            const published = item.status === "published";
            return (
              <Card key={item.server_id} padding={4}>
                <HStack justify="between" align="start" wrap="wrap" gap={3}>
                  <VStack gap={1} style={{ minWidth: 0, flex: 1 }}>
                    <HStack gap={2} align="center" wrap="wrap">
                      <Heading level={3}>{item.display_name}</Heading>
                      <Badge label={status.label} variant={status.variant} />
                      {item.auth !== "none" && <Badge label={AUTH_LABEL[item.auth]} variant="info" />}
                    </HStack>
                    <Text color="secondary">{item.summary || "暂无用途说明"}</Text>
                    <Text color="secondary" style={{ wordBreak: "break-all" }}>{item.url}</Text>
                    <Text color="secondary">标识 {item.ref} · 修订 {item.revision} · 超时 {Math.round(item.timeout_ms / 1000)} 秒 · 工具：{item.tools.length ? item.tools.join("、") : "以成员登录后实际工具为准"}</Text>
                  </VStack>
                  <HStack gap={2}>
                    <Button label="编辑" size="sm" variant="ghost" onClick={() => setEditing(item)} isDisabled={busy !== null} />
                    <Button
                      label={published ? "下架" : "发布"}
                      size="sm"
                      variant={published ? "destructive" : "primary"}
                      isLoading={busy === item.server_id}
                      isDisabled={busy !== null && busy !== item.server_id}
                      onClick={() => void act(item.server_id, () => (published ? api.unpublish(item.server_id) : api.publish(item.server_id)),
                        `${item.display_name} 已${published ? "下架（已启用的企业与成员已装的不受影响）" : "发布"}`, "状态更新失败")}
                    />
                  </HStack>
                </HStack>
              </Card>
            );
          })}
        </VStack>
      )}
      {editing && <McpServerDialog item={editing === "new" ? null : editing} busy={busy === "save"} onClose={() => setEditing(null)} onSave={save} probe={(input) => api.probe(input)} />}
    </VStack>
  );
}
