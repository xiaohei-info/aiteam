import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, capabilityTitle } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useLocation, useNavigate } from "react-router-dom";
import { CapabilityAssistDialog } from "../capability-assist/CapabilityAssistDialog";
import { handoffState, mcpDialogInitial, readHandoff, SKILL_PAGE } from "../capability-assist/handoff";
import type { CapabilityAssistCandidate } from "../capability-assist/types";
import { useCapabilityAssistApi } from "../capability-assist/useCapabilityAssistApi";
import { EnterpriseMcpDialog } from "./EnterpriseMcpDialog";
import { useMcpMarketApi } from "./useMcpMarketApi";
import type { EnterpriseMcpServer, EnterpriseMcpServerInput, McpMarket, McpMarketServer } from "./types";

function statusBadge(item: McpMarketServer): { label: string; variant: "success" | "warning" | "neutral" } | null {
  if (!item.enabled) return null;
  if (!item.published) return { label: "已启用 · 平台已下架", variant: "warning" };
  if (item.update_available) return { label: "已启用 · 有更新", variant: "warning" };
  return { label: "已启用", variant: "success" };
}

/**
 * 企业端 MCP 市场：把平台已发布的 MCP 启用到本企业（设计 §11.3），或企业自己添加 MCP（设计 2026-11-20 §4.4）；
 * 成员即可在对话中或桌面端「添加 MCP · 从企业拿」自行安装。
 */
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
  const [editing, setEditing] = useState<EnterpriseMcpServer | "new" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EnterpriseMcpServer | null>(null);
  /** 新增对话框的预填（来自「让模型帮我找」）。 */
  const [seed, setSeed] = useState<ReturnType<typeof mcpDialogInitial> | undefined>(undefined);
  const [assisting, setAssisting] = useState(false);
  const assistApi = useCapabilityAssistApi();
  const navigate = useNavigate();
  const location = useLocation();

  const openNew = (initial?: ReturnType<typeof mcpDialogInitial>) => { setSaveError(null); setSeed(initial); setEditing("new"); };

  // 技能目录页的「让模型帮我找」选中了 MCP 候选：在这里打开预填的添加对话框，然后清掉路由 state。
  useEffect(() => {
    const candidate = readHandoff(location.state, "mcp");
    if (!candidate) return;
    openNew(mcpDialogInitial(candidate));
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  const pickCandidate = (candidate: CapabilityAssistCandidate) => {
    setAssisting(false);
    if (candidate.kind === "mcp") openNew(mcpDialogInitial(candidate));
    else navigate(SKILL_PAGE, { state: handoffState(candidate) });
  };

  const load = useCallback(async () => {
    setError(null);
    try { setMarket(await api.list()); }
    catch (err) { setError(err instanceof ApiError ? err.message : "MCP 市场加载失败"); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  async function act(item: { server_id: string }, action: () => Promise<unknown>, done: string, failure: string) {
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

  async function save(input: EnterpriseMcpServerInput) {
    const target = editing;
    setBusy("save");
    setSaveError(null);
    setNotice(null);
    try {
      if (target && target !== "new") await api.updateCustom(target.server_id, input);
      else await api.createCustom(input);
      setEditing(null);
      setNotice(target && target !== "new" ? `${input.display_name} 已保存，成员本机会提示更新` : `${input.display_name} 已添加，成员可以在「添加 MCP · 从企业拿」里安装`);
      await load();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "保存失败，请稍后再试");
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    await act(target, () => api.disable(target.server_id), `${target.display_name} 已删除（成员已装的不受影响）`, "删除失败");
    setPendingDelete(null);
  }

  const servers = market?.servers ?? [];
  const enterprise = market?.enterprise ?? [];
  const platformNs = market?.platform_namespace ?? "taiyim";
  const enterpriseNs = market?.enterprise_namespace ?? "";
  return (
    <VStack as="section" gap={5}>
      <VStack gap={1}>
        <Heading level={1}>MCP 市场</Heading>
        <Text color="secondary">启用平台审核登记的 MCP，或添加企业自己的 MCP。成员可以在对话中或桌面端「添加 MCP · 从企业拿」自行安装；需要鉴权的由成员用自己的账号登录或填自己的令牌，企业端不保存成员凭据。停用或删除只影响以后的安装，成员已装的不受影响。</Text>
      </VStack>
      {notice && <Banner status="success" title={notice} />}
      {error && <Banner status="error" title={error} />}
      <VStack gap={3} as="section" aria-label="企业自建 MCP">
        <HStack justify="between" align="center" wrap="wrap" gap={2}>
          <Heading level={2}>企业自建</Heading>
          <HStack gap={2}>
            <Button label="让模型帮我找" size="sm" isDisabled={busy !== null} onClick={() => setAssisting(true)} />
            <Button label="添加企业 MCP" size="sm" variant="primary" isDisabled={busy !== null} onClick={() => openNew()} />
          </HStack>
        </HStack>
        {market === null && !error ? <Text color="secondary">正在加载…</Text> : enterprise.length === 0
          ? <EmptyState title="还没有企业自建的 MCP" description="可以添加企业内部或第三方的 MCP 服务；添加后成员在「添加 MCP · 从企业拿」里一键安装。企业自建的 MCP 不参与「以后自动安装」。" />
          : (
            <VStack gap={3}>
              {enterprise.map((item) => (
                <Card key={item.server_id} padding={4}>
                  <HStack justify="between" align="start" wrap="wrap" gap={3}>
                    <VStack gap={1} style={{ minWidth: 0, flex: 1 }}>
                      <HStack gap={2} align="center" wrap="wrap">
                        <Heading level={3}>{item.display_name}</Heading>
                        <Badge label="企业自建" variant="neutral" />
                        {item.auth !== "none" && <Badge label={AUTH_LABEL[item.auth]} variant="info" />}
                      </HStack>
                      <Text color="secondary">{item.summary || "暂无用途说明"}</Text>
                      <Text color="secondary" style={{ wordBreak: "break-all" }}>{item.url}</Text>
                      <Text color="secondary">标识 {capabilityTitle(enterpriseNs, item.ref)} · 修订 {item.revision} · 工具：{item.tools.length ? item.tools.join("、") : "以成员登录后实际工具为准"}</Text>
                    </VStack>
                    <HStack gap={2}>
                      <Button label="编辑" size="sm" isDisabled={busy !== null} onClick={() => { setSaveError(null); setEditing(item); }} />
                      <Button label="删除" size="sm" variant="destructive" isLoading={busy === item.server_id} isDisabled={busy !== null && busy !== item.server_id} onClick={() => setPendingDelete(item)} />
                    </HStack>
                  </HStack>
                </Card>
              ))}
            </VStack>
          )}
      </VStack>
      <VStack gap={3} as="section" aria-label="平台 MCP">
        <Heading level={2}>平台 MCP</Heading>
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
                      <Text color="secondary">标识 {capabilityTitle(platformNs, item.ref)} · 工具：{item.tools.length ? item.tools.join("、") : "以成员登录后实际工具为准"}</Text>
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
      {assisting && <CapabilityAssistDialog api={assistApi} onClose={() => setAssisting(false)} onUse={pickCandidate} />}

      {editing && (
        <EnterpriseMcpDialog
          item={editing === "new" ? null : editing} busy={busy === "save"} error={saveError}
          onClose={() => setEditing(null)} onSave={save} probe={(input) => api.probe(input)} initial={editing === "new" ? seed : undefined}
        />
      )}
      {pendingDelete && (
        <AlertDialog
          isOpen
          title={`删除 ${pendingDelete.display_name}？`}
          description="删除后成员不能再从企业目录安装它；已经装好的成员不受影响。"
          cancelLabel="取消"
          actionLabel="删除"
          isActionLoading={busy === pendingDelete.server_id}
          onOpenChange={(isOpen) => { if (!isOpen && busy === null) setPendingDelete(null); }}
          onAction={() => void confirmDelete()}
        />
      )}
    </VStack>
  );
}
