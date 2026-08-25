/** 成员账号页：租户成员 CRUD；初始凭据仅成功后一次性展示。 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useMembersApi } from "./useMembersApi";
import type { CreateMemberInput, Department, Member, UpdateMemberInput } from "./types";

const ASSIGNABLE_ROLES: EnterpriseRole[] = [
  EnterpriseRole.MEMBER,
  EnterpriseRole.FINANCE_ADMIN,
  EnterpriseRole.ENTERPRISE_ADMIN,
  EnterpriseRole.OWNER,
];
const MAX_PROBLEM_DETAIL_LENGTH = 240;

type MemberRow = Member & Record<string, unknown>;

function isAssignableRole(value: string): value is EnterpriseRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

function normalizeRoles(roles: string[]): EnterpriseRole[] {
  return [...new Set(roles.filter(isAssignableRole))];
}

function problemDetail(error: ApiError): string {
  const detail = error.problem?.detail?.trim() || error.message.trim();
  return detail.slice(0, MAX_PROBLEM_DETAIL_LENGTH);
}

/** 将有限的网络/权限/冲突/服务不可用分支映射为有界页面提示。 */
function formatMemberError(
  error: unknown,
  fallback: string,
  translate: (key: string) => string,
): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0 || error.code === "network_error") {
    return translate("manager.members.offline");
  }

  const detail = problemDetail(error);
  if (error.status === 403) {
    return detail
      ? `${translate("manager.members.forbidden")}：${detail}`
      : translate("manager.members.forbidden");
  }
  if (error.status === 409 || error.code === "conflict" || error.code.includes("conflict")) {
    return detail
      ? `${translate("manager.members.conflict")}：${detail}`
      : translate("manager.members.conflict");
  }
  if (error.status === 503) {
    return detail
      ? `${translate("manager.members.service_unavailable")}：${detail}`
      : translate("manager.members.service_unavailable");
  }
  return detail || fallback;
}

