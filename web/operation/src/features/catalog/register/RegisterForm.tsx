import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { type FormEvent, useEffect, useState } from "react";
import { BasicInfoFields } from "./BasicInfoFields";
import { ExpertTemplateFields } from "./ExpertTemplateFields";
import { ExpertSkillSelector } from "./ExpertSkillSelector";
import { SolutionTemplateFields } from "./SolutionTemplateFields";
import { TeamMemberSelector } from "./TeamMemberSelector";
import { ApiError } from "@aiteam/shared";
import { parseJsonObject, parseList, validateRegistration, type RegistrationErrors } from "./validation";
import type { CatalogApi } from "../useCatalogApi";
import type { CatalogItem, CatalogItemType, PlatformModelRef, RegisterExpertTemplate, RegisterSolutionTemplate } from "../types";
import type { PlatformSkillRef } from "../../skill-market/types";
import { usePlatformProvidersApi } from "../../providers/usePlatformProvidersApi";

const DEFAULT_EXPERT_CATEGORIES = ["市场营销", "财务分析", "技术研发", "客户服务", "人力资源"];

function formatRegisterError(error: unknown): string {
  if (error instanceof ApiError && error.problem?.errors?.length) {
    return error.problem.errors.map((item) => `${String(item.loc.at(-1) ?? "字段")}: ${item.message}`).join("；");
  }
  return error instanceof Error ? error.message : "注册失败";
}

export interface RegisterFormProps {
  api: CatalogApi;
  catalogType: CatalogItemType;
  onDone: () => void;
  onCancel: () => void;
}

