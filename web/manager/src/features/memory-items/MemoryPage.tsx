/** B07 记忆管理页 — 记忆条目列表 + CRUD + 搜索。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole, serviceUrl } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
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
import type { MemoryAnalytics, MemoryItem } from "./types";

function formatDate(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "暂无";
}

function formatImportance(value: number | null | undefined): string {
  return value == null ? "未标注" : value.toFixed(2);
}

export function MemoryPage(): ReactNode {
  const { session } = useSession();
  const canManage = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useMemoryApi();
  const expertsApi = useExpertsApi();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [analytics, setAnalytics] = useState<MemoryAnalytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Array<{ employee_id: string; display_name: string }>>([]);
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [detailEmployeeId, setDetailEmployeeId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newEmployee, setNewEmployee] = useState("");
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [editContent, setEditContent] = useState("");
  const [pendingDelete, setPendingDelete] = useState<MemoryItem | null>(null);

  const load = useCallback(async () => {
    if (!canManage) {
      setItems([]);
      setLoading(false);
      return;
    }
    if (!selectedEmployee || !detailEmployeeId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try { setItems(await api.list({ employee_id: selectedEmployee, keyword: keyword || undefined })); } catch (err) {
      setError(err instanceof ApiError ? err.message : "记忆数据加载失败");
    } finally { setLoading(false); }
  }, [api, canManage, detailEmployeeId, keyword, selectedEmployee]);

  useEffect(() => { void load(); }, [load]);
  const refreshAnalytics = useCallback(async (): Promise<void> => {
    if (!canManage || !api.getAnalytics) {
      setAnalytics(null);
      return;
    }
    setAnalyticsError(null);
    try {
      setAnalytics(await api.getAnalytics());
    } catch (err) {
      setAnalytics(null);
      setAnalyticsError(err instanceof ApiError ? err.message : "Hindsight 统计暂不可用");
    }
  }, [api, canManage]);

  useEffect(() => { void refreshAnalytics(); }, [refreshAnalytics]);
  useEffect(() => {
    if (!canManage) {
      setEmployees([]);
      setSelectedEmployee("");
      return;
    }
    void expertsApi.listEmployees().then((nextEmployees) => {
      setEmployees(nextEmployees);
      setSelectedEmployee((current) => current && nextEmployees.some((employee) => employee.employee_id === current)
        ? current : nextEmployees[0]?.employee_id ?? "");
    }).catch(() => {
      setEmployees([]);
      setSelectedEmployee("");
    });
  }, [canManage, expertsApi]);

  const handleCreate = useCallback(async () => {
    if (!newEmployee || !newContent) return;
    setActionError(null);
    try {
      await api.create({ employee_id: newEmployee, content: newContent });
      setNewContent(""); setNewEmployee(""); setShowForm(false);
      await Promise.all([load(), refreshAnalytics()]);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "创建失败，请重试");
    }
  }, [api, newEmployee, newContent, load, refreshAnalytics]);

  const handleDelete = useCallback(async (item: MemoryItem) => {
    setActionError(null);
    try { await api.delete(item.memory_id, item.employee_id); await Promise.all([load(), refreshAnalytics()]); } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败，请重试");
    }
  }, [api, load, refreshAnalytics]);

  const handleUpdate = useCallback(async () => {
    if (!editing || !editContent.trim()) return;
    setActionError(null);
    try {
      await api.update(editing.memory_id, { content: editContent.trim() }, editing.employee_id);
      setEditing(null);
      setEditContent("");
      await Promise.all([load(), refreshAnalytics()]);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "保存失败，请重试");
    }
  }, [api, editContent, editing, load, refreshAnalytics]);

  if (!canManage) {
    return <VStack gap={3}><Heading level={1}>记忆管理</Heading><Banner status="info" title="记忆管理仅对企业管理员开放。" /></VStack>;
  }

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
          {canManage && <Button label="+ 新增记忆" variant="primary" size="sm" onClick={() => setShowForm(!showForm)} />}
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
        <Button
          label="查看当前员工记忆"
          variant="secondary"
          onClick={() => setDetailEmployeeId(selectedEmployee || null)}
          isDisabled={!selectedEmployee}
        />
      </HStack>
      {error && <Banner status="error" title={error} />}
      {actionError && <Banner status="error" title={actionError} />}
      {analyticsError && <Banner status="info" title={analyticsError} />}
      {analytics?.status === "unavailable" && (
        <Banner status="info" title="Hindsight 暂不可用；稍后重试即可，当前不会伪造本地记忆数据。" />
      )}
      {analytics && analytics.status !== "unavailable" && (
        <VStack gap={3} aria-label="记忆统计">
          <Grid columns={{ minWidth: 180, repeat: "fit" }} gap={3}>
            <Card><VStack gap={1}><Text type="supporting">记忆总数</Text><Heading level={2}>{analytics.total_memory_count}</Heading><Text type="supporting">覆盖 {analytics.employee_count} 位专家</Text></VStack></Card>
            <Card><VStack gap={1}><Text type="supporting">当前专家</Text><Heading level={2}>{selectedEmployee ? (analytics.employees.find((item) => item.employee_id === selectedEmployee)?.memory_count ?? 0) : 0}</Heading><Text type="supporting">可按分类、状态和新鲜度查看</Text></VStack></Card>
            <Card><VStack gap={1}><Text type="supporting">统计时间</Text><Text weight="bold">{formatDate(analytics.refreshed_at)}</Text><Text type="supporting">来源：Manager Hindsight 只读投影</Text></VStack></Card>
          </Grid>
          {analytics.employees.length > 0 && (
            <Grid columns={{ minWidth: 260, repeat: "fit" }} gap={3}>
              {analytics.employees.map((employee) => (
                <Card key={employee.employee_id}>
                  <VStack gap={2}>
                    <HStack justify="between" align="center"><Text weight="bold">{employee.display_name}</Text><Text type="supporting">{employee.memory_count} 条</Text></HStack>
                    <Text type="supporting">分类：{Object.entries(employee.category_counts).map(([category, count]) => `${category} ${count}`).join(" · ") || "暂无"}</Text>
                    <Text type="supporting">状态：{Object.entries(employee.state_counts).map(([state, count]) => `${state} ${count}`).join(" · ") || "暂无"}</Text>
                    <Text type="supporting">最近创建 {formatDate(employee.latest_created_at)} · 最近使用 {formatDate(employee.latest_used_at)}</Text>
                    <Text type="supporting">平均重要度 {formatImportance(employee.average_importance)}</Text>
                    {employee.total_nodes != null && <Text type="supporting">图谱 {employee.total_nodes} 节点 · {employee.total_links ?? 0} 关系 · 观察 {employee.total_observations ?? 0}</Text>}
                    {employee.pending_operations != null && <Text type="supporting">后台任务：待处理 {employee.pending_operations} · 失败 {employee.failed_operations ?? 0}</Text>}
                    {employee.pending_consolidation != null && <Text type="supporting">归纳：待处理 {employee.pending_consolidation} · 失败 {employee.failed_consolidation ?? 0}</Text>}
                    <Button label={`查看${employee.display_name}记忆`} variant="ghost" size="sm" onClick={() => { setSelectedEmployee(employee.employee_id); setDetailEmployeeId(employee.employee_id); }} />
                  </VStack>
                </Card>
              ))}
            </Grid>
          )}
        </VStack>
      )}

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

      {detailEmployeeId && (
        <Dialog
          isOpen
          aria-label={`记忆列表 · ${employees.find((employee) => employee.employee_id === detailEmployeeId)?.display_name || analytics?.employees.find((employee) => employee.employee_id === detailEmployeeId)?.display_name || "员工"}`}
          onOpenChange={(open) => { if (!open) { setDetailEmployeeId(null); setEditing(null); } }}
          width={760}
          maxHeight="85vh"
          purpose="form"
        >
          <VStack gap={3}>
            <DialogHeader
              title={`记忆 · ${employees.find((employee) => employee.employee_id === detailEmployeeId)?.display_name || analytics?.employees.find((employee) => employee.employee_id === detailEmployeeId)?.display_name || "员工"}`}
              subtitle={`${items.length} 条记忆`}
              onOpenChange={(open) => { if (!open) { setDetailEmployeeId(null); setEditing(null); } }}
            />
            <HStack gap={2} align="end">
              <TextInput label="搜索记忆内容" placeholder="搜索记忆内容…" value={keyword} onChange={setKeyword} width="100%" />
              <Button label="搜索" variant="secondary" onClick={() => void load()} />
            </HStack>
            {loading ? <Card padding={4} role="status" aria-label="记忆加载中"><Skeleton height={80} /></Card> : items.length === 0 ? <EmptyState title="暂无记忆条目" /> : <VStack gap={2}>{items.map((m) => (
              <Card key={m.memory_id} padding={4} data-testid="memory-item"><HStack justify="between" align="start"><VStack gap={1}>
                {editing?.memory_id === m.memory_id ? <VStack gap={2}><TextInput label="记忆内容" value={editContent} onChange={setEditContent} /><HStack gap={2}><Button label="保存" variant="primary" size="sm" onClick={() => void handleUpdate()} isDisabled={!editContent.trim()} /><Button label="取消" variant="secondary" size="sm" onClick={() => setEditing(null)} /></HStack></VStack> : <>
                  <Text>{m.content}</Text>
                  <Text type="supporting">专家：{employees.find((employee) => employee.employee_id === m.employee_id)?.display_name || "已删除专家"}</Text>
                  <Text type="supporting">{[m.category, m.importance == null ? null : `重要度 ${formatImportance(m.importance)}`, m.state || "valid", m.source, formatDate(m.created_at)].filter(Boolean).join(" · ")}</Text>
                </>}
              </VStack>{editing?.memory_id !== m.memory_id && canManage && <HStack gap={2}><Button label="编辑" variant="secondary" size="sm" isDisabled={m.category === "observation"} onClick={() => { setEditing(m); setEditContent(m.content); }} /><Button label="删除" variant="destructive" size="sm" onClick={() => setPendingDelete(m)} /></HStack>}</HStack></Card>
            ))}</VStack>}
            <HStack justify="end"><Button label="关闭" variant="secondary" onClick={() => { setDetailEmployeeId(null); setEditing(null); }} /></HStack>
          </VStack>
        </Dialog>
      )}

      <AlertDialog
        isOpen={pendingDelete != null}
        title="删除记忆"
        description={pendingDelete ? `确定删除这条记忆吗？（${pendingDelete.content.slice(0, 80)}）` : "删除后记忆将被标记为无效。"}
        cancelLabel="取消"
        actionLabel="确认删除"
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        onAction={() => {
          const item = pendingDelete;
          setPendingDelete(null);
          if (item) void handleDelete(item);
        }}
      />
    </VStack>
  );
}
