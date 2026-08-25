/**
 * 方案目录页（AITEAM-290 / GH#404）。
 *
 * 独立的行业方案入口：方案目录浏览 + 查看详情 + 一键应用 + 已应用方案实例只读展示。
 * 应用方案后提示可前往专家实例配置 Provider / LLM（AITEAM-683）。
 *
 * 设计对齐 PRD B06：方案定义在 Operator 端，Manager 端只可查看方案详情与应用方案，
 * 不能再编辑方案内容（不再提供实例编辑入口）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "../experts/useExpertsApi";
import { useGrantsApi } from "../grants/useGrantsApi";
import { useKnowledgeApi } from "../knowledge/useKnowledgeApi";
import type { Department, Member } from "../grants/types";
import type { KnowledgeSpace } from "../knowledge/types";
import type { SolutionInstance, SolutionPackage } from "../experts/types";

export function SolutionsPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useExpertsApi();
  const grantsApi = useGrantsApi();
  const knowledgeApi = useKnowledgeApi();

  const [solutions, setSolutions] = useState<SolutionPackage[]>([]);
  const [solutionInstances, setSolutionInstances] = useState<SolutionInstance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<SolutionPackage | null>(null);
  const [applyFor, setApplyFor] = useState<SolutionPackage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, si] = await Promise.all([api.listSolutions(), api.listSolutionInstances()]);
      setSolutions(s);
      setSolutionInstances(si);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => { void load(); }, [load]);

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>{i18n.t("manager.nav.solutions")}</Heading>
      {notice && (
        <Banner
          status="success"
          title={notice}
          endContent={
            <Button
              label={i18n.t("manager.experts.edit_config")}
              href="/experts"
              variant="ghost"
              size="sm"
              data-testid="goto-experts"
            />
          }
        />
      )}
      {error && <Banner status="error" title={error} />}

      <VStack gap={3}>
        <Heading level={2}>{i18n.t("manager.experts.solutions_title")}</Heading>
        {loading ? (
          <VStack gap={2} role="status" aria-label={i18n.t("manager.experts.loading")}>
            <Text color="secondary">{i18n.t("manager.experts.loading")}</Text>
            <Skeleton height={112} />
          </VStack>
        ) : solutions.length === 0 ? (
          <EmptyState headingLevel={3} title={i18n.t("manager.experts.solutions_empty")} />
        ) : (
          <Grid columns={{ minWidth: 300, repeat: "fit" }} gap={3}>
            {solutions.map((s) => (
              <Card
                key={`${s.solution_id}@${s.version}`}
                role="article"
                aria-label={s.display_name}
                data-testid="solution-row"
              >
                <VStack gap={3}>
                  <VStack gap={1}>
                    <Heading level={3}>{s.display_name}</Heading>
                    <Code>{s.solution_id}@{s.version}</Code>
                  </VStack>
                  {s.tags && s.tags.length > 0 && (
                    <HStack gap={1} wrap="wrap">
                      {s.tags.map((tag) => <Token key={tag} label={tag} size="sm" />)}
                    </HStack>
                  )}
                  <HStack gap={2} wrap="wrap">
                    <Button
                      label={i18n.t("manager.experts.view_detail")}
                      variant="secondary"
                      size="sm"
                      onClick={() => setDetailFor(s)}
                    />
                  {canWrite && (
                      <Button
                        label={i18n.t("manager.experts.apply")}
                        variant="primary"
                        size="sm"
                        onClick={() => setApplyFor(s)}
                      />
                  )}
                  </HStack>
                </VStack>
              </Card>
            ))}
          </Grid>
        )}
      </VStack>

      <VStack gap={3}>
        <Heading level={2}>{i18n.t("manager.experts.solution_instances_title")}</Heading>
        {loading ? (
          <Skeleton height={96} />
        ) : solutionInstances.length === 0 ? (
          <EmptyState headingLevel={3} title={i18n.t("manager.experts.solution_instances_empty")} />
        ) : (
          <Grid columns={{ minWidth: 300, repeat: "fit" }} gap={3}>
            {solutionInstances.map((si) => (
              <SolutionInstanceCard key={si.id} instance={si} />
            ))}
          </Grid>
        )}
      </VStack>

      {detailFor && (
        <SolutionDetailOverlay
          solution={detailFor}
          onClose={() => setDetailFor(null)}
        />
      )}
      {applyFor && (
        <SolutionApplyDialog
          solution={applyFor}
          api={api}
          grantsApi={grantsApi}
          knowledgeApi={knowledgeApi}
          onClose={() => setApplyFor(null)}
          onApplied={(warning) => {
            setApplyFor(null);
            if (warning) {
              setNotice(null);
              setError(warning);
            } else {
              setError(null);
              setNotice(i18n.t("manager.experts.apply_ok"));
            }
            void load();
          }}
        />
      )}
    </VStack>
  );
}

function SolutionApplyDialog({
  solution,
  api,
  grantsApi,
  knowledgeApi,
  onClose,
  onApplied,
}: {
  solution: SolutionPackage;
  api: ReturnType<typeof useExpertsApi>;
  grantsApi: ReturnType<typeof useGrantsApi>;
  knowledgeApi: ReturnType<typeof useKnowledgeApi>;
  onClose: () => void;
  onApplied: (warning?: string) => void;
}): ReactNode {
  const [members, setMembers] = useState<Member[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [knowledgeSpaces, setKnowledgeSpaces] = useState<KnowledgeSpace[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [knowledgeSpaceIds, setKnowledgeSpaceIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([grantsApi.listMembers(), grantsApi.listDepartments(), knowledgeApi.list()])
      .then(([loadedMembers, loadedDepartments, loadedKnowledgeSpaces]) => {
        if (!active) return;
        setMembers(loadedMembers);
        setDepartments(loadedDepartments);
        setKnowledgeSpaces(loadedKnowledgeSpaces);
      })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "加载授权目标或知识空间失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [grantsApi, knowledgeApi]);

  async function apply(): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      const result = await api.applySolution({
        solution_id: solution.solution_id,
        solution_version: solution.version,
        member_ids: memberIds,
        department_ids: departmentIds,
      });
      const employeeIds = result?.solution_instance?.expert_employee_ids
        ?? result?.experts?.map((expert) => expert.employee_id)
        ?? [];
      const failures: string[] = [];
      for (const knowledgeSpaceId of knowledgeSpaceIds) {
        for (const employeeId of employeeIds) {
          try {
            await knowledgeApi.bind(knowledgeSpaceId, { resource_type: "expert", resource_id: employeeId });
          } catch {
            failures.push(`${knowledgeSpaceId}/${employeeId}`);
          }
        }
      }
      onApplied(failures.length > 0
        ? `方案已应用，但 ${failures.length} 个知识绑定未完成；可在知识库页面为方案专家重试绑定。`
        : undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "应用方案失败");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog isOpen purpose="form" width={640} maxHeight="85vh" aria-label={`应用${solution.display_name}`} onOpenChange={(open) => { if (!open && !working) onClose(); }}>
      <VStack gap={4}>
        <DialogHeader title={`应用${solution.display_name}`} onOpenChange={(open) => { if (!open && !working) onClose(); }} />
        <Text color="secondary">应用后会在当前企业创建方案专家，并只给下方选中的成员/部门授权。可选知识空间会绑定到本次展开的全部专家；知识空间始终属于当前 tenant。</Text>
        {error && <Banner status="error" title={error} />}
        {loading ? <Text role="status">加载成员、部门和知识空间…</Text> : (
          <VStack gap={3}>
            <MultiSelector label="授权成员" options={members.map((member) => ({ value: member.id, label: member.display_name }))} value={memberIds} onChange={setMemberIds} triggerDisplay="labels" isOptional isDisabled={working} />
            <MultiSelector label="授权部门" options={departments.map((department) => ({ value: department.id, label: department.display_name }))} value={departmentIds} onChange={setDepartmentIds} triggerDisplay="labels" isOptional isDisabled={working} />
            <MultiSelector label="方案知识空间（可选）" options={knowledgeSpaces.map((space) => ({ value: space.knowledge_space_id, label: space.display_name || space.knowledge_space_id }))} value={knowledgeSpaceIds} onChange={setKnowledgeSpaceIds} triggerDisplay="labels" isOptional isDisabled={working} />
          </VStack>
        )}
        <HStack justify="end" gap={2}>
          <Button label="取消" variant="secondary" onClick={onClose} isDisabled={working} />
          <Button label="应用方案" variant="primary" onClick={() => void apply()} isLoading={working} isDisabled={loading || working || (!memberIds.length && !departmentIds.length)} />
        </HStack>
      </VStack>
    </Dialog>
  );
}

function SolutionDetailOverlay({ solution, onClose }: {
  solution: SolutionPackage;
  onClose: () => void;
}): ReactNode {
  const i18n = useI18n();
  const experts = solution.experts ?? [];
  const coordinator = solution.coordinator_template_id
    ? experts.find((expert) => expert.template_id === solution.coordinator_template_id)
    : undefined;
  return (
    <Dialog
      isOpen
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      purpose="info"
      width={720}
      maxHeight="85vh"
      aria-label={solution.display_name}
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title={solution.display_name}
            subtitle={`${solution.solution_id}@${solution.version}`}
            onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={5}>
              {solution.tags && solution.tags.length > 0 && (
                <HStack gap={1} wrap="wrap">
                  {solution.tags.map((tag) => <Token key={tag} label={tag} size="sm" />)}
                </HStack>
              )}
              <VStack gap={2}>
                <Heading level={3}>方案团队</Heading>
                {experts.length === 0 ? (
                  <EmptyState isCompact headingLevel={4} title="暂无方案专家" />
                ) : (
                  <Grid columns={{ minWidth: 240, repeat: "fit" }} gap={2}>
                    {experts.map((expert) => (
                      <Card key={`${expert.template_id}@${expert.version}`} variant="muted" padding={3}>
                        <VStack gap={1}>
                          <HStack gap={2} align="center" wrap="wrap">
                            <Text weight="bold">{expert.display_name}</Text>
                            {coordinator?.template_id === expert.template_id && <Badge label="协调专家" variant="info" />}
                            {expert.category && <Badge label={expert.category} />}
                          </HStack>
                          {expert.persona && <Text color="secondary">{expert.persona}</Text>}
                        </VStack>
                      </Card>
                    ))}
                  </Grid>
                )}
              </VStack>
              {(solution.coordinator_instructions || solution.output_requirements || solution.workflow_skill_ref) && (
                <MetadataList columns="single">
                  {solution.coordinator_instructions && (
                    <MetadataListItem label="协作说明"><Text color="secondary">{solution.coordinator_instructions}</Text></MetadataListItem>
                  )}
                  {solution.output_requirements && (
                    <MetadataListItem label="预期交付物"><Text color="secondary">{solution.output_requirements}</Text></MetadataListItem>
                  )}
                  {solution.workflow_skill_ref && (
                    <MetadataListItem label="方案工作流 Skill"><Code>{String(solution.workflow_skill_ref.skill_id ?? solution.workflow_skill_ref.id ?? "已配置")}</Code></MetadataListItem>
                  )}
                </MetadataList>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack justify="end">
              <Button label={i18n.t("manager.common.close")} onClick={onClose} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function SolutionInstanceCard({ instance }: { instance: SolutionInstance }): ReactNode {
  return (
    <Card role="article" aria-label={instance.display_name} data-testid="solution-instance-card">
      <VStack gap={3}>
        <HStack gap={2} align="center" wrap="wrap">
          <Heading level={3}>{instance.display_name}</Heading>
          <Badge label={instance.status} variant={instance.status === "applied" ? "success" : "neutral"} />
        </HStack>
        <Code>{instance.solution_id}@{instance.solution_version}</Code>
        <MetadataList columns="single">
          <MetadataListItem label="专家数量"><Text>{instance.expert_employee_ids.length}</Text></MetadataListItem>
          <MetadataListItem label="协调专家"><Code>{instance.coordinator_employee_id ?? "-"}</Code></MetadataListItem>
          {instance.coordinator_instructions && <MetadataListItem label="协作说明"><Text color="secondary">{instance.coordinator_instructions}</Text></MetadataListItem>}
          {instance.output_requirements && <MetadataListItem label="预期交付物"><Text color="secondary">{instance.output_requirements}</Text></MetadataListItem>}
        </MetadataList>
      </VStack>
    </Card>
  );
}
