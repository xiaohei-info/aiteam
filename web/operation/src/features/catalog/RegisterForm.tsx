import { Button, Field, GlassPanel, Input, Select } from "@aiteam/shared/ui";
import { type FormEvent, useEffect, useState, type ReactNode } from "react";
/**
 * 注册模板/方案表单（F03）。
 *
 * 对齐 PRD-v2 S02/S03 与后端扁平字段:
 *   - 专家: display_name / category / avatar_url / system_prompt /
 *     default_model / skill_ids / tags / description / initial_memories / sort_order
 *   - 行业方案: display_name / description / icon / expert_template_ids /
 *     knowledge_refs / skill_refs / planner/subtask/aggregate_prompt /
 *     default_grants / tags
 *
 * 必填只有 display_name(模板/方案 ID 由服务端自动生成)。
 */
import { useI18n } from "../../i18n/context";
import { useCatalogApi } from "./useCatalogApi";
import type { CatalogApi } from "./useCatalogApi";
import type {
  CatalogItem,
  CatalogItemType,
  RegisterExpertTemplate,
  RegisterSolutionTemplate,
} from "./types";

const inputCls =
  "w-full rounded-md border border-gold/20 bg-surface px-md py-sm text-sm " +
  "text-text-primary outline-none transition placeholder:text-text-muted " +
  "focus:border-gold/50 focus:ring-2 focus:ring-gold";

const textareaCls =
  "min-h-[80px] w-full rounded-md border border-gold/20 bg-surface px-md py-sm " +
  "text-sm text-text-primary outline-none transition placeholder:text-text-muted " +
  "focus:border-gold/50 focus:ring-2 focus:ring-gold";

