import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import { DocumentsPanel } from "./DocumentsPanel";
import type { KnowledgeBinding, KnowledgeSpace } from "./types";
import { useKnowledgeApi } from "./useKnowledgeApi";

interface ResourceOption { id: string; label: string }
type BindResourceType = "expert" | "department" | "member";
type KnowledgeSpaceRow = KnowledgeSpace & Record<string, unknown>;
type KnowledgeBindingRow = KnowledgeBinding & Record<string, unknown>;

const BIND_RESOURCE_TYPES: BindResourceType[] = ["expert", "department", "member"];
const RESOURCE_TYPE_LABEL: Record<BindResourceType, string> = {
  expert: "专家",
  department: "部门",
  member: "成员",
};

function resourceTypeLabel(type: string): string {
  return RESOURCE_TYPE_LABEL[type as BindResourceType] ?? type;
}

export function KnowledgePage(): ReactNode {
  const { session, token, onUnauthorized } = useSession();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useKnowledgeApi();

  const [items, setItems] = useState<KnowledgeSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeSpace | null>(null);
  const [docSpaceId, setDocSpaceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.list());
    } catch (err) {
      setItems([]);
      setError(err instanceof ApiError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const knowledgeSpaceId = newId.trim();
    const displayName = newName.trim();
    if (!knowledgeSpaceId) {
      setFormError("知识空间 ID 不能为空");
      return;
    }
    setWorking(true);
    setFormError(null);
    try {
      await api.create({ knowledge_space_id: knowledgeSpaceId, display_name: displayName || undefined });
      setNewId("");
      setNewName("");
      setShowCreate(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "创建失败");
    } finally {
      setWorking(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!pendingDelete) return;
    setWorking(true);
    setActionError(null);
    try {
      await api.del(pendingDelete.knowledge_space_id);
      setPendingDelete(null);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "删除失败");
    } finally {
      setWorking(false);
    }
  }

  const [bindingSpaceId, setBindingSpaceId] = useState<string | null>(null);
  const bindingSpaceIdRef = useRef<string | null>(null);
  const bindingRequestSequence = useRef(0);
  const bindingSpace = useMemo(
    () => items.find((space) => space.knowledge_space_id === bindingSpaceId) ?? null,
    [bindingSpaceId, items],
  );
  const [bindings, setBindings] = useState<KnowledgeBinding[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  const [experts, setExperts] = useState<ResourceOption[]>([]);
  const [departments, setDepartments] = useState<ResourceOption[]>([]);
  const [members, setMembers] = useState<ResourceOption[]>([]);
  const [bindType, setBindType] = useState<BindResourceType>("expert");
  const [bindResourceId, setBindResourceId] = useState("");
  const [bindError, setBindError] = useState<string | null>(null);
  const [bindNotice, setBindNotice] = useState<string | null>(null);
  const [pendingUnbind, setPendingUnbind] = useState<KnowledgeBinding | null>(null);

  const closeBindings = useCallback(() => {
    bindingRequestSequence.current += 1;
    bindingSpaceIdRef.current = null;
    setBindingSpaceId(null);
    setBindings([]);
    setExperts([]);
    setDepartments([]);
    setMembers([]);
    setBindingsLoading(false);
    setBindingsError(null);
    setBindError(null);
    setBindNotice(null);
    setBindResourceId("");
    setPendingUnbind(null);
  }, []);

  const openBindings = useCallback(async (id: string) => {
    const requestId = ++bindingRequestSequence.current;
    bindingSpaceIdRef.current = id;
    setBindingSpaceId(id);
    setBindings([]);
    setBindingsLoading(true);
    setBindingsError(null);
    setBindError(null);
    setBindNotice(null);
    setBindResourceId("");
    setBindType("expert");
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    try {
      const [employeePage, departmentPage, memberPage, bindingItems] = await Promise.all([
        client.listGet<{ employee_id?: string; display_name?: string }>("/api/manager/employees"),
        client.listGet<{ id: string; display_name: string }>("/api/manager/departments"),
        client.listGet<{ id: string; display_name: string }>("/api/manager/members"),
        api.listBindings(id),
      ]);
      if (requestId !== bindingRequestSequence.current || bindingSpaceIdRef.current !== id) return;
      setExperts((employeePage.items ?? []).map((employee) => ({
        id: employee.employee_id ?? "",
        label: employee.display_name ?? "未命名专家",
      })).filter((option) => option.id));
      setDepartments((departmentPage.items ?? []).map((department) => ({ id: department.id, label: department.display_name })));
      setMembers((memberPage.items ?? []).map((member) => ({ id: member.id, label: member.display_name })));
      setBindings(bindingItems);
    } catch (err) {
      if (requestId !== bindingRequestSequence.current || bindingSpaceIdRef.current !== id) return;
      setBindings([]);
      setBindingsError(err instanceof ApiError ? err.message : "加载绑定失败");
    } finally {
      if (requestId === bindingRequestSequence.current && bindingSpaceIdRef.current === id) setBindingsLoading(false);
    }
  }, [api, onUnauthorized, token]);

  const reloadBindings = useCallback(async (id: string) => {
    const requestId = ++bindingRequestSequence.current;
    setBindingsLoading(true);
    setBindingsError(null);
    try {
      const nextBindings = await api.listBindings(id);
      if (requestId !== bindingRequestSequence.current || bindingSpaceIdRef.current !== id) return;
      setBindings(nextBindings);
    } catch (err) {
      if (requestId !== bindingRequestSequence.current || bindingSpaceIdRef.current !== id) return;
      setBindings([]);
      setBindingsError(err instanceof ApiError ? err.message : "加载绑定失败");
    } finally {
      if (requestId === bindingRequestSequence.current && bindingSpaceIdRef.current === id) setBindingsLoading(false);
    }
  }, [api]);

  const resourceOptions = useMemo(() => {
    if (bindType === "expert") return experts;
    if (bindType === "department") return departments;
    return members;
  }, [bindType, departments, experts, members]);

  const resolveResourceLabel = useCallback((binding: KnowledgeBinding): string => {
    const options = binding.resource_type === "expert" ? experts : binding.resource_type === "department" ? departments : members;
    return options.find((option) => option.id === binding.resource_id)?.label ?? "已删除对象";
  }, [departments, experts, members]);

  async function handleBind(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const activeSpaceId = bindingSpaceIdRef.current;
    if (!activeSpaceId || !bindResourceId) {
      setBindError("请选择要绑定的目标");
      return;
    }
    setWorking(true);
    setBindError(null);
    setBindNotice(null);
    try {
      await api.bind(activeSpaceId, { resource_type: bindType, resource_id: bindResourceId });
      if (bindingSpaceIdRef.current !== activeSpaceId) return;
      setBindNotice("绑定成功");
      setBindResourceId("");
      await reloadBindings(activeSpaceId);
      await load();
    } catch (err) {
      if (bindingSpaceIdRef.current === activeSpaceId) setBindError(err instanceof ApiError ? err.message : "绑定失败");
    } finally {
      setWorking(false);
    }
  }

  async function handleUnbind(): Promise<void> {
    const activeSpaceId = bindingSpaceIdRef.current;
    if (!activeSpaceId || !pendingUnbind) return;
    const target = pendingUnbind;
    setWorking(true);
    setBindError(null);
    setBindNotice(null);
    try {
      await api.unbind(activeSpaceId, target.resource_type, target.resource_id);
      if (bindingSpaceIdRef.current !== activeSpaceId) return;
      setPendingUnbind(null);
      setBindNotice("已解绑");
      await reloadBindings(activeSpaceId);
      await load();
    } catch (err) {
      if (bindingSpaceIdRef.current === activeSpaceId) setBindError(err instanceof ApiError ? err.message : "解绑失败");
    } finally {
      setWorking(false);
    }
  }

  const bindingColumns = useMemo<TableColumn<KnowledgeBindingRow>[]>(() => {
    const result: TableColumn<KnowledgeBindingRow>[] = [
      { key: "resource_type", header: "类型", width: pixel(100), renderCell: (binding) => <Badge label={resourceTypeLabel(binding.resource_type)} variant="info" /> },
      { key: "resource_id", header: "对象", width: proportional(1), renderCell: resolveResourceLabel },
    ];
    if (canWrite) {
      result.push({
        key: "actions",
        header: "操作",
        width: pixel(100),
        align: "end",
        resizable: false,
        renderCell: (binding) => {
          const label = resolveResourceLabel(binding);
          return <Button label={`解绑${label}`} variant="destructive" size="sm" isDisabled={working} onClick={() => setPendingUnbind(binding)} />;
        },
      });
    }
    return result;
  }, [canWrite, resolveResourceLabel, working]);

  const spaceColumns = useMemo<TableColumn<KnowledgeSpaceRow>[]>(() => {
    const result: TableColumn<KnowledgeSpaceRow>[] = [
      { key: "display_name", header: "名称", width: proportional(2), renderCell: (space) => <Text weight="bold">{space.display_name || "未命名知识空间"}</Text> },
    ];
    result.push({
      key: "actions",
      header: "操作",
      width: pixel(canWrite ? 330 : 220),
      align: "end",
      resizable: false,
      renderCell: (space) => {
        const name = space.display_name || "未命名知识空间";
        return (
          <HStack gap={2} justify="end">
            <Button label={`管理${name}文档`} variant="ghost" size="sm" onClick={() => setDocSpaceId(space.knowledge_space_id)} />
            <Button label={`管理${name}绑定`} variant="ghost" size="sm" onClick={() => void openBindings(space.knowledge_space_id)} />
            {canWrite && <Button label={`删除${name}`} variant="destructive" size="sm" isDisabled={working} onClick={() => setPendingDelete(space)} />}
          </HStack>
        );
      },
    });
    return result;
  }, [canWrite, openBindings, working]);

  const documentSpace = items.find((space) => space.knowledge_space_id === docSpaceId) ?? null;

  return (
    <VStack as="section" gap={6}>
      <HStack justify="between" align="center">
        <VStack gap={1}>
          <Heading level={1}>企业 RAG 知识库</Heading>
          <Text type="supporting">此页面管理文档来源、就绪状态和授权绑定；引用正文请由用户端 Agent Pi 通过 knowledge_get 获取。</Text>
        </VStack>
        {canWrite && <Button label="新建知识空间" variant="primary" onClick={() => setShowCreate(true)} />}
      </HStack>

      {actionError && <Banner status="error" title={actionError} />}
      {error && <Banner status="error" title={error} />}

      {loading ? (
        <Card role="status" aria-label="正在加载知识空间">
          <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
        </Card>
      ) : (
        <Card padding={0}>
          <Table
            aria-label="知识空间"
            tableProps={{ "aria-label": "知识空间" }}
            data={items as KnowledgeSpaceRow[]}
            columns={spaceColumns}
            idKey="knowledge_space_id"
            hasHover
            emptyState={<EmptyState title="暂无知识空间" description="创建一个知识空间后即可管理绑定和文档。" isCompact />}
          />
        </Card>
      )}

      <Dialog
        isOpen={showCreate}
        aria-label="新建知识空间"
        onOpenChange={(isOpen) => { if (!isOpen && !working) setShowCreate(false); }}
        width={560}
        purpose="form"
      >
        <Layout
          height="auto"
          header={<DialogHeader title="新建知识空间" onOpenChange={(isOpen) => { if (!isOpen && !working) setShowCreate(false); }} />}
          content={
            <LayoutContent>
              <form aria-label="新建知识空间" onSubmit={(event) => void handleCreate(event)}>
                <VStack gap={4}>
                  <FormLayout>
                    <Grid columns={1} gap={3}>
                      <TextInput label="知识空间 ID" value={newId} onChange={setNewId} placeholder="ks-sales" isRequired isDisabled={working} />
                      <TextInput label="显示名称" value={newName} onChange={setNewName} placeholder="销售知识库" isOptional isDisabled={working} />
                    </Grid>
                  </FormLayout>
                  {formError && <Banner status="error" title={formError} />}
                  <HStack justify="end" gap={2}>
                    <Button label="取消" variant="ghost" isDisabled={working} onClick={() => setShowCreate(false)} />
                    <Button label="创建" type="submit" variant="primary" isLoading={working} />
                  </HStack>
                </VStack>
              </form>
            </LayoutContent>
          }
        />
      </Dialog>

      <Dialog
        isOpen={bindingSpace != null}
        aria-label={bindingSpace ? `绑定管理 · ${bindingSpace.display_name || "未命名知识空间"}` : "绑定管理"}
        onOpenChange={(isOpen) => { if (!isOpen && !working) closeBindings(); }}
        width={820}
        maxHeight="90vh"
        purpose="form"
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title={bindingSpace ? `绑定管理 · ${bindingSpace.display_name || "未命名知识空间"}` : "绑定管理"}
              onOpenChange={(isOpen) => { if (!isOpen && !working) closeBindings(); }}
            />
          }
          content={
            <LayoutContent>
              <VStack gap={4}>
                {bindNotice && <Banner status="success" title={bindNotice} />}
                {bindingsError && <Banner status="error" title={bindingsError} />}
                {bindError && <Banner status="error" title={bindError} />}

                {bindingsLoading ? (
                  <Card role="status" aria-label="正在加载绑定">
                    <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
                  </Card>
                ) : (
                  <Card padding={0}>
                    <Table
                      aria-label="当前绑定"
                      tableProps={{ "aria-label": "当前绑定" }}
                      data={bindings as KnowledgeBindingRow[]}
                      columns={bindingColumns}
                      idKey="id"
                      hasHover
                      emptyState={<EmptyState title="暂无绑定" isCompact />}
                    />
                  </Card>
                )}

                {canWrite ? (
                  <Card>
                    <form aria-label="新增绑定" onSubmit={(event) => void handleBind(event)}>
                      <VStack gap={4}>
                        <Heading level={3}>新增绑定</Heading>
                        <FormLayout>
                          <Grid columns={{ minWidth: 220, repeat: "fit" }} gap={3}>
                            <Selector
                              label="绑定类型"
                              options={BIND_RESOURCE_TYPES.map((type) => ({ value: type, label: RESOURCE_TYPE_LABEL[type] }))}
                              value={bindType}
                              onChange={(value) => { setBindType(value as BindResourceType); setBindResourceId(""); }}
                              isRequired
                              isDisabled={bindingsLoading || working}
                            />
                            <Selector
                              label="绑定对象"
                              options={resourceOptions.map((option) => ({ value: option.id, label: option.label || "未命名对象" }))}
                              value={bindResourceId || undefined}
                              onChange={setBindResourceId}
                              placeholder={resourceOptions.length === 0 ? "无可用目标" : "请选择"}
                              isRequired
                              isDisabled={bindingsLoading || working || resourceOptions.length === 0}
                            />
                          </Grid>
                        </FormLayout>
                        <HStack justify="end"><Button label="绑定" type="submit" variant="primary" isLoading={working} isDisabled={!bindResourceId} /></HStack>
                      </VStack>
                    </form>
                  </Card>
                ) : (
                  <Banner status="info" title="当前账号仅可查看绑定；新增或解除绑定需要企业管理员权限。" />
                )}
              </VStack>
            </LayoutContent>
          }
          footer={<LayoutFooter hasDivider><HStack justify="end"><Button label="关闭" variant="secondary" isDisabled={working} onClick={closeBindings} /></HStack></LayoutFooter>}
        />
      </Dialog>

      <AlertDialog
        isOpen={pendingDelete != null}
        onOpenChange={(isOpen) => { if (!isOpen && !working) setPendingDelete(null); }}
        title="删除知识空间"
        description="删除后，该知识空间及其配置将不可恢复。"
        cancelLabel="取消"
        actionLabel="确认删除"
        isActionLoading={working}
        onAction={() => void handleDelete()}
      />

      <AlertDialog
        isOpen={pendingUnbind != null}
        onOpenChange={(isOpen) => { if (!isOpen && !working) setPendingUnbind(null); }}
        title="解除知识绑定"
        description="解绑后，该对象将无法继续访问此知识空间。"
        cancelLabel="取消"
        actionLabel="确认解绑"
        isActionLoading={working}
        onAction={() => void handleUnbind()}
      />

      {documentSpace && (
        <DocumentsPanel
          spaceId={documentSpace.knowledge_space_id}
          spaceName={documentSpace.display_name || "未命名知识空间"}
          canWrite={canWrite}
          onClose={() => setDocSpaceId(null)}
        />
      )}
    </VStack>
  );
}
