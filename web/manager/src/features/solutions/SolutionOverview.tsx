/**
 * 方案概览：类型、成员与群主、群聊编排规则、推荐的 skill / MCP 及其在本企业的状态。
 * 方案详情与「应用方案」弹窗共用同一信息结构（设计 §3.4 / §3.7）。
 */
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { SkillCatalog } from "../capability/types";
import type { SolutionPackage } from "../experts/types";
import { capabilityName, capabilityStatus, renderRules, solutionModeLabel } from "./solutionInfo";

export function SolutionOverview({ solution, skills, compact = false }: {
  solution: SolutionPackage;
  /** 本企业技能目录；null 表示读取失败，skill 状态显示「无法确认」。 */
  skills: readonly SkillCatalog[] | null;
  /** 应用弹窗里只列名字，不展开专家介绍。 */
  compact?: boolean;
}): ReactNode {
  const navigate = useNavigate();
  const experts = (solution.experts ?? []).filter((expert) => expert.enabled !== false);
  const solo = solution.mode === "solo";
  const capabilities = solution.recommended_capabilities ?? [];
  const names = new Map(experts.map((expert) => [expert.template_id, expert.display_name]));
  return (
    <VStack gap={4} data-testid="solution-overview">
      <HStack gap={2} align="center" wrap="wrap">
        <Badge label={`${solutionModeLabel(solution.mode)}方案`} variant="info" />
        <Text type="supporting" color="secondary">
          {solo ? "应用后得到 1 位专家，成员直接与其私聊，不建群" : "应用后成员可一键建群，由群主按编排规则组织协作"}
        </Text>
      </HStack>

      <VStack gap={2}>
        <Heading level={compact ? 4 : 3}>{solo ? "专家" : "成员与群主"}</Heading>
        {experts.length === 0 ? (
          <EmptyState isCompact headingLevel={4} title="暂无方案专家" />
        ) : compact ? (
          <HStack gap={2} wrap="wrap" data-testid="solution-overview-members">
            {experts.map((expert) => (
              <HStack key={expert.template_id} gap={1} align="center">
                <Text weight="bold">{expert.display_name}</Text>
                {!solo && expert.template_id === solution.coordinator_template_id && <Badge label="群主" variant="info" />}
              </HStack>
            ))}
          </HStack>
        ) : (
          <Grid columns={{ minWidth: 240, repeat: "fit" }} gap={2} data-testid="solution-overview-members">
            {experts.map((expert) => (
              <Card key={`${expert.template_id}@${expert.version}`} variant="muted" padding={3}>
                <VStack gap={1}>
                  <HStack gap={2} align="center" wrap="wrap">
                    <Text weight="bold">{expert.display_name}</Text>
                    {!solo && expert.template_id === solution.coordinator_template_id && <Badge label="群主" variant="info" />}
                    {expert.category && <Badge label={expert.category} />}
                  </HStack>
                  {expert.persona && <Text color="secondary">{expert.persona}</Text>}
                </VStack>
              </Card>
            ))}
          </Grid>
        )}
      </VStack>

      {!solo && (
        <VStack gap={1}>
          <Heading level={compact ? 4 : 3}>群聊编排规则</Heading>
          {solution.orchestration_rules ? (
            <Text color="secondary" style={{ whiteSpace: "pre-wrap" }} data-testid="solution-overview-rules">
              {renderRules(solution.orchestration_rules, names)}
            </Text>
          ) : (
            <Text type="supporting" color="secondary">未配置编排规则，建群后由群主按协作说明自由协调。</Text>
          )}
        </VStack>
      )}

      <VStack gap={1}>
        <Heading level={compact ? 4 : 3}>推荐的 skill 与 MCP</Heading>
        {capabilities.length === 0 ? (
          <Text type="supporting" color="secondary">该方案没有推荐能力。</Text>
        ) : (
          <>
            <Text type="supporting" color="secondary">
              仅供参考，不随方案安装、不影响应用。skill 需企业先从技能市场安装，成员对话中需要时会先征得本人同意；MCP 由成员在本机安装。
            </Text>
            <VStack as="ul" gap={1} aria-label="推荐能力" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {capabilities.map((item) => {
                const status = capabilityStatus(item, skills);
                const name = capabilityName(item);
                return (
                  <HStack as="li" key={`${item.kind}:${item.ref}`} gap={2} align="center" wrap="wrap" data-testid="solution-capability">
                    <Badge label={item.kind === "mcp" ? "MCP" : "skill"} />
                    <Text weight="bold">{name}</Text>
                    <Badge label={status.label} variant={status.variant} />
                    {item.purpose && <Text type="supporting" color="secondary">{item.purpose}</Text>}
                    {status.fixable && (
                      <Button
                        label={status.label === "企业缺失" ? `去技能管理安装 ${name}` : `去技能管理处理 ${name}`}
                        variant="ghost" size="sm" onClick={() => navigate("/skill-market")}
                      >
                        {status.label === "企业缺失" ? "去技能管理安装" : "去技能管理处理"}
                      </Button>
                    )}
                  </HStack>
                );
              })}
            </VStack>
          </>
        )}
      </VStack>
    </VStack>
  );
}
