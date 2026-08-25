/** B07 记忆管理页 — 记忆条目列表 + CRUD + 搜索。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useExpertsApi } from "../experts/useExpertsApi";
import { useMemoryApi } from "./useMemoryApi";
import type { MemoryItem } from "./types";

export function MemoryPage(): ReactNode {
  const api = useMemoryApi();
  const expertsApi = useExpertsApi();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [employees, setEmployees] = useState<Array<{ employee_id: string; display_name: string }>>([]);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newEmployee, setNewEmployee] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setItems(await api.list({ keyword: keyword || undefined })); } catch (err) {
      setError(err instanceof ApiError ? err.message : "记忆数据加载失败");
    } finally { setLoading(false); }
  }, [api, keyword]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void expertsApi.listEmployees().then(setEmployees).catch(() => setEmployees([]));
  }, [expertsApi]);

  const handleCreate = useCallback(async () => {
    if (!newEmployee || !newContent) return;
    setActionError(null);
    try {
      await api.create({ employee_id: newEmployee, content: newContent });
      setNewContent(""); setNewEmployee(""); setShowForm(false);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "创建失败，请重试");
    }
  }, [api, newEmployee, newContent, load]);

  const handleDelete = useCallback(async (id: string) => {
    setActionError(null);
    try { await api.delete(id); await load(); } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败，请重试");
    }
  }, [api, load]);

  return (
    <VStack gap={4}>
      <HStack justify="between" align="center"><Heading level={1}>记忆管理</Heading><Button label="+ 新增记忆" variant="primary" size="sm" onClick={() => setShowForm(!showForm)} /></HStack>
      <HStack gap={2} align="end"><TextInput label="搜索记忆内容" isLabelHidden placeholder="搜索记忆内容…" value={keyword} onChange={setKeyword} width="100%" /><Button label="搜索" variant="secondary" onClick={() => void load()} /></HStack>
      {error && <Banner status="error" title={error} />}
      {actionError && <Banner status="error" title={actionError} />}

      {showForm && (
        <Card padding={4}><VStack gap={3}><FormLayout><Selector
          label="专家"
          options={employees.map((employee) => ({ value: employee.employee_id, label: employee.display_name || "未命名专家" }))}
          value={newEmployee || undefined}
          onChange={setNewEmployee}
          placeholder={employees.length === 0 ? "暂无可用专家" : "请选择专家"}
          isRequired
        /><TextInput label="记忆内容" value={newContent} onChange={setNewContent} /></FormLayout><HStack gap={2}><Button label="保存" variant="primary" size="sm" onClick={() => void handleCreate()} isDisabled={!newEmployee || !newContent} /><Button label="取消" variant="secondary" size="sm" onClick={() => setShowForm(false)} /></HStack></VStack></Card>
      )}

      {loading ? <Card padding={4} role="status" aria-label="记忆加载中"><Skeleton height={80} /></Card> : items.length === 0 ? <EmptyState title="暂无记忆条目" /> : <VStack gap={2}>{items.map((m) => (
        <Card key={m.memory_id} padding={4} data-testid="memory-item"><HStack justify="between" align="start"><VStack gap={1}><Text>{m.content}</Text><Text type="supporting">专家：{employees.find((employee) => employee.employee_id === m.employee_id)?.display_name || "已删除专家"}</Text><Text type="supporting">{m.category} · 重要度 {m.importance}/5 · {m.source} · {m.created_at?.slice(0, 10)}</Text></VStack><Button label="删除" variant="destructive" size="sm" onClick={() => void handleDelete(m.memory_id)} /></HStack></Card>
      ))}</VStack>}
    </VStack>
  );
}