export function RegisterForm({ api, catalogType, onDone, onCancel }: RegisterFormProps) {
  const providerApi = usePlatformProvidersApi();
  const [displayName, setDisplayName] = useState("");
  const [category, setCategory] = useState(DEFAULT_EXPERT_CATEGORIES[0] ?? "");
  const [categories, setCategories] = useState(DEFAULT_EXPERT_CATEGORIES);
  const [newCategory, setNewCategory] = useState("");
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [modelOptions, setModelOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [modelRefs, setModelRefs] = useState<Record<string, PlatformModelRef>>({});
  const [expertDescription, setExpertDescription] = useState("");
  const [platformSkillRefs, setPlatformSkillRefs] = useState<PlatformSkillRef[]>([]);
  const [expertOptions, setExpertOptions] = useState<CatalogItem[]>([]);
  const [expertTemplateIds, setExpertTemplateIds] = useState<string[]>([]);
  const [plannerTemplateId, setPlannerTemplateId] = useState("");
  const [solutionDescription, setSolutionDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [knowledgeRefsText, setKnowledgeRefsText] = useState("");
  const [skillRefsText, setSkillRefsText] = useState("");
  const [plannerPrompt, setPlannerPrompt] = useState("");
  const [subtaskPrompt, setSubtaskPrompt] = useState("");
  const [aggregatePrompt, setAggregatePrompt] = useState("");
  const [defaultGrantsText, setDefaultGrantsText] = useState("");
  const [solutionTagsText, setSolutionTagsText] = useState("");
  const [isSolutionAdvancedOpen, setIsSolutionAdvancedOpen] = useState(false);
  const [validationErrors, setValidationErrors] = useState<RegistrationErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (catalogType !== "expert_template") return;
    void providerApi.list().then(async (providers) => {
      const published = providers.filter((provider) => provider.status === "published");
      const groups = await Promise.all(published.map(async (provider) => ({ provider, models: await providerApi.models(provider.provider_id) })));
      const refs: Record<string, PlatformModelRef> = {};
      const options: Array<{ value: string; label: string }> = [];
      for (const { provider, models } of groups) for (const item of models) {
        if (item.model.status !== "published" || !item.rate) continue;
        const value = `${provider.provider_id}::${item.model.model_id}`;
        refs[value] = { provider_id: provider.provider_id, provider_version: provider.version, model_id: item.model.model_id, model_version: item.model.version };
        options.push({ value, label: `${provider.display_name} / ${item.model.display_name || item.model.model_id} · $${item.rate.input_usd_per_million}/$${item.rate.output_usd_per_million}` });
      }
      setModelRefs(refs); setModelOptions(options);
      if (options.length === 1) setDefaultModel(options[0]!.value);
    }).catch(() => { setModelOptions([]); setModelRefs({}); });
  }, [catalogType, providerApi]);

  useEffect(() => {
    if (catalogType !== "solution_template") return;
    api.list().then((result) => {
      setExpertOptions(result.items.filter((item) => item.catalog_type === "expert_template"));
    }).catch(() => undefined);
  }, [api, catalogType]);

  function addCategory() {
    const value = newCategory.trim();
    if (!value) return;
    setCategories((current) => current.includes(value) ? current : [...current, value]);
    setCategory(value);
    setNewCategory("");
    setIsAddingCategory(false);
  }

  function updateExpertTemplateIds(ids: string[]) {
    setExpertTemplateIds(ids);
    if (plannerTemplateId && !ids.includes(plannerTemplateId)) setPlannerTemplateId("");
  }

  function buildExpertPayload(): RegisterExpertTemplate {
    return {
      display_name: displayName.trim(),
      category: category.trim(),
      avatar_url: avatarUrl.trim(),
      system_prompt: systemPrompt.trim(),
      platform_model_ref: modelRefs[defaultModel]!,
      platform_skill_refs: platformSkillRefs,
      description: expertDescription.trim(),
    };
  }

  function buildSolutionPayload(): RegisterSolutionTemplate {
    return {
      display_name: displayName.trim(),
      description: solutionDescription.trim(),
      icon: icon.trim(),
      expert_template_ids: expertTemplateIds,
      planner_template_id: plannerTemplateId.trim(),
      knowledge_refs: parseList(knowledgeRefsText),
      skill_refs: parseList(skillRefsText),
      planner_prompt: plannerPrompt.trim(),
      subtask_prompt: subtaskPrompt.trim(),
      aggregate_prompt: aggregatePrompt.trim(),
      default_grants: parseJsonObject(defaultGrantsText) ?? null,
      tags: parseList(solutionTagsText),
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    const errors = validateRegistration({
      catalogType,
      displayName,
      category,
      avatarUrl,
      systemPrompt,
      defaultModel,
      description: expertDescription,
      expertTemplateIds,
      plannerTemplateId,
      plannerPrompt,
      defaultGrantsText,
    });
    setValidationErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsSubmitting(true);
    try {
      if (catalogType === "expert_template") {
        await api.registerExpert(buildExpertPayload());
      } else {
        await api.registerSolution(buildSolutionPayload());
      }
      onDone();
    } catch (error) {
      setSubmitError(formatRegisterError(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  const disabled = isSubmitting;

  return (
    <Card>
      <form aria-label="注册新模板/方案" onSubmit={(event) => void handleSubmit(event)}>
        <VStack gap={5}>
          <Heading level={2}>注册新模板/方案</Heading>
          <BasicInfoFields
            displayName={displayName}
            showCategory={catalogType === "expert_template"}
            category={category}
            categories={categories}
            newCategory={newCategory}
            isAddingCategory={isAddingCategory}
            disabled={disabled}
            displayNameError={validationErrors.displayName}
            categoryError={validationErrors.category}
            onDisplayNameChange={setDisplayName}
            onCategoryChange={setCategory}
            onNewCategoryChange={setNewCategory}
            onAddingCategoryChange={setIsAddingCategory}
            onAddCategory={addCategory}
          />
          {catalogType === "expert_template" ? (
            <>
              <ExpertTemplateFields
                avatarUrl={avatarUrl}
                systemPrompt={systemPrompt}
                defaultModel={defaultModel}
                modelOptions={modelOptions}
                description={expertDescription}
                disabled={disabled}
                systemPromptError={validationErrors.systemPrompt}
                defaultModelError={validationErrors.defaultModel}
                descriptionError={validationErrors.description}
                onAvatarUrlChange={setAvatarUrl}
                onSystemPromptChange={setSystemPrompt}
                onDefaultModelChange={setDefaultModel}
                onDescriptionChange={setExpertDescription}
              />
              <ExpertSkillSelector value={platformSkillRefs} onChange={setPlatformSkillRefs} disabled={disabled} />
            </>
          ) : (
            <>
              <TeamMemberSelector
                options={expertOptions}
                selectedIds={expertTemplateIds}
                plannerTemplateId={plannerTemplateId}
                disabled={disabled}
                selectionError={validationErrors.expertTemplateIds}
                plannerError={validationErrors.plannerTemplateId}
                onSelectionChange={updateExpertTemplateIds}
                onPlannerChange={setPlannerTemplateId}
              />
              <SolutionTemplateFields
                description={solutionDescription}
                icon={icon}
                knowledgeRefsText={knowledgeRefsText}
                skillRefsText={skillRefsText}
                plannerPrompt={plannerPrompt}
                subtaskPrompt={subtaskPrompt}
                aggregatePrompt={aggregatePrompt}
                defaultGrantsText={defaultGrantsText}
                tagsText={solutionTagsText}
                isAdvancedOpen={isSolutionAdvancedOpen}
                disabled={disabled}
                plannerPromptError={validationErrors.plannerPrompt}
                defaultGrantsError={validationErrors.defaultGrantsText}
                onDescriptionChange={setSolutionDescription}
                onIconChange={setIcon}
                onKnowledgeRefsChange={setKnowledgeRefsText}
                onSkillRefsChange={setSkillRefsText}
                onPlannerPromptChange={setPlannerPrompt}
                onSubtaskPromptChange={setSubtaskPrompt}
                onAggregatePromptChange={setAggregatePrompt}
                onDefaultGrantsChange={setDefaultGrantsText}
                onTagsChange={setSolutionTagsText}
                onAdvancedOpenChange={setIsSolutionAdvancedOpen}
              />
            </>
          )}
          {submitError && <Banner status="error" title={submitError} />}
          <HStack gap={3}>
            <Button label={isSubmitting ? "提交中…" : "注册"} type="submit" isDisabled={disabled} />
            <Button label="取消" variant="ghost" onClick={onCancel} isDisabled={disabled} />
          </HStack>
        </VStack>
      </form>
    </Card>
  );
}