interface Props {
  api: CatalogApi;
  /** 锁定注册类型：隐藏类型选择器，表单只注册该类型。 */
  catalogType: CatalogItemType;
  onDone: () => void;
  onCancel: () => void;
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJsonOrEmpty(value: string): Record<string, unknown> | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function RegisterForm({ api, catalogType, onDone, onCancel }: Props): ReactNode {
  const i18n = useI18n();
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 专家模板基础 + 能力字段（PRD-v2 S02）
  const [category, setCategory] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [defaultSkillsText, setDefaultSkillsText] = useState("");
  const [description, setDescription] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [initialMemoriesText, setInitialMemoriesText] = useState("");
  const [sortOrder, setSortOrder] = useState("");
  const [showExpertAdvanced, setShowExpertAdvanced] = useState(false);

  // 行业方案配置（PRD-v2 S03 + 编排规则）
  const [expertPicks, setExpertPicks] = useState<string[]>([]);
  const [expertOptions, setExpertOptions] = useState<CatalogItem[]>([]);
  const [expertSearch, setExpertSearch] = useState("");
  const [solutionDescription, setSolutionDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [knowledgeRefsText, setKnowledgeRefsText] = useState("");
  const [skillRefsText, setSkillRefsText] = useState("");
  const [plannerPrompt, setPlannerPrompt] = useState("");
  const [subtaskPrompt, setSubtaskPrompt] = useState("");
  const [aggregatePrompt, setAggregatePrompt] = useState("");
  const [defaultGrantsText, setDefaultGrantsText] = useState("");
  const [solutionTagsText, setSolutionTagsText] = useState("");
  const [showSolutionAdvanced, setShowSolutionAdvanced] = useState(false);

  useEffect(() => {
    if (catalogType === "solution_template" && expertOptions.length === 0) {
      api
        .list()
        .then((res) => {
          setExpertOptions(
            res.items.filter((it) => it.catalog_type === "expert_template"),
          );
        })
        .catch(() => {});
    }
  }, [catalogType, expertOptions.length, api]);

  function toggleExpertPick(templateId: string) {
    setExpertPicks((prev) =>
      prev.includes(templateId)
        ? prev.filter((x) => x !== templateId)
        : [...prev, templateId],
    );
  }

  function buildExpertPayload(): RegisterExpertTemplate {
    const skills = parseList(defaultSkillsText);
    const tags = parseList(tagsText);
    const parsedSort = sortOrder.trim() ? Number(sortOrder.trim()) : undefined;
    const parsedMemories = parseJsonArray(initialMemoriesText);
    return {
      display_name: displayName.trim(),
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(avatarUrl.trim() ? { avatar_url: avatarUrl.trim() } : {}),
      ...(systemPrompt.trim() ? { system_prompt: systemPrompt.trim() } : {}),
      ...(defaultModel.trim() ? { default_model: defaultModel.trim() } : {}),
      ...(skills.length ? { skill_ids: skills } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(tags.length ? { tags } : {}),
      ...(parsedSort !== undefined && Number.isFinite(parsedSort)
        ? { sort_order: parsedSort }
        : {}),
      ...(parsedMemories && parsedMemories.length
        ? { initial_memories: parsedMemories }
        : {}),
    };
  }

  function parseJsonArray(value: string): Record<string, unknown>[] | undefined {
    const text = value.trim();
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
      return undefined;
    } catch {
      return undefined;
    }
  }

  function buildSolutionPayload(): RegisterSolutionTemplate {
    const payload: RegisterSolutionTemplate = {
      display_name: displayName.trim(),
    };
    if (solutionDescription.trim()) payload.description = solutionDescription.trim();
    if (icon.trim()) payload.icon = icon.trim();
    if (expertPicks.length) payload.expert_template_ids = expertPicks;
    const kRefs = parseList(knowledgeRefsText);
    if (kRefs.length) payload.knowledge_refs = kRefs;
    const sRefs = parseList(skillRefsText);
    if (sRefs.length) payload.skill_refs = sRefs;
    if (plannerPrompt.trim()) payload.planner_prompt = plannerPrompt.trim();
    if (subtaskPrompt.trim()) payload.subtask_prompt = subtaskPrompt.trim();
    if (aggregatePrompt.trim()) payload.aggregate_prompt = aggregatePrompt.trim();
    if (defaultGrantsText.trim()) {
      const parsed = parseJsonOrEmpty(defaultGrantsText);
      if (parsed) payload.default_grants = parsed;
    }
    const tags = parseList(solutionTagsText);
    if (tags.length) payload.tags = tags;
    return payload;
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setValidationError(null);
    if (!displayName.trim()) {
      setValidationError("名称不能为空");
      return;
    }
    setLoading(true);
    try {
      if (catalogType === "expert_template") {
        await api.registerExpert(buildExpertPayload());
      } else {
        await api.registerSolution(buildSolutionPayload());
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败");
    } finally {
      setLoading(false);
    }
  }

  const displayError = validationError ?? error;
  const filteredExpertOptions = expertOptions.filter((it) => {
    const k = expertSearch.trim().toLowerCase();
    if (!k) return true;
    return (
      it.template_id.toLowerCase().includes(k) ||
      it.display_name.toLowerCase().includes(k)
    );
  });

  return (
    <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
      <h2 className="m-0 text-base font-semibold text-text-primary">注册新模板/方案</h2>
      <form className="flex flex-col gap-md" onSubmit={handleSubmit}>
        <Field label="类型">
          <span className="text-sm text-text-secondary">
            {catalogType === "expert_template"
              ? i18n.t("operation.catalog.expertTemplate")
              : i18n.t("operation.catalog.solutionTemplate")}
          </span>
        </Field>

        <Field label="名称">
          <Input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="display_name"
            disabled={loading}
          />
        </Field>

        {catalogType === "expert_template" ? (
          <ExpertFields
            category={category}
            onCategoryChange={setCategory}
            avatarUrl={avatarUrl}
            onAvatarUrlChange={setAvatarUrl}
            systemPrompt={systemPrompt}
            onSystemPromptChange={setSystemPrompt}
            defaultModel={defaultModel}
            onDefaultModelChange={setDefaultModel}
            defaultSkillsText={defaultSkillsText}
            onDefaultSkillsChange={setDefaultSkillsText}
            description={description}
            onDescriptionChange={setDescription}
            tagsText={tagsText}
            onTagsChange={setTagsText}
            initialMemoriesText={initialMemoriesText}
            onInitialMemoriesChange={setInitialMemoriesText}
            sortOrder={sortOrder}
            onSortOrderChange={setSortOrder}
            showAdvanced={showExpertAdvanced}
            onToggleAdvanced={() => setShowExpertAdvanced((v) => !v)}
            disabled={loading}
          />
        ) : (
          <SolutionFields
            picks={expertPicks}
            onTogglePick={toggleExpertPick}
            options={filteredExpertOptions}
            search={expertSearch}
            onSearchChange={setExpertSearch}
            solutionDescription={solutionDescription}
            onSolutionDescriptionChange={setSolutionDescription}
            icon={icon}
            onIconChange={setIcon}
            knowledgeRefsText={knowledgeRefsText}
            onKnowledgeRefsChange={setKnowledgeRefsText}
            skillRefsText={skillRefsText}
            onSkillRefsChange={setSkillRefsText}
            planner={plannerPrompt}
            onPlannerChange={setPlannerPrompt}
            subtask={subtaskPrompt}
            onSubtaskChange={setSubtaskPrompt}
            aggregate={aggregatePrompt}
            onAggregateChange={setAggregatePrompt}
            grantsText={defaultGrantsText}
            onGrantsChange={setDefaultGrantsText}
            solutionTagsText={solutionTagsText}
            onSolutionTagsChange={setSolutionTagsText}
            showAdvanced={showSolutionAdvanced}
            onToggleAdvanced={() => setShowSolutionAdvanced((v) => !v)}
            disabled={loading}
          />
        )}

        {displayError && <p className="m-0 text-sm text-danger">{displayError}</p>}
        <div className="flex gap-sm">
          <Button type="submit" disabled={loading} className="self-start">
            {loading ? "提交中…" : "注册"}
          </Button>
          <Button type="button" variant="ghost" disabled={loading} onClick={onCancel}>
            取消
          </Button>
        </div>
      </form>
    </GlassPanel>
  );
}

interface ExpertFormProps {
  category: string;
  onCategoryChange: (v: string) => void;
  avatarUrl: string;
  onAvatarUrlChange: (v: string) => void;
  systemPrompt: string;
  onSystemPromptChange: (v: string) => void;
  defaultModel: string;
  onDefaultModelChange: (v: string) => void;
  defaultSkillsText: string;
  onDefaultSkillsChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  tagsText: string;
  onTagsChange: (v: string) => void;
  initialMemoriesText: string;
  onInitialMemoriesChange: (v: string) => void;
  sortOrder: string;
  onSortOrderChange: (v: string) => void;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  disabled: boolean;
}

function ExpertFields(p: ExpertFormProps): ReactNode {
  return (
    <>
      <Field label="分类 (category)">
        <Input
          type="text"
          className={inputCls}
          value={p.category}
          onChange={(e) => p.onCategoryChange(e.target.value)}
          placeholder="如 marketing / finance / tech"
          disabled={p.disabled}
        />
      </Field>

      <Field label="头像 (avatar_url)">
        <Input
          type="text"
          className={inputCls}
          value={p.avatarUrl}
          onChange={(e) => p.onAvatarUrlChange(e.target.value)}
          placeholder="https://..."
          disabled={p.disabled}
        />
      </Field>

      <Field label="系统提示词 (system_prompt)">
        <textarea
          className={textareaCls}
          value={p.systemPrompt}
          onChange={(e) => p.onSystemPromptChange(e.target.value)}
          placeholder="岗位描述系统提示词（纯文本）"
          disabled={p.disabled}
        />
      </Field>

      <Field label="默认模型 (default_model)">
        <Input
          type="text"
          className={inputCls}
          value={p.defaultModel}
          onChange={(e) => p.onDefaultModelChange(e.target.value)}
          placeholder="如 gpt-5 / claude-opus-4-8 / deepseek"
          disabled={p.disabled}
        />
      </Field>

      <Field label="岗位描述 (description, ≤200字)">
        <textarea
          className={textareaCls}
          value={p.description}
          onChange={(e) => p.onDescriptionChange(e.target.value)}
          placeholder="用户可见的岗位描述（不超过 200 字）"
          disabled={p.disabled}
        />
      </Field>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={p.onToggleAdvanced}
      >
        {p.showAdvanced ? "收起能力配置 ▲" : "展开能力配置(技能 / 标签 / 记忆 / 排序) ▼"}
      </Button>

      {p.showAdvanced && (
        <div className="flex flex-col gap-md rounded-md border border-gold/10 p-md">
          <Field label="预配置技能 (skill_ids, 每行或逗号分隔)">
            <textarea
              className={textareaCls}
              value={p.defaultSkillsText}
              onChange={(e) => p.onDefaultSkillsChange(e.target.value)}
              placeholder={"skill_a\nskill_b"}
              disabled={p.disabled}
            />
          </Field>
          <Field label="搜索标签 (tags, 每行或逗号分隔)">
            <textarea
              className={textareaCls}
              value={p.tagsText}
              onChange={(e) => p.onTagsChange(e.target.value)}
              placeholder={"营销\n电商"}
              disabled={p.disabled}
            />
          </Field>
          <Field label="预置记忆 (initial_memories, JSON 数组)">
            <textarea
              className={textareaCls}
              value={p.initialMemoriesText}
              onChange={(e) => p.onInitialMemoriesChange(e.target.value)}
              placeholder={'[{"role":"user","content":"偏好 Slack"}]'}
              disabled={p.disabled}
            />
          </Field>
          <Field label="排序权重 (sort_order, 数值越小越靠前)">
            <Input
              type="number"
              className={inputCls}
              value={p.sortOrder}
              onChange={(e) => p.onSortOrderChange(e.target.value)}
              placeholder="0"
              disabled={p.disabled}
            />
          </Field>
        </div>
      )}
    </>
  );
}

interface SolutionFormProps {
  picks: string[];
  onTogglePick: (id: string) => void;
  options: CatalogItem[];
  search: string;
  onSearchChange: (v: string) => void;
  solutionDescription: string;
  onSolutionDescriptionChange: (v: string) => void;
  icon: string;
  onIconChange: (v: string) => void;
  knowledgeRefsText: string;
  onKnowledgeRefsChange: (v: string) => void;
  skillRefsText: string;
  onSkillRefsChange: (v: string) => void;
  planner: string;
  onPlannerChange: (v: string) => void;
  subtask: string;
  onSubtaskChange: (v: string) => void;
  aggregate: string;
  onAggregateChange: (v: string) => void;
  grantsText: string;
  onGrantsChange: (v: string) => void;
  solutionTagsText: string;
  onSolutionTagsChange: (v: string) => void;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  disabled: boolean;
}

function SolutionFields(p: SolutionFormProps): ReactNode {
  return (
    <>
      <Field label="描述 (description)">
        <textarea
          className={textareaCls}
          value={p.solutionDescription}
          onChange={(e) => p.onSolutionDescriptionChange(e.target.value)}
          placeholder="方案描述"
          disabled={p.disabled}
        />
      </Field>

      <Field label="图标 (icon)">
        <Input
          type="text"
          className={inputCls}
          value={p.icon}
          onChange={(e) => p.onIconChange(e.target.value)}
          placeholder="图标 URL 或标识"
          disabled={p.disabled}
        />
      </Field>

      <Field label={`配置专家 (${p.picks.length} 已选)`}>
        <div className="flex flex-col gap-sm rounded-md border border-gold/10 p-md">
          <Input
            type="text"
            className={inputCls}
            value={p.search}
            onChange={(e) => p.onSearchChange(e.target.value)}
            placeholder="搜索专家模板 id / 名称"
            disabled={p.disabled}
          />
          {p.options.length === 0 ? (
            <p className="m-0 text-xs text-text-muted">
              暂无可选项(请先在「专家模板」中创建并发布)。
            </p>
          ) : (
            <div className="flex max-h-[200px] flex-col gap-xs overflow-auto">
              {p.options.map((opt) => {
                const checked = p.picks.includes(opt.template_id);
                return (
                  <label
                    key={opt.template_id}
                    className="flex items-center gap-sm rounded px-sm py-xs hover:bg-gold/5"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => p.onTogglePick(opt.template_id)}
                      disabled={p.disabled}
                    />
                    <span className="text-sm text-text-primary">{opt.display_name}</span>
                    <span className="text-xs text-text-muted">#{opt.template_id}</span>
                    <span
                      className={
                        opt.status === "published"
                          ? "text-xs text-success"
                          : "text-xs text-warning"
                      }
                    >
                      {opt.status}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </Field>

      <Field label="知识引用 (knowledge_refs, 每行或逗号分隔)">
        <textarea
          className={textareaCls}
          value={p.knowledgeRefsText}
          onChange={(e) => p.onKnowledgeRefsChange(e.target.value)}
          placeholder={"kb_orders\nkb_finance"}
          disabled={p.disabled}
        />
      </Field>
      <Field label="技能引用 (skill_refs, 每行或逗号分隔)">
        <textarea
          className={textareaCls}
          value={p.skillRefsText}
          onChange={(e) => p.onSkillRefsChange(e.target.value)}
          placeholder={"skill_a\nskill_b"}
          disabled={p.disabled}
        />
      </Field>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={p.onToggleAdvanced}
      >
        {p.showAdvanced ? "收起协作编排配置 ▲" : "展开协作编排配置(Prompt / Grants / Tags) ▼"}
      </Button>

      {p.showAdvanced && (
        <div className="flex flex-col gap-md rounded-md border border-gold/10 p-md">
          <Field label="Planner Prompt">
            <textarea
              className={textareaCls}
              value={p.planner}
              onChange={(e) => p.onPlannerChange(e.target.value)}
              placeholder="方案级协作编排规则:planner 阶段 prompt"
              disabled={p.disabled}
            />
          </Field>
          <Field label="Subtask Prompt">
            <textarea
              className={textareaCls}
              value={p.subtask}
              onChange={(e) => p.onSubtaskChange(e.target.value)}
              placeholder="协作编排规则:子任务拆解 prompt"
              disabled={p.disabled}
            />
          </Field>
          <Field label="Aggregate Prompt">
            <textarea
              className={textareaCls}
              value={p.aggregate}
              onChange={(e) => p.onAggregateChange(e.target.value)}
              placeholder="协作编排规则:多专家结果聚合 prompt"
              disabled={p.disabled}
            />
          </Field>
          <Field label="默认 Grants (JSON)">
            <textarea
              className={textareaCls}
              value={p.grantsText}
              onChange={(e) => p.onGrantsChange(e.target.value)}
              placeholder={'{"max_concurrent_tasks": 5}'}
              disabled={p.disabled}
            />
          </Field>
          <Field label="方案标签 (每行或逗号分隔)">
            <textarea
              className={textareaCls}
              value={p.solutionTagsText}
              onChange={(e) => p.onSolutionTagsChange(e.target.value)}
              placeholder={"零售\n电商"}
              disabled={p.disabled}
            />
          </Field>
        </div>
      )}
    </>
  );
}
