/** 组织架构页：Astryx TreeList 展示层级，并为员工分配部门。 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { TreeList, type TreeListItemData } from "@astryxdesign/core/TreeList";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";
import { useOrgApi } from "./useOrgApi";
import type { OrgTreeNode } from "./types";

interface DepartmentOption { id: string; name: string }

function collectDepartments(node: OrgTreeNode, output: DepartmentOption[]): void {
  if (node.type === "department") output.push({ id: node.id, name: node.name });
  node.children?.forEach((child) => collectDepartments(child, output));
}

interface AssignDialogProps {
  employee: OrgTreeNode;
  departments: DepartmentOption[];
  onClose: () => void;
  onAssign: (employeeId: string, departmentId: string) => Promise<string | null>;
}

function AssignDialog({ employee, departments, onClose, onAssign }: AssignDialogProps): ReactNode {
  const i18n = useI18n();
  const [departmentId, setDepartmentId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!departmentId) return;
    setPending(true);
    setError(null);
    const assignmentError = await onAssign(employee.id, departmentId);
    setPending(false);
    if (assignmentError) setError(assignmentError);
    else setDone(true);
  }

  return (
    <Dialog
      isOpen
      purpose="form"
      width={480}
      aria-label={i18n.t("manager.org.assign_title")}
      onOpenChange={(isOpen) => { if (!isOpen && !pending) onClose(); }}
      data-testid="assign-modal"
    >
      <Layout
        height="auto"
        header={<DialogHeader title={i18n.t("manager.org.assign_title")} onOpenChange={(isOpen) => { if (!isOpen && !pending) onClose(); }} />}
        content={
          <LayoutContent>
            <form id="assign-department-form" onSubmit={(event) => void submit(event)}>
              <VStack gap={4}>
                <Text>{employee.name}</Text>
                <FormLayout>
                  <Selector
                    label={i18n.t("manager.org.department_pick")}
                    options={departments.map((department) => ({ value: department.id, label: department.name }))}
                    value={departmentId || undefined}
                    onChange={setDepartmentId}
                    placeholder={i18n.t("manager.org.department_pick")}
                    data-testid="assign-department-select"
                    isRequired
                    isDisabled={pending || done}
                  />
                </FormLayout>
                {error && <Banner status="error" title={error} />}
                {done && <Banner status="success" title={i18n.t("manager.org.assign_ok")} data-testid="assign-success" />}
              </VStack>
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button label={i18n.t("common.cancel")} variant="ghost" isDisabled={pending} onClick={onClose} />
              <Button
                label={done ? i18n.t("manager.org.assign_ok") : i18n.t("manager.org.assign_submit")}
                type="submit"
                form="assign-department-form"
                variant="primary"
                isLoading={pending}
                isDisabled={done || !departmentId}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

export function OrgPage(): ReactNode {
  const i18n = useI18n();
  const api = useOrgApi();
  const [tree, setTree] = useState<OrgTreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<OrgTreeNode | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTree(await api.getTree());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.members.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => { void load(); }, [load]);

  const departments = useMemo(() => {
    if (!tree) return [];
    const output: DepartmentOption[] = [];
    collectDepartments(tree, output);
    return output;
  }, [tree]);

  const toTreeItem = useCallback((node: OrgTreeNode): TreeListItemData => ({
    id: node.id,
    label: node.name,
    description: node.type === "employee" ? node.status ?? undefined : undefined,
    startContent: <Badge label={node.type === "employee" ? "员工" : "部门"} variant={node.type === "employee" ? "blue" : "neutral"} />,
    endContent: node.type === "employee" && departments.length > 0 ? (
      <Button
        label={i18n.t("manager.org.assign")}
        variant="ghost"
        size="sm"
        data-testid={`assign-trigger-${node.id}`}
        onClick={(event) => { event.stopPropagation(); setAssignTarget(node); }}
      />
    ) : undefined,
    isExpanded: true,
    children: node.children?.map(toTreeItem),
  }), [departments.length, i18n]);

  const treeItems = useMemo(() => tree ? [toTreeItem(tree)] : [], [toTreeItem, tree]);

  const assign = useCallback(async (employeeId: string, departmentId: string): Promise<string | null> => {
    try {
      await api.assignDepartment(employeeId, departmentId);
      await load();
      return null;
    } catch (err) {
      return err instanceof ApiError ? err.message : i18n.t("manager.org.assign_error");
    }
  }, [api, i18n, load]);

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>组织架构</Heading>
      {error && <Banner status="error" title={error} />}
      {loading ? (
        <Card role="status" aria-label="组织架构加载中"><VStack gap={2}><Skeleton height={36} /><Skeleton height={90} index={1} /></VStack></Card>
      ) : tree ? (
        <Card>
          <TreeList items={treeItems} density="balanced" header={<Heading level={2}>组织树</Heading>} data-testid="org-tree" />
        </Card>
      ) : (
        <EmptyState headingLevel={2} title="暂无数据" />
      )}

      {assignTarget && (
        <AssignDialog
          employee={assignTarget}
          departments={departments}
          onClose={() => setAssignTarget(null)}
          onAssign={assign}
        />
      )}
    </VStack>
  );
}
