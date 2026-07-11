/** 成员账号页：租户成员 CRUD；初始凭据仅成功后一次性展示。 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/CodeBlock";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
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
import type { CreateMemberInput, Department, Member } from "./types";

const ASSIGNABLE_ROLES = [
  EnterpriseRole.MEMBER,
  EnterpriseRole.FINANCE_ADMIN,
  EnterpriseRole.ENTERPRISE_ADMIN,
  EnterpriseRole.OWNER,
];

type MemberRow = Member & Record<string, unknown>;

export function MembersPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useMembersApi();
  const [members, setMembers] = useState<Member[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Member | null>(null);
  const [createdCredential, setCreatedCredential] = useState<{ account: string; password: string } | null>(null);

  const departmentNames = useMemo(
    () => new Map(departments.map((department) => [department.id, department.display_name])),
    [departments],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [memberItems, departmentItems] = await Promise.all([api.listMembers(), api.listDepartments()]);
      setMembers(memberItems);
      setDepartments(departmentItems);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.members.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

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
      setActionError(err instanceof ApiError ? err.message : i18n.t("manager.members.action_error"));
      return false;
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load]);

  const handleToggleStatus = useCallback(async (member: Member) => {
    setWorking(true);
    setActionError(null);
    try {
      await api.updateMember(member.id, { status: member.status === "active" ? "disabled" : "active" });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : i18n.t("manager.members.action_error"));
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load]);

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setWorking(true);
    setActionError(null);
    try {
      await api.deleteMember(pendingDelete.id);
      setPendingDelete(null);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : i18n.t("manager.members.action_error"));
    } finally {
      setWorking(false);
    }
  }, [api, i18n, load, pendingDelete]);

  const columns = useMemo<TableColumn<MemberRow>[]>(() => {
    const base: TableColumn<MemberRow>[] = [
      {
        key: "display_name",
        header: i18n.t("manager.members.col_name"),
        width: proportional(1),
        renderCell: (member) => <Text weight="bold" data-testid="member-row">{member.display_name || member.id}</Text>,
      },
      {
        key: "status",
        header: i18n.t("manager.members.col_status"),
        width: pixel(110),
        renderCell: (member) => <Badge label={member.status} variant={member.status === "active" ? "success" : "neutral"} />,
      },
      { key: "roles", header: i18n.t("manager.members.col_roles"), width: proportional(1), renderCell: (member) => member.roles.join(", ") },
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
        width: pixel(190),
        align: "end",
        resizable: false,
        renderCell: (member) => (
          <HStack gap={2} justify="end">
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
              isDisabled={working}
              onClick={() => setPendingDelete(member)}
            />
          </HStack>
        ),
      });
    }
    return base;
  }, [canWrite, departmentNames, handleToggleStatus, i18n, working]);

  return (
    <VStack as="section" gap={6}>
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

      {canWrite && <CreateMemberForm departments={departments} working={working} onCreate={handleCreate} />}
      {actionError && <Banner status="error" title={actionError} />}
      {error && <Banner status="error" title={error} />}

      {loading ? (
        <Card role="status" aria-label={i18n.t("manager.members.loading")}>
          <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
        </Card>
      ) : (
        <Card padding={0}>
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

      <AlertDialog
        isOpen={pendingDelete != null}
        onOpenChange={(isOpen) => { if (!isOpen && !working) setPendingDelete(null); }}
        title="删除成员"
        description={i18n.t("manager.members.delete_confirm")}
        cancelLabel={i18n.t("manager.members.delete_cancel")}
        actionLabel={i18n.t("manager.members.delete_confirm_ok")}
        isActionLoading={working}
        onAction={() => void handleDelete()}
      />
    </VStack>
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
  const [role, setRole] = useState<string>(EnterpriseRole.MEMBER);
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
              <Selector label={i18n.t("manager.members.role")} options={ASSIGNABLE_ROLES.map((value) => ({ value, label: value }))} value={role} onChange={setRole} isRequired isDisabled={working} />
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
