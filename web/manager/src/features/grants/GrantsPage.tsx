/** 成员级授权页：将专家/方案实例授权给成员或部门。 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
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
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useGrantsApi } from "./useGrantsApi";
import type { Department, ExpertOption, Grant, GrantResourceType, Member, SolutionOption } from "./types";

type GrantRow = Grant & Record<string, unknown>;

export function GrantsPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useGrantsApi();
  const [grants, setGrants] = useState<Grant[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [experts, setExperts] = useState<ExpertOption[]>([]);
  const [solutions, setSolutions] = useState<SolutionOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<Grant | null>(null);

  const memberNames = useMemo(() => new Map(members.map((member) => [member.id, member.display_name])), [members]);
  const departmentNames = useMemo(() => new Map(departments.map((department) => [department.id, department.display_name])), [departments]);
  const expertNames = useMemo(() => new Map(experts.map((expert) => [expert.employee_id, expert.display_name])), [experts]);
  const solutionNames = useMemo(() => new Map(solutions.map((solution) => [solution.id, solution.display_name])), [solutions]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [grantItems, memberItems, departmentItems, expertItems, solutionItems] = await Promise.all([
        api.listGrants(),
        api.listMembers(),
        api.listDepartments(),
        api.listExperts(),
        api.listSolutions(),
      ]);
      setGrants(grantItems);
      setMembers(memberItems);
      setDepartments(departmentItems);
      setExperts(expertItems);
      setSolutions(solutionItems);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.grants.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => { void load(); }, [load]);

  const runAction = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setWorking(true);
    setActionError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : i18n.t("manager.grants.action_error"));
      return false;
    } finally {
      setWorking(false);
    }
  }, [i18n, load]);

  const revoke = useCallback(async () => {
    if (!pendingRevoke) return;
    const succeeded = await runAction(() => api.deleteGrant(pendingRevoke.id));
    if (succeeded) setPendingRevoke(null);
  }, [api, pendingRevoke, runAction]);

  const columns = useMemo<TableColumn<GrantRow>[]>(() => {
    const base: TableColumn<GrantRow>[] = [
      {
        key: "resource",
        header: i18n.t("manager.grants.col_resource"),
        width: proportional(1),
        renderCell: (grant) => (
          <HStack gap={2} align="center" data-testid="grant-row">
            <Badge label={grant.resource_type === "expert" ? i18n.t("manager.grants.type_expert") : i18n.t("manager.grants.type_solution")} variant="info" />
            <Text>{grant.resource_type === "expert"
              ? expertNames.get(grant.resource_id) ?? "已删除专家"
              : solutionNames.get(grant.resource_id) ?? "已删除方案"}</Text>
          </HStack>
        ),
      },
      {
        key: "member_ids",
        header: i18n.t("manager.grants.col_members"),
        width: proportional(1),
        renderCell: (grant) => grant.member_ids.map((id) => memberNames.get(id) ?? "已删除成员").join(", ") || "—",
      },
      {
        key: "department_ids",
        header: i18n.t("manager.grants.col_departments"),
        width: proportional(1),
        renderCell: (grant) => grant.department_ids.map((id) => departmentNames.get(id) ?? "已删除部门").join(", ") || "—",
      },
    ];
    if (canWrite) {
      base.push({
        key: "actions",
        header: i18n.t("manager.grants.col_actions"),
        width: pixel(110),
        align: "end",
        resizable: false,
        renderCell: (grant) => (
          <Button label={i18n.t("manager.grants.revoke")} variant="destructive" size="sm" isDisabled={working} onClick={() => setPendingRevoke(grant)} />
        ),
      });
    }
    return base;
  }, [canWrite, departmentNames, expertNames, i18n, memberNames, solutionNames, working]);

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>{i18n.t("manager.nav.grants")}</Heading>
      {canWrite && (
        <GrantForm
          experts={experts}
          solutions={solutions}
          members={members}
          departments={departments}
          working={working}
          onCreate={(input) => runAction(() => api.createGrant(input))}
        />
      )}
      {actionError && <Banner status="error" title={actionError} />}
      {error && <Banner status="error" title={error} />}
      {loading ? (
        <Card role="status" aria-label={i18n.t("manager.grants.loading")}>
          <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
        </Card>
      ) : (
        <Card padding={0}>
          <Table
            aria-label={i18n.t("manager.nav.grants")}
            tableProps={{ "aria-label": i18n.t("manager.nav.grants") }}
            data={grants as GrantRow[]}
            columns={columns}
            idKey="id"
            hasHover
            emptyState={<EmptyState title={i18n.t("manager.grants.empty")} isCompact />}
          />
        </Card>
      )}
      <AlertDialog
        isOpen={pendingRevoke != null}
        onOpenChange={(isOpen) => { if (!isOpen && !working) setPendingRevoke(null); }}
        title="撤销授权"
        description="撤销后，该成员或部门将无法继续使用此资源。"
        cancelLabel="取消"
        actionLabel="确认撤销"
        isActionLoading={working}
        onAction={() => void revoke()}
      />
    </VStack>
  );
}

interface GrantFormProps {
  experts: ExpertOption[];
  solutions: SolutionOption[];
  members: Member[];
  departments: Department[];
  working: boolean;
  onCreate: (input: { resource_type: GrantResourceType; resource_id: string; member_ids: string[]; department_ids: string[] }) => Promise<boolean>;
}

function GrantForm({ experts, solutions, members, departments, working, onCreate }: GrantFormProps): ReactNode {
  const i18n = useI18n();
  const [resourceType, setResourceType] = useState<GrantResourceType>("expert");
  const [resourceId, setResourceId] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);

  const resourceOptions = resourceType === "expert"
    ? experts.map((expert) => ({ value: expert.employee_id, label: expert.display_name || "未命名专家" }))
    : solutions.map((solution) => ({ value: solution.id, label: solution.display_name || "未命名方案" }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!resourceId || (memberIds.length === 0 && departmentIds.length === 0)) return;
    const succeeded = await onCreate({ resource_type: resourceType, resource_id: resourceId, member_ids: memberIds, department_ids: departmentIds });
    if (!succeeded) return;
    setResourceId("");
    setMemberIds([]);
    setDepartmentIds([]);
  }

  return (
    <Card>
      <form aria-label={i18n.t("manager.grants.create_title")} onSubmit={(event) => void submit(event)}>
        <VStack gap={4}>
          <Heading level={2}>{i18n.t("manager.grants.create_title")}</Heading>
          <FormLayout>
            <Grid columns={{ minWidth: 240, repeat: "fit" }} gap={3}>
              <Selector
                label={i18n.t("manager.grants.resource_type")}
                options={[
                  { value: "expert", label: i18n.t("manager.grants.type_expert") },
                  { value: "solution", label: i18n.t("manager.grants.type_solution") },
                ]}
                value={resourceType}
                onChange={(value) => { setResourceType(value as GrantResourceType); setResourceId(""); }}
                isRequired
                isDisabled={working}
              />
              <Selector
                label={i18n.t("manager.grants.resource")}
                options={resourceOptions}
                value={resourceId || undefined}
                onChange={setResourceId}
                placeholder={i18n.t("manager.grants.resource_pick")}
                data-testid="grant-resource"
                isRequired
                isDisabled={working}
              />
              <MultiSelector
                label={i18n.t("manager.grants.col_members")}
                options={members.map((member) => ({ value: member.id, label: member.display_name || "未命名成员" }))}
                value={memberIds}
                onChange={setMemberIds}
                triggerDisplay="labels"
                data-testid="grant-members"
                isOptional
                isDisabled={working}
              />
              <MultiSelector
                label={i18n.t("manager.grants.col_departments")}
                options={departments.map((department) => ({ value: department.id, label: department.display_name || "未命名部门" }))}
                value={departmentIds}
                onChange={setDepartmentIds}
                triggerDisplay="labels"
                data-testid="grant-departments"
                isOptional
                isDisabled={working}
              />
            </Grid>
          </FormLayout>
          <HStack justify="end"><Button label={i18n.t("manager.grants.create_submit")} type="submit" variant="primary" isLoading={working} /></HStack>
        </VStack>
      </form>
    </Card>
  );
}
