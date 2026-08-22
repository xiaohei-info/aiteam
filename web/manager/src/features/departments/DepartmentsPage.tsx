/** Manager 部门管理：租户内部门 CRUD，不在本页虚构成员树或成员数据。 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { Link } from "react-router-dom";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useDepartmentsApi } from "./useDepartmentsApi";
import type { Department, UpdateDepartmentInput } from "./types";

type DepartmentRow = Department & Record<string, unknown>;

type EditorState =
  | { mode: "closed" }
  | { mode: "create"; departmentSlug: string; displayName: string }
  | { mode: "edit"; departmentId: string; departmentSlug: string; displayName: string };

const CLOSED_EDITOR: EditorState = { mode: "closed" };
const MAX_PROBLEM_DETAIL_LENGTH = 240;

function problemDetail(error: ApiError): string {
  const detail = error.problem?.detail?.trim() || error.message.trim();
  return detail.slice(0, MAX_PROBLEM_DETAIL_LENGTH);
}

/** 将有限的网络/权限/冲突/服务不可用分支映射为可操作的页面提示。 */
function formatDepartmentError(
  error: unknown,
  fallback: string,
  translate: (key: string) => string,
): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0 || error.code === "network_error") {
    return translate("manager.departments.offline");
  }

  const detail = problemDetail(error);
  if (error.status === 403) {
    return detail
      ? `${translate("manager.departments.forbidden")}：${detail}`
      : translate("manager.departments.forbidden");
  }
  if (error.status === 409 || error.code === "conflict" || error.code.includes("conflict")) {
    return detail
      ? `${translate("manager.departments.conflict")}：${detail}`
      : translate("manager.departments.conflict");
  }
  if (error.status === 503) {
    return detail
      ? `${translate("manager.departments.service_unavailable")}：${detail}`
      : translate("manager.departments.service_unavailable");
  }
  return detail || fallback;
}

