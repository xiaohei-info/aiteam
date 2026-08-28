/** B07 记忆管理页 — 记忆条目列表 + CRUD + 搜索。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole, serviceUrl } from "@aiteam/shared";
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
import { useSession } from "../../auth/session";
import { useExpertsApi } from "../experts/useExpertsApi";
import { useMemoryApi } from "./useMemoryApi";
import type { MemoryItem } from "./types";

export function MemoryPage(): ReactNode {
  const { session } = useSession();
  const canManage = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useMemoryApi();
  const expertsApi = useExpertsApi();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [employees, setEmployees] = useState<Array<{ employee_id: string; display_name: string }>>([]);
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newEmployee, setNewEmployee] = useState("");
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [editContent, setEditContent] = useState("");

  const load = useCallback(async () => {
    if (!selectedEmployee) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try { setItems(await api.list({ employee_id: selectedEmployee, keyword: keyword || undefined })); } catch (err) {
      setError(err instanceof ApiError ? err.message : "记忆数据加载失败");
    } finally { setLoading(false); }
  }, [api, keyword, selectedEmployee]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void expertsApi.listEmployees().then((nextEmployees) => {
      setEmployees(nextEmployees);
      setSelectedEmployee((current) => current && nextEmployees.some((employee) => employee.employee_id === current)
        ? current : nextEmployees[0]?.employee_id ?? "");
    }).catch(() => {
      setEmployees([]);
      setSelectedEmployee("");
    });
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

  const handleDelete = useCallback(async (item: MemoryItem) => {
    setActionError(null);
    try { await api.delete(item.memory_id, item.employee_id); await load(); } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败，请重试");
    }
  }, [api, load]);

  const handleUpdate = useCallback(async () => {
    if (!editing || !editContent.trim()) return;
    setActionError(null);
    try {
      await api.update(editing.memory_id, { content: editContent.trim() }, editing.employee_id);
      setEditing(null);
      setEditContent("");
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "保存失败，请重试");
    }
  }, [api, editContent, editing, load]);

  return (
    <VStack gap={4}>
      <HStack justify="between" align="center">
        <Heading level={1}>记忆管理</Heading>
        <HStack gap={2}>
          {canManage && (
            <VStack gap={0} align="end">
              <a
                href={serviceUrl(9999, "/dashboard")}
                target="_blank"
                rel="noopener noreferrer"
                title="Hindsight 需要使用 HINDSIGHT_CP_ACCESS_KEY 配置的访问密钥登录；密钥不显示在页面中。"
              >
                打开 Hindsight 控制台
              </a>
              <Text type="supporting">访问密钥由 HINDSIGHT_CP_ACCESS_KEY 配置</Text>
            </VStack>
          )}
          <Button label="+ 新增记忆" variant="primary" size="sm" onClick={() => setShowForm(!showForm)} />
        </HStack>
      </HStack>
      <HStack gap={2} align="end">
        <Selector
          label="员工"
          options={employees.map((employee) => ({ value: employee.employee_id, label: employee.display_name || "未命名专家" }))}
          value={selectedEmployee || undefined}
          onChange={setSelectedEmployee}
          placeholder={employees.length === 0 ? "暂无可用专家" : "请选择专家"}
          isDisabled={employees.length === 0}
        />
        <TextInput label="搜索记忆内容" isLabelHidden placeholder="搜索记忆内容…" value={keyword} onChange={setKeyword} width="100%" />
        <Button label="搜索" variant="secondary" onClick={() => void load()} />
      </HStack>
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
        <Card key={m.memory_id} padding={4} data-testid="memory-item"><HStack justify="between" align="start"><VStack gap={1}>
          {editing?.memory_id === m.memory_id ? <VStack gap={2}><TextInput label="记忆内容" value={editContent} onChange={setEditContent} /><HStack gap={2}><Button label="保存" variant="primary" size="sm" onClick={() => void handleUpdate()} isDisabled={!editContent.trim()} /><Button label="取消" variant="secondary" size="sm" onClick={() => setEditing(null)} /></HStack></VStack> : <>
            <Text>{m.content}</Text>
            <Text type="supporting">专家：{employees.find((employee) => employee.employee_id === m.employee_id)?.display_name || "已删除专家"}</Text>
            <Text type="supporting">{[m.category, m.importance == null ? null : `重要度 ${m.importance}/5`, m.source, m.created_at?.slice(0, 10)].filter(Boolean).join(" · ")}</Text>
          </>}
        </VStack>{editing?.memory_id !== m.memory_id && <HStack gap={2}><Button label="编辑" variant="secondary" size="sm" isDisabled={m.category === "observation"} onClick={() => { setEditing(m); setEditContent(m.content); }} /><Button label="删除" variant="destructive" size="sm" onClick={() => void handleDelete(m)} /></HStack>}</HStack></Card>
      ))}</VStack>}
    </VStack>
  );
}
