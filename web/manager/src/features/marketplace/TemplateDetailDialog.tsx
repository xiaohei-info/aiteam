/**
 * 人才市场模板详情（议题 7）：概览 / 能力 / 接入要求 / 数据与成本 四个标签页 + 底部发布信息。
 *
 * 区块整体无数据时隐藏；「接入要求」为空时显示「无需额外配置」。不出现「数据未提供」类开发文案。
 * 技能按名称展示，查不到名称（未加载完、已下架或读取失败）时退回技能 ID。
 * 有招募权限时底部带招募按钮，和卡片上的招募走同一流程。
 */
import { useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";
import type { ExpertTemplate } from "../experts/types";
import { OUTPUT_TYPE_LABELS, formatPricing, rateTone, resolutionRateText } from "./profile";

type DetailTab = "overview" | "capabilities" | "requirements" | "data";

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section data-ui="marketplace-detail-section">
      <Text weight="bold">{title}</Text>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, ReactNode]> }): ReactNode {
  return (
    <dl data-ui="marketplace-detail-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function List({ items }: { items: string[] }): ReactNode {
  return <ul data-ui="marketplace-detail-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

function OverviewTab({ template }: { template: ExpertTemplate }): ReactNode {
  const useCases = template.use_cases ?? [];
  const limitations = template.limitations ?? [];
  const prompts = template.example_prompts ?? [];
  const outputs = template.sample_outputs ?? [];
  const description = template.description || template.persona;
  return (
    <>
      {(template.tagline || description) && (
        <Section title="定位">
          {template.tagline && <Text weight="bold">{template.tagline}</Text>}
          {description && <Text color="secondary">{description}</Text>}
        </Section>
      )}
      {useCases.length > 0 && <Section title="适用场景"><List items={useCases} /></Section>}
      {limitations.length > 0 && <Section title="不适用"><List items={limitations} /></Section>}
      {prompts.length > 0 && (
        <Section title="示例问题">
          <div data-ui="marketplace-prompt-pills">
            {prompts.map((prompt) => <span key={prompt} data-ui="marketplace-prompt-pill">{prompt}</span>)}
          </div>
        </Section>
      )}
      {outputs.length > 0 && (
        <Section title="示例产出">
          <ul data-ui="marketplace-detail-list">
            {outputs.map((output) => (
              <li key={`${output.title}:${output.output_type}`}>
                {output.preview_url
                  ? <a href={output.preview_url} target="_blank" rel="noopener noreferrer">{output.title}</a>
                  : output.title}
                <span data-ui="marketplace-detail-muted">（{OUTPUT_TYPE_LABELS[output.output_type]}）</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function CapabilitiesTab({ template, skillNames }: { template: ExpertTemplate; skillNames?: ReadonlyMap<string, string> | null }): ReactNode {
  const skills = template.platform_skill_refs ?? [];
  const outputTypes = template.output_types ?? [];
  return (
    <>
      {skills.length > 0 && (
        <Section title="技能清单">
          <List items={skills.map((skill) => `${skillNames?.get(skill.skill_id) ?? skill.skill_id} · v${skill.version}`)} />
        </Section>
      )}
      {outputTypes.length > 0 && (
        <Section title="产出类型"><List items={outputTypes.map((type) => OUTPUT_TYPE_LABELS[type])} /></Section>
      )}
    </>
  );
}

function RequirementsTab({ template }: { template: ExpertTemplate }): ReactNode {
  const required = template.required_connectors ?? [];
  const optional = template.optional_connectors ?? [];
  const knowledge = template.recommended_knowledge ?? [];
  const permissions = template.required_permissions;
  const permissionItems = [
    permissions?.full_access && "需要允许完全访问",
    permissions?.local_directories && "需要授权本机目录",
  ].filter((item): item is string => Boolean(item));
  const connectorRows: Array<[string, ReactNode]> = [];
  if (required.length) connectorRows.push(["必需", required.join("、")]);
  if (optional.length) connectorRows.push(["可选", optional.join("、")]);
  if (!connectorRows.length && !knowledge.length && !permissionItems.length) {
    return <Text color="secondary">无需额外配置</Text>;
  }
  return (
    <>
      {connectorRows.length > 0 && <Section title="外部系统"><Rows rows={connectorRows} /></Section>}
      {knowledge.length > 0 && <Section title="推荐知识"><List items={knowledge} /></Section>}
      {permissionItems.length > 0 && <Section title="需要的权限"><List items={permissionItems} /></Section>}
    </>
  );
}

function DataTab({ template }: { template: ExpertTemplate }): ReactNode {
  const stats = template.stats;
  const model = template.platform_model_ref;
  const privacyRows: Array<[string, ReactNode]> = [];
  if (model) privacyRows.push(["模型和服务商", `${model.model_id} · ${model.provider_id}`]);
  if (template.memory_policy_summary) privacyRows.push(["记忆策略", template.memory_policy_summary]);
  return (
    <>
      {stats && (
        <Section title="质量">
          <Rows rows={[[
            "解决率",
            <span
              key="rate"
              data-ui="marketplace-rate"
              data-tone={stats.resolution_rate == null ? "muted" : rateTone(stats.resolution_rate)}
            >
              {resolutionRateText(stats)}
            </span>,
          ]]} />
        </Section>
      )}
      {template.pricing && (
        <Section title="成本"><Rows rows={[["计价", formatPricing(template.pricing)]]} /></Section>
      )}
      {privacyRows.length > 0 && <Section title="数据与隐私"><Rows rows={privacyRows} /></Section>}
    </>
  );
}

function PublishInfo({ template, onRecruit }: { template: ExpertTemplate; onRecruit?: () => void }): ReactNode {
  const i18n = useI18n();
  const parts: ReactNode[] = [];
  if (template.publisher) parts.push(<span key="publisher">发布者：{template.publisher}</span>);
  parts.push(<span key="version">版本 v{template.version}</span>);
  if (template.updated_at) parts.push(<span key="updated">更新于 {template.updated_at.slice(0, 10)}</span>);
  if (template.changelog_url) {
    parts.push(<a key="changelog" href={template.changelog_url} target="_blank" rel="noopener noreferrer">更新说明</a>);
  }
  if (onRecruit) {
    parts.push(
      <span key="recruit" data-ui="marketplace-detail-action">
        {template.is_recruited
          ? <Button label={i18n.t("manager.experts.recruited")} size="sm" variant="secondary" isDisabled />
          : <Button label={i18n.t("manager.experts.recruit")} size="sm" variant="primary" clickAction={onRecruit} />}
      </span>,
    );
  }
  return <footer data-ui="marketplace-detail-footer">{parts}</footer>;
}

export function TemplateDetailDialog({ template, skillNames, onRecruit, onClose }: {
  template: ExpertTemplate;
  /** 技能 ID → 名称；null 表示还没加载完。 */
  skillNames?: ReadonlyMap<string, string> | null;
  /** 没有招募权限时不传，底部不显示招募按钮。 */
  onRecruit?: () => void;
  onClose: () => void;
}): ReactNode {
  const [tab, setTab] = useState<DetailTab>("overview");
  return (
    <Dialog
      isOpen
      purpose="info"
      width={640}
      aria-label={`${template.display_name}详情`}
      onOpenChange={(open) => { if (!open) onClose(); }}
    >
      <VStack gap={4}>
        <DialogHeader title={template.display_name} onOpenChange={(open) => { if (!open) onClose(); }} />
        <TabList aria-label="专家详情" value={tab} onChange={(value) => setTab(value as DetailTab)} hasDivider>
          <Tab value="overview" label="概览" />
          <Tab value="capabilities" label="能力" />
          <Tab value="requirements" label="接入要求" />
          <Tab value="data" label="数据与成本" />
        </TabList>
        <div data-ui="marketplace-detail-body">
          {tab === "overview" && <OverviewTab template={template} />}
          {tab === "capabilities" && <CapabilitiesTab template={template} skillNames={skillNames} />}
          {tab === "requirements" && <RequirementsTab template={template} />}
          {tab === "data" && <DataTab template={template} />}
        </div>
        <PublishInfo template={template} onRecruit={onRecruit} />
      </VStack>
    </Dialog>
  );
}