export function MembersPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useMembersApi();
  const [members, setMembers] = useState<Member[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Member | null>(null);
  const [createdCredential, setCreatedCredential] = useState<{ account: string; password: string } | null>(null);

  const departmentNames = useMemo(
    () => new Map(departments.map((department) => [department.id, department.display_name])),
    [departments],
  );
  const translate = useCallback((key: string) => i18n.t(key), [i18n]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [memberItems, departmentItems] = await Promise.all([api.listMembers(), api.listDepartments()]);
      setMembers(memberItems);
      setDepartments(departmentItems);
    } catch (err) {
      setError(formatMemberError(err, i18n.t("manager.members.load_error"), translate));
    } finally {
      setLoading(false);
    }
  }, [api, i18n, translate]);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = useCallback(async (input: CreateMemberInput): Promise<boolean> => {
    setWorking(true);
    setActionError(null);
    try {
      await api.createMember(input);
      setCreatedCredential({ account: input.account, password: input.initial_password });
      await load();
      return true;
    } catch (err) {
      setActionError(formatMemberError(err, i18n.t("manager.members.action_error"), translate));
      return false;
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load, translate]);

  const handleEdit = useCallback(async (memberId: string, input: UpdateMemberInput): Promise<boolean> => {
    setWorking(true);
    setActionError(null);
    try {
      await api.updateMember(memberId, input);
      setEditingMember(null);
      await load();
      return true;
    } catch (err) {
      setActionError(formatMemberError(err, i18n.t("manager.members.action_error"), translate));
      return false;
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load, translate]);

  const handleToggleStatus = useCallback(async (member: Member) => {
    setWorking(true);
    setActionError(null);
    try {
      await api.updateMember(member.id, { status: member.status === "active" ? "disabled" : "active" });
      await load();
    } catch (err) {
      setActionError(formatMemberError(err, i18n.t("manager.members.action_error"), translate));
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load, translate]);

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setWorking(true);
    setActionError(null);
    try {
      await api.deleteMember(pendingDelete.id);
      setPendingDelete(null);
      await load();
    } catch (err) {
      setActionError(formatMemberError(err, i18n.t("manager.members.delete_error"), translate));
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load, pendingDelete, translate]);

  const openEdit = useCallback((member: Member) => {
    setActionError(null);
    setEditingMember(member);
  }, []);

  const columns = useMemo<TableColumn<MemberRow>[]>(() => {
    const base: TableColumn<MemberRow>[] = [
      {
        key: "display_name",
        header: i18n.t("manager.members.col_name"),
        width: proportional(1),
        renderCell: (member) => <Text weight="bold" data-testid="member-row">{member.display_name || "未命名成员"}</Text>,
      },
      {
        key: "status",
        header: i18n.t("manager.members.col_status"),
        width: pixel(110),
        renderCell: (member) => <Badge label={member.status} variant={member.status === "active" ? "success" : "neutral"} />,
      },
      {
        key: "roles",
        header: i18n.t("manager.members.col_roles"),
        width: proportional(1),
        renderCell: (member) => normalizeRoles(member.roles).join(", ") || "—",
      },
      {
        key: "department_ids",
        header: i18n.t("manager.members.col_departments"),
        width: proportional(1),
        renderCell: (member) => member.department_ids.map((id) => departmentNames.get(id) ?? id).join(", ") || "—",
      },
    ];
    if (canWrite) {
      base.push({
        key: "actions",
        header: i18n.t("manager.members.col_actions"),
        width: pixel(280),
        align: "end",
        resizable: false,
        renderCell: (member) => (
          <HStack gap={1} justify="end">
            <Button
              label={i18n.t("manager.members.edit")}
              variant="ghost"
              size="sm"
              data-testid={`member-edit-${member.id}`}
              isDisabled={working}
              onClick={() => openEdit(member)}
            />
            <Button
              label={member.status === "active" ? i18n.t("manager.members.disable") : i18n.t("manager.members.enable")}
              variant="ghost"
              size="sm"
              isDisabled={working}
              onClick={() => void handleToggleStatus(member)}
            />
            <Button
              label={i18n.t("manager.members.delete")}
              variant="destructive"
              size="sm"
              data-testid={`member-delete-${member.id}`}
              isDisabled={working}
              onClick={() => { setActionError(null); setPendingDelete(member); }}
            />
          </HStack>
        ),
      });
    }
    return base;
  }, [canWrite, departmentNames, handleToggleStatus, i18n, openEdit, working]);

  return (
    <VStack as="section" gap={6} data-testid="members-page">
      <Heading level={1}>{i18n.t("manager.nav.members")}</Heading>

      {createdCredential && (
        <Banner
          status="warning"
          title={i18n.t("manager.members.credential_once")}
          description={
            <VStack gap={1}>
              <Text>{i18n.t("manager.members.account")}：{createdCredential.account}</Text>
              <Text>{i18n.t("manager.members.initial_password")}：<Code>{createdCredential.password}</Code></Text>
            </VStack>
          }
          endContent={<Button label={i18n.t("manager.members.credential_dismiss")} variant="ghost" size="sm" onClick={() => setCreatedCredential(null)} />}
        />
      )}

      {!canWrite && <Banner status="info" title={i18n.t("manager.members.read_only")} />}
      {canWrite && <CreateMemberForm departments={departments} working={working} onCreate={handleCreate} />}
      {actionError && <Banner status="error" title={actionError} data-testid="members-action-error" />}
      {error && <Banner status="error" title={error} data-testid="members-error" />}

      {loading ? (
        <Card role="status" aria-label={i18n.t("manager.members.loading")} data-testid="members-loading">
          <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
        </Card>
      ) : error ? (
        <Card data-testid="members-error-state">
          <VStack gap={3} align="start">
            <Text>{i18n.t("manager.members.retry_description")}</Text>
            <Button label={i18n.t("common.retry")} variant="secondary" data-testid="members-retry" onClick={() => void load()} />
          </VStack>
        </Card>
      ) : members.length === 0 ? (
        <Card data-testid="members-empty">
          <EmptyState title={i18n.t("manager.members.empty")} description={i18n.t("manager.members.empty_description")} isCompact />
        </Card>
      ) : (
        <Card padding={0} data-testid="members-list">
          <Table
            aria-label={i18n.t("manager.nav.members")}
            tableProps={{ "aria-label": i18n.t("manager.nav.members") }}
            data={members as MemberRow[]}
            columns={columns}
            idKey="id"
            hasHover
            emptyState={<EmptyState title={i18n.t("manager.members.empty")} isCompact />}
          />
        </Card>
      )}

      {editingMember && (
        <MemberEditDialog
          member={editingMember}
          departments={departments}
          working={working}
          onClose={() => { if (!working) setEditingMember(null); }}
          onSave={(input) => handleEdit(editingMember.id, input)}
        />
      )}

      <AlertDialog
        isOpen={pendingDelete != null}
        onOpenChange={(isOpen) => { if (!isOpen && !working) setPendingDelete(null); }}
        title={i18n.t("manager.members.delete_title")}
        description={i18n.t("manager.members.delete_confirm")}
        cancelLabel={i18n.t("manager.members.delete_cancel")}
        actionLabel={i18n.t("manager.members.delete_confirm_ok")}
        isActionLoading={working}
        onAction={() => void handleDelete()}
      />
    </VStack>
  );
}

interface MemberEditDialogProps {
  member: Member;
  departments: Department[];
  working: boolean;
  onClose: () => void;
  onSave: (input: UpdateMemberInput) => Promise<boolean>;
}

function MemberEditDialog({ member, departments, working, onClose, onSave }: MemberEditDialogProps): ReactNode {
  const i18n = useI18n();
  const memberRoles = normalizeRoles(member.roles);
  const [displayName, setDisplayName] = useState(member.display_name);
  const [roles, setRoles] = useState<EnterpriseRole[]>(memberRoles.length > 0 ? memberRoles : [EnterpriseRole.MEMBER]);
  const [departmentIds, setDepartmentIds] = useState<string[]>(member.department_ids);
  const [validationError, setValidationError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(null);
    if (roles.length === 0) {
      setValidationError(i18n.t("manager.members.roles_required"));
      return;
    }
    await onSave({
      display_name: displayName.trim() || null,
      roles,
      department_ids: departmentIds,
    });
  }

  return (
    <Dialog
      isOpen
      purpose="form"
      width={620}
      maxHeight="90vh"
      aria-label={i18n.t("manager.members.edit_title")}
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      data-testid="member-editor"
    >
      <Layout
        height="auto"
        header={<DialogHeader title={i18n.t("manager.members.edit_title")} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} />}
        content={
          <LayoutContent>
            <form aria-label={i18n.t("manager.members.edit_title")} id="member-editor-form" onSubmit={(event) => void submit(event)}>
              <VStack gap={4}>
                {validationError && <Banner status="error" title={validationError} />}
                <FormLayout>
                  <TextInput
                    label={i18n.t("manager.members.display_name")}
                    value={displayName}
                    onChange={setDisplayName}
                    isOptional
                    isDisabled={working}
                    data-testid="member-display-name-input"
                  />
                  <MultiSelector
                    label={i18n.t("manager.members.roles")}
                    options={ASSIGNABLE_ROLES.map((value) => ({ value, label: value }))}
                    value={roles}
                    onChange={(values) => setRoles(values.filter(isAssignableRole))}
                    triggerDisplay="labels"
                    isRequired
                    isDisabled={working}
                    data-testid="member-roles-selector"
                  />
                  <MultiSelector
                    label={i18n.t("manager.members.col_departments")}
                    options={departments.map((department) => ({ value: department.id, label: department.display_name }))}
                    value={departmentIds}
                    onChange={setDepartmentIds}
                    triggerDisplay="labels"
                    isOptional
                    isDisabled={working}
                    data-testid="member-departments-selector"
                  />
                </FormLayout>
              </VStack>
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button label={i18n.t("manager.members.edit_cancel")} variant="ghost" isDisabled={working} onClick={onClose} />
              <Button
                label={i18n.t("manager.members.edit_save")}
                variant="primary"
                type="submit"
                form="member-editor-form"
                data-testid="member-edit-save"
                isLoading={working}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

interface CreateFormProps {
  departments: Department[];
  working: boolean;
  onCreate: (input: CreateMemberInput) => Promise<boolean>;
}

function CreateMemberForm({ departments, working, onCreate }: CreateFormProps): ReactNode {
  const i18n = useI18n();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<EnterpriseRole>(EnterpriseRole.MEMBER);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account.trim() || !password.trim()) return;
    const succeeded = await onCreate({
      account: account.trim(),
      initial_password: password,
      display_name: displayName.trim(),
      roles: [role],
      department_ids: departmentIds,
    });
    if (!succeeded) return;
    setAccount("");
    setPassword("");
    setDisplayName("");
    setRole(EnterpriseRole.MEMBER);
    setDepartmentIds([]);
  }

  return (
    <Card>
      <form aria-label={i18n.t("manager.members.create_title")} onSubmit={(event) => void submit(event)}>
        <VStack gap={4}>
          <Heading level={2}>{i18n.t("manager.members.create_title")}</Heading>
          <FormLayout>
            <Grid columns={{ minWidth: 240, repeat: "fit" }} gap={3}>
              <TextInput label={i18n.t("manager.members.account")} value={account} onChange={setAccount} isRequired isDisabled={working} />
              <TextInput label={i18n.t("manager.members.initial_password")} type="password" value={password} onChange={setPassword} isRequired isDisabled={working} />
              <TextInput label={i18n.t("manager.members.display_name")} value={displayName} onChange={setDisplayName} isOptional isDisabled={working} />
              <Selector
                label={i18n.t("manager.members.role")}
                options={ASSIGNABLE_ROLES.map((value) => ({ value, label: value }))}
                value={role}
                onChange={(value) => { if (isAssignableRole(value)) setRole(value); }}
                isRequired
                isDisabled={working}
              />
              {departments.length > 0 && (
                <MultiSelector
                  label={i18n.t("manager.members.col_departments")}
                  options={departments.map((department) => ({ value: department.id, label: department.display_name }))}
                  value={departmentIds}
                  onChange={setDepartmentIds}
                  triggerDisplay="labels"
                  isOptional
                  isDisabled={working}
                />
              )}
            </Grid>
          </FormLayout>
          <HStack justify="end"><Button label={i18n.t("manager.members.create_submit")} type="submit" variant="primary" isLoading={working} /></HStack>
        </VStack>
      </form>
    </Card>
  );
}
