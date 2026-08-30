/** B07 记忆管理页 — 记忆条目列表 + CRUD + 搜索。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole, serviceUrl } from "@aiteam/shared";
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
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newEmployee, setNewEmployee] = useState("");
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [editContent, setEditContent] = useState("");
  const [detailItem, setDetailItem] = useState<MemoryItem | null>(null);

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
    if (!api.getAnalytics) {
      setAnalytics(null);
      return;
    }
    setAnalyticsError(null);
    void api.getAnalytics().then(setAnalytics).catch((err) => {
      setAnalytics(null);
      setAnalyticsError(err instanceof ApiError ? err.message : "Hindsight 统计暂不可用");
    });
  }, [api]);
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
        <TextInput label="搜索记忆内容" isLabelHidden placeholder="搜索记忆内容…" value={keyword} onChange={setKeyword} width="100%" />
        <Button label="搜索" variant="secondary" onClick={() => void load()} />
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
                    <Button label={`查看${employee.display_name}记忆`} variant="ghost" size="sm" onClick={() => setSelectedEmployee(employee.employee_id)} />
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

      {loading ? <Card padding={4} role="status" aria-label="记忆加载中"><Skeleton height={80} /></Card> : items.length === 0 ? <EmptyState title="暂无记忆条目" /> : <VStack gap={2}>{items.map((m) => (
        <Card key={m.memory_id} padding={4} data-testid="memory-item"><HStack justify="between" align="start"><VStack gap={1}>
          {editing?.memory_id === m.memory_id ? <VStack gap={2}><TextInput label="记忆内容" value={editContent} onChange={setEditContent} /><HStack gap={2}><Button label="保存" variant="primary" size="sm" onClick={() => void handleUpdate()} isDisabled={!editContent.trim()} /><Button label="取消" variant="secondary" size="sm" onClick={() => setEditing(null)} /></HStack></VStack> : <>
            <Text>{m.content}</Text>
            <Text type="supporting">专家：{employees.find((employee) => employee.employee_id === m.employee_id)?.display_name || "已删除专家"}</Text>
            <Text type="supporting">{[m.category, m.importance == null ? null : `重要度 ${formatImportance(m.importance)}`, m.state || "valid", m.source, formatDate(m.created_at)].filter(Boolean).join(" · ")}</Text>
          </>}
        </VStack>{editing?.memory_id !== m.memory_id && <HStack gap={2}><Button label={`查看详情${m.memory_id}`} variant="ghost" size="sm" onClick={() => setDetailItem(m)} />{canManage && <><Button label="编辑" variant="secondary" size="sm" isDisabled={m.category === "observation"} onClick={() => { setEditing(m); setEditContent(m.content); }} /><Button label="删除" variant="destructive" size="sm" onClick={() => void handleDelete(m)} /></>}</HStack>}</HStack></Card>
      ))}</VStack>}

      {detailItem && (
        <Dialog isOpen aria-label={`记忆详情 · ${detailItem.memory_id}`} onOpenChange={(open) => { if (!open) setDetailItem(null); }} width={620} maxHeight="80vh" purpose="form">
          <VStack gap={3}>
            <DialogHeader title="记忆详情" subtitle={detailItem.memory_id} onOpenChange={(open) => { if (!open) setDetailItem(null); }} />
            <Card><VStack gap={2}>
              <Text>{detailItem.content}</Text>
              <Text type="supporting">专家：{employees.find((employee) => employee.employee_id === detailItem.employee_id)?.display_name || "已删除专家"}</Text>
              <Text type="supporting">分类：{detailItem.category || "memory"} · 来源：{detailItem.source || "hindsight"}</Text>
              <Text type="supporting">重要度：{formatImportance(detailItem.importance)} · 状态：{detailItem.state || "valid"}</Text>
              <Text type="supporting">创建：{formatDate(detailItem.created_at)} · 最近使用：{formatDate(detailItem.last_used_at)}</Text>
            </VStack></Card>
            <HStack justify="end"><Button label="关闭" variant="secondary" onClick={() => setDetailItem(null)} /></HStack>
          </VStack>
        </Dialog>
      )}
    </VStack>
  );
}
