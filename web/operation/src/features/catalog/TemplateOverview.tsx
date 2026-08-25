import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { labelToVisibleScope, visibilityLabel } from "./types";
import type { CatalogItem } from "./types";
import { useSkillMarketApi } from "../skill-market/useSkillMarketApi";
import type { InternalSkill } from "../skill-market/types";

function safeJson(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseList(value: string): string[] {
  return value.split(/[\n,，]/).map((entry) => entry.trim()).filter(Boolean);
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

interface TemplateOverviewProps {
  item: CatalogItem;
  draft: CatalogItem;
  editing: boolean;
  canWrite: boolean;
  visibilityChanging: boolean;
  onChange: (next: CatalogItem) => void;
  onVisibilityChange: (next: "public" | "enterprise" | "hidden") => void;
}

function SkillNames({ refs, legacyIds = [] }: { refs: CatalogItem["platform_skill_refs"]; legacyIds?: string[] }): ReactNode {
  const api = useSkillMarketApi();
  const [skills, setSkills] = useState<InternalSkill[]>([]);
  const entries = refs?.length ? refs : legacyIds.map((skill_id) => ({ skill_id, version: "", content_hash: "" }));
  const hasSkills = entries.length > 0;
  useEffect(() => {
    if (!hasSkills) return;
    let active = true;
    void api.listInternal().then((items) => { if (active) setSkills(items); }).catch(() => undefined);
    return () => { active = false; };
  }, [api, hasSkills]);
  if (!entries.length) return <ReadonlyText value={null} />;
  return (
    <HStack gap={2} wrap="wrap">
      {entries.map((ref) => {
        const skill = skills.find((item) => item.skill_id === ref.skill_id);
        const name = skill?.display_name || skill?.slug || "技能名称待同步";
        return <Badge key={`${ref.skill_id}:${ref.version}`} label={ref.version ? `${name} · v${ref.version}` : name} variant="info" />;
      })}
    </HStack>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <Card>
      <VStack gap={3}>
        <Text weight="bold">{title}</Text>
        {children}
      </VStack>
    </Card>
  );
}

function ReadonlyText({ value }: { value?: string | null }): ReactNode {
  return <Text as="p" color={value ? "primary" : "secondary"}>{value || "—"}</Text>;
}

function ReadonlyRow({ label, value }: { label: string; value?: string | null }): ReactNode {
  return (
    <VStack gap={0}>
      <Text type="supporting" color="secondary">{label}</Text>
      <Text>{value || "—"}</Text>
    </VStack>
  );
}

function ReadonlyJson({ title, value }: { title?: string; value?: unknown }): ReactNode {
  const rendered = value == null || (Array.isArray(value) && value.length === 0) ? "—" : safeJson(value);
  return (
    <VStack gap={1}>
      {title && <Text type="supporting" color="secondary">{title}</Text>}
      <CodeBlock code={rendered} language="json" width="100%" maxHeight={200} isWrapped />
    </VStack>
  );
}

function ExpertDetailSections({ draft, onChange, editing }: {
  draft: CatalogItem;
  onChange: (next: CatalogItem) => void;
  editing: boolean;
}): ReactNode {
  return (
    <>
      <DetailSection title="分类 / 头像">
        {editing ? (
          <FormLayout direction="horizontal">
            <TextInput label="category" value={draft.category ?? ""} onChange={(category) => onChange({ ...draft, category })} />
            <TextInput label="avatar_url" value={draft.avatar_url ?? ""} onChange={(avatar_url) => onChange({ ...draft, avatar_url })} />
          </FormLayout>
        ) : (
          <Grid columns={{ minWidth: 220, max: 2 }} gap={4}>
            <ReadonlyRow label="category" value={draft.category} />
            <ReadonlyRow label="avatar_url" value={draft.avatar_url} />
          </Grid>
        )}
      </DetailSection>

      <DetailSection title="系统提示词 (system_prompt)">
        {editing ? <TextArea label="system_prompt" placeholder="岗位描述系统提示词（纯文本）" value={draft.system_prompt ?? ""} onChange={(system_prompt) => onChange({ ...draft, system_prompt })} rows={6} /> : <ReadonlyText value={draft.system_prompt} />}
      </DetailSection>

      <DetailSection title="大模型服务 / 模型">
        <ReadonlyText value={draft.platform_model_ref ? `${draft.platform_model_ref.provider_id} / ${draft.platform_model_ref.model_id} · v${draft.platform_model_ref.model_version}` : "未配置"} />
      </DetailSection>

      <DetailSection title="岗位描述 (description)">
        {editing ? <TextArea label="description" value={draft.description ?? ""} onChange={(description) => onChange({ ...draft, description })} rows={4} /> : <ReadonlyText value={draft.description} />}
      </DetailSection>

      <DetailSection title="技能">
        <SkillNames refs={draft.platform_skill_refs} legacyIds={draft.skill_ids} />
      </DetailSection>
    </>
  );
}

function SolutionDetailSections({ draft, onChange, editing }: {
  draft: CatalogItem;
  onChange: (next: CatalogItem) => void;
  editing: boolean;
}): ReactNode {
  return (
    <>
      <DetailSection title="配置专家 (expert_template_ids)">
        {editing ? <TextArea label="expert_template_ids" value={(draft.expert_template_ids ?? []).join("\n")} placeholder="每行一个 template_id (编辑模式)" onChange={(value) => onChange({ ...draft, expert_template_ids: parseList(value) })} rows={6} /> : <ReadonlyJson value={draft.expert_template_ids} />}
      </DetailSection>

      <DetailSection title="知识 / 技能引用">
        {editing ? (
          <FormLayout>
            <TextArea label="知识引用 (knowledge_refs)" value={(draft.knowledge_refs ?? []).join("\n")} onChange={(value) => onChange({ ...draft, knowledge_refs: parseList(value) })} rows={4} />
            <TextArea label="技能引用 (skill_refs)" value={(draft.skill_refs ?? []).join("\n")} onChange={(value) => onChange({ ...draft, skill_refs: parseList(value) })} rows={4} />
          </FormLayout>
        ) : (
          <Grid columns={{ minWidth: 260, max: 2 }} gap={4}>
            <ReadonlyJson title="knowledge_refs" value={draft.knowledge_refs} />
            <ReadonlyJson title="skill_refs" value={draft.skill_refs} />
          </Grid>
        )}
      </DetailSection>

      <DetailSection title="Planner 角色 (planner_template_id)">
        {editing ? <TextInput label="planner_template_id" value={draft.planner_template_id ?? ""} placeholder="被指定为 Planner 的专家模板 id" onChange={(planner_template_id) => onChange({ ...draft, planner_template_id })} /> : <ReadonlyRow label="planner_template_id" value={draft.planner_template_id} />}
      </DetailSection>

      <DetailSection title="协作编排规则 (prompts)">
        {editing ? (
          <FormLayout>
            <TextArea label="planner_prompt" value={draft.planner_prompt ?? ""} onChange={(planner_prompt) => onChange({ ...draft, planner_prompt })} rows={4} />
            <TextArea label="subtask_prompt" value={draft.subtask_prompt ?? ""} onChange={(subtask_prompt) => onChange({ ...draft, subtask_prompt })} rows={4} />
            <TextArea label="aggregate_prompt" value={draft.aggregate_prompt ?? ""} onChange={(aggregate_prompt) => onChange({ ...draft, aggregate_prompt })} rows={4} />
          </FormLayout>
        ) : (
          <VStack gap={2}>
            <ReadonlyRow label="planner_prompt" value={draft.planner_prompt} />
            <ReadonlyRow label="subtask_prompt" value={draft.subtask_prompt} />
            <ReadonlyRow label="aggregate_prompt" value={draft.aggregate_prompt} />
          </VStack>
        )}
      </DetailSection>

      <DetailSection title="默认 Grants / 方案标签">
        {editing ? (
          <FormLayout>
            <TextArea
              label="默认 Grants (JSON)"
              value={safeJson(draft.default_grants ?? {})}
              onChange={(value) => {
                const default_grants = parseJsonObject(value);
                if (default_grants) onChange({ ...draft, default_grants });
              }}
              rows={6}
            />
            <TextArea label="方案标签 (每行或逗号)" value={(draft.tags ?? []).join("\n")} onChange={(value) => onChange({ ...draft, tags: parseList(value) })} rows={4} />
          </FormLayout>
        ) : (
          <Grid columns={{ minWidth: 260, max: 2 }} gap={4}>
            <ReadonlyJson title="default_grants" value={draft.default_grants} />
            <ReadonlyJson title="tags" value={draft.tags} />
          </Grid>
        )}
      </DetailSection>
    </>
  );
}

export function TemplateOverview({ item, draft, editing, canWrite, visibilityChanging, onChange, onVisibilityChange }: TemplateOverviewProps): ReactNode {
  const isExpert = item.catalog_type === "expert_template";
  const visible = visibilityLabel(item.visible_scope);
  const visibilityText = visible === "public" ? "公开" : visible === "enterprise" ? "企业可见" : "隐藏";

  return (
    <VStack gap={5}>
      <Card>
        <MetadataList columns="single">
          <MetadataListItem label="模板 ID"><Text>{item.template_id}</Text></MetadataListItem>
          <MetadataListItem label="类型"><Text>{isExpert ? "专家模板" : "行业方案"}</Text></MetadataListItem>
          <MetadataListItem label="状态"><Badge label={item.status === "published" ? "已发布" : item.status === "unpublished" ? "已下架" : "草稿"} variant={item.status === "published" ? "success" : item.status === "unpublished" ? "neutral" : "warning"} /></MetadataListItem>
          <MetadataListItem label="可见范围">
            {canWrite && editing ? (
              <Selector
                label="可见范围"
                isLabelHidden
                value={visible}
                onChange={(value) => onVisibilityChange(value as "public" | "enterprise" | "hidden")}
                options={[
                  { value: "public", label: "公开" },
                  { value: "enterprise", label: "企业可见" },
                  { value: "hidden", label: "隐藏" },
                ]}
                isDisabled={visibilityChanging}
                width={180}
              />
            ) : <Text>{visibilityText}</Text>}
          </MetadataListItem>
        </MetadataList>
      </Card>

      {isExpert
        ? <ExpertDetailSections draft={draft} onChange={onChange} editing={editing} />
        : <SolutionDetailSections draft={draft} onChange={onChange} editing={editing} />}
    </VStack>
  );
}

export function visibilityScopeFor(label: "public" | "enterprise" | "hidden"): Record<string, unknown> {
  return labelToVisibleScope(label);
}
