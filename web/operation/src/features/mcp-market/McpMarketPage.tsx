import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useMcpMarketApi } from "./useMcpMarketApi";
import type { PlatformMcpServer, PlatformMcpServerInput } from "./types";

const STATUS: Record<PlatformMcpServer["status"], { label: string; variant: "success" | "warning" | "neutral" }> = {
  draft: { label: "草稿", variant: "neutral" },
  published: { label: "已发布", variant: "success" },
  unpublished: { label: "已下架", variant: "warning" },
};

/** 运营端平台 MCP 目录：登记免凭据 MCP，发布后企业可在「MCP 市场」启用，成员再在对话中自行安装（设计 §11.3）。 */
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
          <Text color="secondary">登记平台认可的 MCP 服务。发布后企业可在「MCP 市场」启用；需要凭据的 MCP 不会进入成员可自行安装的列表。</Text>
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
                      {item.requires_credentials && <Badge label="需要凭据（成员不可自装）" variant="warning" />}
                    </HStack>
                    <Text color="secondary">{item.summary || "暂无用途说明"}</Text>
                    <Text color="secondary" style={{ wordBreak: "break-all" }}>{item.url}</Text>
                    <Text color="secondary">标识 {item.ref} · 修订 {item.revision} · 工具：{item.tools.join("、")}</Text>
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
      {editing && <McpServerDialog item={editing === "new" ? null : editing} busy={busy === "save"} onClose={() => setEditing(null)} onSave={save} />}
    </VStack>
  );
}

function McpServerDialog({ item, busy, onClose, onSave }: { item: PlatformMcpServer | null; busy: boolean; onClose: () => void; onSave: (input: PlatformMcpServerInput) => Promise<void> }) {
  const [ref, setRef] = useState(item?.ref ?? "");
  const [displayName, setDisplayName] = useState(item?.display_name ?? "");
  const [summary, setSummary] = useState(item?.summary ?? "");
  const [url, setUrl] = useState(item?.url ?? "");
  const [tools, setTools] = useState(item?.tools.join("\n") ?? "");
  const [requiresCredentials, setRequiresCredentials] = useState(item?.requires_credentials ?? false);
  const formRef = useRef<HTMLFormElement>(null);
  const submitForm = () => formRef.current?.requestSubmit();
  const close = (open: boolean) => { if (!open && !busy) onClose(); };

  function submit(event: FormEvent) {
    event.preventDefault();
    void onSave({
      ref: ref.trim(), display_name: displayName.trim(), summary: summary.trim(), url: url.trim(),
      tools: tools.split(/[\n,，]/).map((name) => name.trim()).filter(Boolean),
      requires_credentials: requiresCredentials,
    });
  }

  // 标题与操作按钮固定，中间内容滚动；按钮在表单外，用 requestSubmit 保留表单原生校验。
  return (
    <Dialog isOpen purpose="form" width={600} aria-label={item ? "编辑 MCP" : "登记 MCP"} onOpenChange={close}>
      <Layout
        header={<DialogHeader title={item ? `编辑 ${item.display_name}` : "登记 MCP"} onOpenChange={close} />}
        content={
          <LayoutContent>
            <form ref={formRef} onSubmit={submit} aria-label="MCP 信息">
              <VStack gap={3}>
                <TextInput label="标识" description="小写字母开头，只含小写字母、数字、- 或 _；成员本机安装时使用，创建后不能修改。" value={ref} onChange={setRef} isRequired isDisabled={Boolean(item) || busy} />
                <TextInput label="名称" value={displayName} onChange={setDisplayName} isRequired isDisabled={busy} />
                <TextArea label="用途" value={summary} onChange={setSummary} rows={3} maxLength={500} isDisabled={busy} />
                <TextInput label="端点地址" description="streamable HTTP，仅 https，不能包含账号、查询串。" value={url} onChange={setUrl} isRequired isDisabled={busy} />
                <TextArea label="工具名" description="每行一个。成员安装时只保留与服务端实际工具的交集。" value={tools} onChange={setTools} rows={4} isRequired isDisabled={busy} />
                <Switch label="需要凭据" description="需要凭据的 MCP 不进入成员可自行安装的列表，请走企业连接器。" value={requiresCredentials} onChange={setRequiresCredentials} isDisabled={busy} />
              </VStack>
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="取消" onClick={onClose} isDisabled={busy} />
              <Button label={item ? "保存" : "登记"} variant="primary" isLoading={busy} onClick={submitForm} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
