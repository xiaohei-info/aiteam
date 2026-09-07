import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import { useKnowledgeApi } from "../knowledge/useKnowledgeApi";
import type { KnowledgeDocument } from "../knowledge/types";

interface WholeBinding {
  binding_id: string;
  knowledge_space_id: string;
  enabled: boolean;
  revoked_at: string | null;
}
interface DocumentPolicy {
  document_id: string;
  enabled: boolean | null;
  revoked_at: string | null;
}

/** Immediate Manager policy writes, separate from the employee configuration form. */
export function KnowledgePolicyPanel({ employeeId, tools }: { employeeId: string; tools: string[] }) {
  const { token, onUnauthorized } = useSession();
  const api = useMemo(() => createManagerApiClient({ getToken: () => token, onUnauthorized }), [token, onUnauthorized]);
  const knowledge = useKnowledgeApi();
  const base = `/api/manager/employees/${encodeURIComponent(employeeId)}`;
  const [whole, setWhole] = useState<WholeBinding[]>([]);
  const [policies, setPolicies] = useState<DocumentPolicy[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [space, setSpace] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    const [bindings, exceptions, spaces] = await Promise.all([
      api.listGet<WholeBinding>(`${base}/knowledge-bindings`),
      api.listGet<DocumentPolicy>(`${base}/knowledge-document-bindings`),
      knowledge.list(),
    ]);
    const id = spaces[0]?.knowledge_space_id;
    const docs = id ? await knowledge.listDocuments(id) : [];
    return { bindings: bindings.items, exceptions: exceptions.items, id, docs };
  }, [api, base, knowledge]);
  const apply = useCallback((data: Awaited<ReturnType<typeof load>>) => {
    setWhole(data.bindings); setPolicies(data.exceptions); setSpace(data.id); setDocuments(data.docs); setLoaded(true);
  }, []);
  useEffect(() => {
    let alive = true;
    setLoaded(false); setError(undefined);
    load().then((data) => { if (alive) apply(data); }).catch(() => { if (alive) setError("知识策略加载失败，未修改权限"); });
    return () => { alive = false; };
  }, [load, apply]);
  async function mutate(write: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await write(); apply(await load()); }
    catch { setLoaded(false); setError("知识策略更新或重新读取失败，请重新打开确认；不视为已成功"); }
    finally { setBusy(false); }
  }
  async function setWholePolicy(enabled: boolean) {
    if (!whole.length) {
      return api.post(`${base}/knowledge-bindings`, { body: { knowledge_space_id: space, enabled } });
    }
    // Known legacy keys all refer to the one enterprise capability. Do not
    // present it as allowed while another observed whole deny remains.
    for (const binding of whole) {
      await api.patch(`${base}/knowledge-bindings/${encodeURIComponent(binding.binding_id)}`, { body: { enabled } });
    }
  }
  const denied = whole.some((row) => !row.enabled || row.revoked_at);
  const operations = ["knowledge_search", "knowledge_get"].filter((name) => !denied && (!tools.length || tools.includes(name)));
  return <VStack gap={3}>
    <Heading level={3}>知识访问策略</Heading>
    <Text type="supporting">以下操作立即保存。未设置沿用企业默认；禁用或撤销保留拒绝记录，重建索引不会恢复权限。</Text>
    {error && <Banner status="error" title={error} />}
    {!loaded ? <Text>知识策略尚未载入</Text> : <>
      <Text>企业知识：{denied ? "已拒绝" : whole.length ? "显式允许" : "继承企业默认"}</Text>
      <Text>当前工具许可：{operations.join("、") || "无知识工具"}</Text>
      <HStack gap={2}>
        <Button type="button" label="允许知识能力" isDisabled={busy || !space} onClick={() => void mutate(() => setWholePolicy(true))} />
        <Button type="button" label="禁用知识能力" isDisabled={busy || !space} onClick={() => void mutate(() => setWholePolicy(false))} />
      </HStack>
      <Text type="supporting">单文档允许仍受上方知识能力、当前工具许可和文档就绪状态限制。企业文档删除在知识库页面执行。</Text>
      {documents.map((doc) => {
        const policy = policies.find((row) => row.document_id === doc.id);
        const state = policy?.revoked_at ? "已撤销" : policy?.enabled === false ? "已拒绝" : policy?.enabled === true ? "显式允许" : "继承";
        const path = `${base}/knowledge-document-bindings/${encodeURIComponent(doc.id)}`;
        return <VStack key={doc.id} gap={1}>
          <Text>{doc.display_name} · {doc.status} · {state}</Text>
          <HStack gap={2}>
            <Button type="button" label={`允许 ${doc.display_name}`} isDisabled={busy} onClick={() => void mutate(() => api.put(path, { body: { enabled: true } }))} />
            <Button type="button" label={`禁用 ${doc.display_name}`} isDisabled={busy} onClick={() => void mutate(() => api.put(path, { body: { enabled: false } }))} />
            <Button type="button" label={`撤销 ${doc.display_name}`} isDisabled={busy} onClick={() => void mutate(() => api.del(path))} />
          </HStack>
        </VStack>;
      })}
    </>}
  </VStack>;
}
