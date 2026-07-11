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
import type { SolutionInstance, SolutionPackage } from "../experts/types";

export function SolutionsPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useExpertsApi();

  const [solutions, setSolutions] = useState<SolutionPackage[]>([]);
  const [solutionInstances, setSolutionInstances] = useState<SolutionInstance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<SolutionPackage | null>(null);

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

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, successKey: string) => {
      setActionError(null);
      setNotice(null);
      try {
        await fn();
        setNotice(i18n.t(successKey));
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.experts.action_error"));
      }
    },
    [i18n, load],
  );

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
      {actionError && <Banner status="error" title={actionError} />}
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
                        clickAction={() => runAction(
                          () => api.applySolution({ solution_id: s.solution_id }),
                          "manager.experts.apply_ok",
                        )}
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
    </VStack>
  );
}

function SolutionDetailOverlay({ solution, onClose }: {
  solution: SolutionPackage; onClose: () => void;
}): ReactNode {
  const i18n = useI18n();
  const experts = solution.experts ?? [];
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
                <Heading level={3}>{i18n.t("manager.experts.detail_experts")}</Heading>
                {experts.length === 0 ? (
                  <EmptyState isCompact headingLevel={4} title={i18n.t("manager.experts.detail_no_experts")} />
                ) : (
                  <Grid columns={{ minWidth: 240, repeat: "fit" }} gap={2}>
                    {experts.map((expert) => (
                      <Card key={`${expert.template_id}@${expert.version}`} variant="muted" padding={3}>
                        <VStack gap={1}>
                          <HStack gap={2} align="center" wrap="wrap">
                            <Text weight="bold">{expert.display_name}</Text>
                            {expert.category && <Badge label={expert.category} />}
                          </HStack>
                          {expert.persona && <Text color="secondary">{expert.persona}</Text>}
                        </VStack>
                      </Card>
                    ))}
                  </Grid>
                )}
              </VStack>

              <MetadataList columns="single">
                <MetadataListItem label={i18n.t("manager.experts.detail_knowledge_refs")}>
                  <HStack gap={1} wrap="wrap">
                    {(solution.knowledge_refs ?? []).length > 0
                      ? solution.knowledge_refs!.map((ref) => <Code key={ref}>{ref}</Code>)
                      : <Text color="secondary">-</Text>}
                  </HStack>
                </MetadataListItem>
                <MetadataListItem label={i18n.t("manager.experts.detail_skill_refs")}>
                  <HStack gap={1} wrap="wrap">
                    {(solution.skill_refs ?? []).length > 0
                      ? solution.skill_refs!.map((ref) => <Code key={ref}>{ref}</Code>)
                      : <Text color="secondary">-</Text>}
                  </HStack>
                </MetadataListItem>
              </MetadataList>

              {(solution.planner_prompt || solution.subtask_prompt || solution.aggregate_prompt) && (
                <VStack gap={3}>
                  <PromptCard label={i18n.t("manager.experts.planner_prompt")} value={solution.planner_prompt} />
                  <PromptCard label={i18n.t("manager.experts.subtask_prompt")} value={solution.subtask_prompt} />
                  <PromptCard label={i18n.t("manager.experts.aggregate_prompt")} value={solution.aggregate_prompt} />
                </VStack>
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

function PromptCard({ label, value }: { label: string; value?: string | null }): ReactNode {
  if (!value) return null;
  return (
    <Card variant="muted" padding={3}>
      <VStack gap={1}>
        <Text weight="bold">{label}</Text>
        <Text color="secondary" as="p">{value}</Text>
      </VStack>
    </Card>
  );
}

function SolutionInstanceCard({ instance }: { instance: SolutionInstance }): ReactNode {
  const i18n = useI18n();
  return (
    <Card
      role="article"
      aria-label={instance.display_name}
      data-testid="solution-instance-card"
    >
      <VStack gap={3}>
        <HStack gap={2} align="center" wrap="wrap">
          <Heading level={3}>{instance.display_name}</Heading>
          <Badge
            label={instance.status}
            variant={instance.status === "active" ? "success" : "neutral"}
          />
        </HStack>
        <Code>{instance.solution_id}@{instance.solution_version}</Code>
        <MetadataList columns="single">
          <MetadataListItem label={i18n.t("manager.experts.expert_count")}>
            <VStack gap={1}>
              <Text>{instance.expert_employee_ids.length}</Text>
              {instance.expert_employee_ids.length > 0 && (
                <HStack gap={1} wrap="wrap">
                  {instance.expert_employee_ids.map((id) => <Code key={id}>{id}</Code>)}
                </HStack>
              )}
            </VStack>
          </MetadataListItem>
          <MetadataListItem label={i18n.t("manager.experts.solution_knowledge_refs")}>
            <Text color="secondary">{instance.knowledge_refs.join(", ") || "-"}</Text>
          </MetadataListItem>
          <MetadataListItem label={i18n.t("manager.experts.solution_skill_refs")}>
            <Text color="secondary">{instance.skill_refs.join(", ") || "-"}</Text>
          </MetadataListItem>
          {(instance.planner_prompt || instance.subtask_prompt || instance.aggregate_prompt) && (
            <MetadataListItem label={i18n.t("manager.experts.planner_prompt")}>
              <Text color="secondary">{instance.planner_prompt?.slice(0, 40) || "-"}…</Text>
            </MetadataListItem>
          )}
        </MetadataList>
      </VStack>
    </Card>
  );
}
