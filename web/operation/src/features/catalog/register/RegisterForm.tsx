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
import { ExpertProfileFields } from "./ExpertProfileFields";
import { SolutionTemplateFields } from "./SolutionTemplateFields";
import { TeamMemberSelector } from "./TeamMemberSelector";
import { ApiError } from "@aiteam/shared";
import { parseList, validateRegistration, type RegistrationErrors } from "./validation";
import type { CatalogApi } from "../useCatalogApi";
import {
  filledProfileFields,
  profileFromItem,
  profilePayload,
  validateProfile,
  type ExpertTemplateProfile,
  type ProfileErrors,
} from "../profile";
import type { CatalogItem, CatalogItemType, RegisterExpertTemplate, RegisterSolutionTemplate } from "../types";
import type { PlatformSkillRef } from "../../skill-market/types";
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
  const [displayName, setDisplayName] = useState("");
  const [category, setCategory] = useState(DEFAULT_EXPERT_CATEGORIES[0] ?? "");
  const [categories, setCategories] = useState(DEFAULT_EXPERT_CATEGORIES);
  const [newCategory, setNewCategory] = useState("");
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [expertDescription, setExpertDescription] = useState("");
  const [platformSkillRefs, setPlatformSkillRefs] = useState<PlatformSkillRef[]>([]);
  const [profile, setProfile] = useState<ExpertTemplateProfile>(() => profileFromItem({}));
  const [profileErrors, setProfileErrors] = useState<ProfileErrors>({});
  const [expertOptions, setExpertOptions] = useState<CatalogItem[]>([]);
  const [expertTemplateIds, setExpertTemplateIds] = useState<string[]>([]);
  const [coordinatorTemplateId, setCoordinatorTemplateId] = useState("");
  const [solutionDescription, setSolutionDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [coordinatorInstructions, setCoordinatorInstructions] = useState("");
  const [solutionTagsText, setSolutionTagsText] = useState("");
  const [validationErrors, setValidationErrors] = useState<RegistrationErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
    if (coordinatorTemplateId && !ids.includes(coordinatorTemplateId)) setCoordinatorTemplateId("");
  }

  function buildExpertPayload(): RegisterExpertTemplate {
    return {
      display_name: displayName.trim(),
      category: category.trim(),
      avatar_url: avatarUrl.trim(),
      system_prompt: systemPrompt.trim(),
      platform_skill_refs: platformSkillRefs,
      description: expertDescription.trim(),
      ...filledProfileFields(profilePayload(profile)),
    };
  }

  function buildSolutionPayload(): RegisterSolutionTemplate {
    return {
      display_name: displayName.trim(),
      description: solutionDescription.trim(),
      icon: icon.trim(),
      expert_template_ids: expertTemplateIds,
      coordinator_template_id: coordinatorTemplateId.trim(),
      coordinator_instructions: coordinatorInstructions.trim(),
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
      description: expertDescription,
      expertTemplateIds,
      coordinatorTemplateId,
    });
    const nextProfileErrors = catalogType === "expert_template" ? validateProfile(profilePayload(profile)) : {};
    setValidationErrors(errors);
    setProfileErrors(nextProfileErrors);
    if (Object.keys(errors).length > 0 || Object.keys(nextProfileErrors).length > 0) return;

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
                description={expertDescription}
                disabled={disabled}
                systemPromptError={validationErrors.systemPrompt}
                descriptionError={validationErrors.description}
                onAvatarUrlChange={setAvatarUrl}
                onSystemPromptChange={setSystemPrompt}
                onDescriptionChange={setExpertDescription}
              />
              <ExpertSkillSelector value={platformSkillRefs} onChange={setPlatformSkillRefs} disabled={disabled} />
              <ExpertProfileFields value={profile} disabled={disabled} errors={profileErrors} onChange={setProfile} />
            </>
          ) : (
            <>
              <TeamMemberSelector
                options={expertOptions}
                selectedIds={expertTemplateIds}
                coordinatorTemplateId={coordinatorTemplateId}
                disabled={disabled}
                selectionError={validationErrors.expertTemplateIds}
                coordinatorError={validationErrors.coordinatorTemplateId}
                onSelectionChange={updateExpertTemplateIds}
                onCoordinatorChange={setCoordinatorTemplateId}
              />
              <SolutionTemplateFields
                description={solutionDescription}
                icon={icon}
                coordinatorInstructions={coordinatorInstructions}
                tagsText={solutionTagsText}
                disabled={disabled}
                onDescriptionChange={setSolutionDescription}
                onIconChange={setIcon}
                onCoordinatorInstructionsChange={setCoordinatorInstructions}
                onTagsChange={setSolutionTagsText}
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