export function DepartmentsPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const api = useDepartmentsApi();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(CLOSED_EDITOR);
  const [pendingDelete, setPendingDelete] = useState<Department | null>(null);

  const translate = useCallback((key: string) => i18n.t(key), [i18n]);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDepartments(await api.listDepartments());
    } catch (err) {
      setError(formatDepartmentError(err, i18n.t("manager.departments.load_error"), translate));
    } finally {
      setLoading(false);
    }
  }, [api, i18n, translate]);

  useEffect(() => { void load(); }, [load]);

  const openCreate = useCallback(() => {
    setActionError(null);
    setNotice(null);
    setEditor({ mode: "create", departmentSlug: "", displayName: "" });
  }, []);

  const openEdit = useCallback((department: Department) => {
    setActionError(null);
    setNotice(null);
    setEditor({
      mode: "edit",
      departmentId: department.id,
      departmentSlug: department.department_slug,
      displayName: department.display_name,
    });
  }, []);

  const closeEditor = useCallback(() => {
    if (!working) setEditor(CLOSED_EDITOR);
  }, [working]);

  const updateEditor = useCallback((field: "departmentSlug" | "displayName", value: string) => {
    setEditor((current) => current.mode === "closed" ? current : { ...current, [field]: value });
  }, []);

  const submitEditor = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editor.mode === "closed") return;

    const departmentSlug = editor.departmentSlug.trim();
    const displayName = editor.displayName.trim();
    if (editor.mode === "create" && !departmentSlug) {
      setActionError(i18n.t("manager.departments.slug_required"));
      return;
    }

    setWorking(true);
    setActionError(null);
    setNotice(null);
    try {
      if (editor.mode === "create") {
        await api.createDepartment({ department_slug: departmentSlug, display_name: displayName });
        setNotice(i18n.t("manager.departments.create_ok"));
      } else {
        const input: UpdateDepartmentInput = { display_name: displayName };
        await api.updateDepartment(editor.departmentId, input);
        setNotice(i18n.t("manager.departments.update_ok"));
      }
      setEditor(CLOSED_EDITOR);
      await load();
    } catch (err) {
      setActionError(formatDepartmentError(err, i18n.t("manager.departments.action_error"), translate));
    } finally {
      setWorking(false);
    }
  }, [api, editor, i18n, load, translate]);

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setWorking(true);
    setActionError(null);
    try {
      await api.deleteDepartment(pendingDelete.id);
      setPendingDelete(null);
      setNotice(i18n.t("manager.departments.delete_ok"));
      await load();
    } catch (err) {
      setActionError(formatDepartmentError(err, i18n.t("manager.departments.delete_error"), translate));
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load, pendingDelete, translate]);

  const columns = useMemo<TableColumn<DepartmentRow>[]>(() => {
    const base: TableColumn<DepartmentRow>[] = [
      {
        key: "department_slug",
        header: i18n.t("manager.departments.col_slug"),
        width: proportional(1),
        renderCell: (department) => <Code>{department.department_slug}</Code>,
      },
      {
        key: "display_name",
        header: i18n.t("manager.departments.col_name"),
        width: proportional(1),
        renderCell: (department) => (
          <Text weight="bold" data-testid="department-row" data-department-id={department.id}>
            {department.display_name || department.department_slug}
          </Text>
        ),
      },
      {
        key: "created_at",
        header: i18n.t("manager.departments.col_created"),
        width: proportional(1),
        renderCell: (department) => department.created_at || "—",
      },
    ];
    if (canWrite) {
      base.push({
        key: "actions",
        header: i18n.t("manager.departments.col_actions"),
        width: pixel(170),
        align: "end",
        resizable: false,
        renderCell: (department) => (
          <HStack gap={1} justify="end">
            <Button
              label={i18n.t("manager.departments.edit")}
              variant="ghost"
              size="sm"
              data-testid={`department-edit-${department.id}`}
              isDisabled={working}
              onClick={() => openEdit(department)}
            />
            <Button
              label={i18n.t("manager.departments.delete")}
              variant="destructive"
              size="sm"
              data-testid={`department-delete-${department.id}`}
              isDisabled={working}
              onClick={() => { setActionError(null); setPendingDelete(department); }}
            />
          </HStack>
        ),
      });
    }
    return base;
  }, [canWrite, i18n, openEdit, working]);

  const editorTitle = editor.mode === "create"
    ? i18n.t("manager.departments.create_title")
    : i18n.t("manager.departments.edit_title");

  return (
    <VStack as="section" gap={6} data-testid="departments-page">
      <HStack justify="between" align="start" wrap="wrap" gap={3}>
        <VStack gap={1}>
          <Heading level={1}>{i18n.t("manager.nav.departments")}</Heading>
          <Text type="supporting">{i18n.t("manager.departments.description")}</Text>
        </VStack>
        {canWrite && (
          <Button
            label={i18n.t("manager.departments.create")}
            variant="primary"
            data-testid="department-create-trigger"
            onClick={openCreate}
          />
        )}
      </HStack>

      <Banner status="info" title={i18n.t("manager.departments.member_assignment")} />
      <Text type="supporting">
        <Link to="/members">{i18n.t("manager.departments.open_members")}</Link>
      </Text>
      {!canWrite && <Banner status="info" title={i18n.t("manager.departments.read_only")} />}
      {notice && <Banner status="success" title={notice} data-testid="departments-notice" />}
      {actionError && <Banner status="error" title={actionError} data-testid="departments-action-error" />}
      {error && <Banner status="error" title={error} data-testid="departments-error" />}

      {loading ? (
        <Card role="status" aria-label={i18n.t("manager.departments.loading")} data-testid="departments-loading">
          <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /><Skeleton height={36} index={2} /></VStack>
        </Card>
      ) : error ? (
        <Card data-testid="departments-error-state">
          <VStack gap={3} align="start">
            <Text>{i18n.t("manager.departments.retry_description")}</Text>
            <Button label={i18n.t("common.retry")} variant="secondary" data-testid="departments-retry" onClick={() => void load()} />
          </VStack>
        </Card>
      ) : departments.length === 0 ? (
        <Card data-testid="departments-empty">
          <EmptyState title={i18n.t("manager.departments.empty")} description={i18n.t("manager.departments.empty_description")} isCompact />
        </Card>
      ) : (
        <Card padding={0} data-testid="departments-list">
          <Table
            aria-label={i18n.t("manager.nav.departments")}
            tableProps={{ "aria-label": i18n.t("manager.nav.departments") }}
            data={departments as DepartmentRow[]}
            columns={columns}
            idKey="id"
            hasHover
          />
        </Card>
      )}

      {editor.mode !== "closed" && (
        <Dialog
          isOpen
          purpose="form"
          width={560}
          aria-label={editorTitle}
          onOpenChange={(isOpen) => { if (!isOpen) closeEditor(); }}
          data-testid="department-editor"
        >
          <Layout
            height="auto"
            header={<DialogHeader title={editorTitle} onOpenChange={(isOpen) => { if (!isOpen) closeEditor(); }} />}
            content={
              <LayoutContent>
                <form id="department-editor-form" onSubmit={(event) => void submitEditor(event)}>
                  <VStack gap={4}>
                    <FormLayout>
                      <TextInput
                        label={i18n.t("manager.departments.slug")}
                        value={editor.departmentSlug}
                        onChange={(value) => updateEditor("departmentSlug", value)}
                        isRequired={editor.mode === "create"}
                        isDisabled={working || editor.mode === "edit"}
                        data-testid="department-slug-input"
                      />
                      {editor.mode === "create" && <Text type="supporting">{i18n.t("manager.departments.slug_hint")}</Text>}
                      <TextInput
                        label={i18n.t("manager.departments.display_name")}
                        value={editor.displayName}
                        onChange={(value) => updateEditor("displayName", value)}
                        isDisabled={working}
                        data-testid="department-name-input"
                      />
                    </FormLayout>
                  </VStack>
                </form>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <HStack gap={2} justify="end">
                  <Button label={i18n.t("manager.departments.cancel")} variant="ghost" isDisabled={working} onClick={closeEditor} />
                  <Button
                    label={i18n.t("manager.departments.save")}
                    variant="primary"
                    type="submit"
                    form="department-editor-form"
                    data-testid="department-save"
                    isLoading={working}
                  />
                </HStack>
              </LayoutFooter>
            }
          />
        </Dialog>
      )}

      <AlertDialog
        isOpen={pendingDelete != null}
        title={i18n.t("manager.departments.delete_title")}
        description={pendingDelete
          ? `${i18n.t("manager.departments.delete_confirm")}（${pendingDelete.display_name || pendingDelete.department_slug}）`
          : i18n.t("manager.departments.delete_confirm")}
        cancelLabel={i18n.t("manager.departments.delete_cancel")}
        actionLabel={i18n.t("manager.departments.delete_confirm_ok")}
        isActionLoading={working}
        onOpenChange={(isOpen) => { if (!isOpen && !working) setPendingDelete(null); }}
        onAction={() => void handleDelete()}
      />
    </VStack>
  );
}
