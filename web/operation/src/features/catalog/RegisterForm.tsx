import { Button, Field, GlassPanel, Input, Select } from "@aiteam/shared/ui";
import { type FormEvent, useEffect, useState, type ReactNode } from "react";
/**
 * 注册模板/方案表单（F03）。
 *
 * 对齐后端完整 payload:
 *   - 专家模板: persona / recommended_config (prompt_pack /
 *     default_model_ref / default_binding / default_skill_bundle /
 *     default_skills / knowledge_bindings / connector_requirements /
 *     memory_config / role_name / category_code)
 *   - 行业方案: expert_template_ids / knowledge_refs / skill_refs /
 *     default_grants / planner_prompt / subtask_prompt / aggregate_prompt /
 *     default_kb_blueprint / default_skill_bundle /
 *     default_collaboration_template_ref / tags
 *
 * 表单按"基础 + 能力配置"分层展开;必填只有 display_name(模板 ID 由服务端自动生成)。
 */
import { useI18n } from "../../i18n/context";
import { useCatalogApi } from "./useCatalogApi";
import type { CatalogApi } from "./useCatalogApi";
import type {
  CatalogItem,
  CatalogItemType,
  ExpertRecommendedConfig,
  ModelRef,
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
  // catalogType 锁定后不再可切换，直接用作当前类型。
  // ID 由服务端自动生成（slug + 随机后缀），运营端无需手填 #AITEAM-355 问题二。
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 专家能力配置
  const [persona, setPersona] = useState("");
  const [roleName, setRoleName] = useState("");
  const [categoryCode, setCategoryCode] = useState("");
  const [promptPack, setPromptPack] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [defaultSkillsText, setDefaultSkillsText] = useState("");
  const [knowledgeBindingsText, setKnowledgeBindingsText] = useState("");
  const [memoryConfig, setMemoryConfig] = useState("");
  const [showExpertAdvanced, setShowExpertAdvanced] = useState(false);

  // 行业方案配置
  const [expertPicks, setExpertPicks] = useState<string[]>([]);
  const [expertOptions, setExpertOptions] = useState<CatalogItem[]>([]);
  const [expertSearch, setExpertSearch] = useState("");
  const [knowledgeRefsText, setKnowledgeRefsText] = useState("");
  const [skillRefsText, setSkillRefsText] = useState("");
  const [plannerPrompt, setPlannerPrompt] = useState("");
  const [subtaskPrompt, setSubtaskPrompt] = useState("");
  const [aggregatePrompt, setAggregatePrompt] = useState("");
  const [defaultGrantsText, setDefaultGrantsText] = useState("");
  const [solutionTagsText, setSolutionTagsText] = useState("");
  const [showSolutionAdvanced, setShowSolutionAdvanced] = useState(false);

  // 当表单锁定为行业方案（无类型选择器）时，自动拉取可选专家模板。
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
    const recommended: ExpertRecommendedConfig = {};
    if (promptPack.trim()) {
      const parsed = parseJsonOrEmpty(promptPack);
      if (parsed) recommended.prompt_pack = parsed;
    }
    if (roleName.trim()) recommended.role_name = roleName.trim();
    if (categoryCode.trim()) recommended.category_code = categoryCode.trim();
    const skills = parseList(defaultSkillsText);
    if (skills.length) recommended.default_skills = skills;
    const kb = parseList(knowledgeBindingsText);
    if (kb.length) recommended.knowledge_bindings = kb;
    const memory = parseJsonOrEmpty(memoryConfig);
    if (memory) recommended.memory_config = memory;
    if (modelProvider.trim() || modelId.trim()) {
      const ref: ModelRef = {};
      if (modelProvider.trim()) ref.provider_key = modelProvider.trim();
      if (modelId.trim()) ref.model_id = modelId.trim();
      recommended.default_model_ref = ref;
    }
    return {
      display_name: displayName.trim(),
      ...(persona.trim() ? { persona: persona.trim() } : {}),
      ...(Object.keys(recommended).length
        ? { recommended_config: recommended }
        : {}),
    };
  }

  function buildSolutionPayload(): RegisterSolutionTemplate {
    const payload: RegisterSolutionTemplate = {
      display_name: displayName.trim(),
    };
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
    // 名称必填；ID 由服务端自动生成（AITEAM-355 问题二）。
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
            persona={persona}
            onPersonaChange={setPersona}
            roleName={roleName}
            onRoleNameChange={setRoleName}
            categoryCode={categoryCode}
            onCategoryCodeChange={setCategoryCode}
            promptPack={promptPack}
            onPromptPackChange={setPromptPack}
            modelProvider={modelProvider}
            onModelProviderChange={setModelProvider}
            modelId={modelId}
            onModelIdChange={setModelId}
            defaultSkillsText={defaultSkillsText}
            onDefaultSkillsChange={setDefaultSkillsText}
            knowledgeBindingsText={knowledgeBindingsText}
            onKnowledgeBindingsChange={setKnowledgeBindingsText}
            memoryConfig={memoryConfig}
            onMemoryConfigChange={setMemoryConfig}
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
  persona: string;
  onPersonaChange: (v: string) => void;
  roleName: string;
  onRoleNameChange: (v: string) => void;
  categoryCode: string;
  onCategoryCodeChange: (v: string) => void;
  promptPack: string;
  onPromptPackChange: (v: string) => void;
  modelProvider: string;
  onModelProviderChange: (v: string) => void;
  modelId: string;
  onModelIdChange: (v: string) => void;
  defaultSkillsText: string;
  onDefaultSkillsChange: (v: string) => void;
  knowledgeBindingsText: string;
  onKnowledgeBindingsChange: (v: string) => void;
  memoryConfig: string;
  onMemoryConfigChange: (v: string) => void;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  disabled: boolean;
}

function ExpertFields(p: ExpertFormProps): ReactNode {
  return (
    <>
      <Field label="人设 (persona)">
        <textarea
          className={textareaCls}
          value={p.persona}
          onChange={(e) => p.onPersonaChange(e.target.value)}
          placeholder="专家人设描述(可选)"
          disabled={p.disabled}
        />
      </Field>

      <div className="grid grid-cols-2 gap-sm">
        <Field label="岗位 (role_name)">
          <Input
            type="text"
            className={inputCls}
            value={p.roleName}
            onChange={(e) => p.onRoleNameChange(e.target.value)}
            placeholder="如 customer_success"
            disabled={p.disabled}
          />
        </Field>
        <Field label="岗位类别 (category_code)">
          <Input
            type="text"
            className={inputCls}
            value={p.categoryCode}
            onChange={(e) => p.onCategoryCodeChange(e.target.value)}
            placeholder="如 support / marketing / tech"
            disabled={p.disabled}
          />
        </Field>
      </div>

      <Field label="推荐模型">
        <div className="grid grid-cols-2 gap-sm">
          <Input
            type="text"
            className={inputCls}
            value={p.modelProvider}
            onChange={(e) => p.onModelProviderChange(e.target.value)}
            placeholder="provider_key (可选)"
            disabled={p.disabled}
          />
          <Input
            type="text"
            className={inputCls}
            value={p.modelId}
            onChange={(e) => p.onModelIdChange(e.target.value)}
            placeholder="model_id"
            disabled={p.disabled}
          />
        </div>
      </Field>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={p.onToggleAdvanced}
      >
        {p.showAdvanced ? "收起能力配置 ▲" : "展开能力配置(技能 / 知识 / 记忆 / Prompt / 标签) ▼"}
      </Button>

      {p.showAdvanced && (
        <div className="flex flex-col gap-md rounded-md border border-gold/10 p-md">
          <Field label="默认技能 (每行或逗号分隔)">
            <textarea
              className={textareaCls}
              value={p.defaultSkillsText}
              onChange={(e) => p.onDefaultSkillsChange(e.target.value)}
              placeholder={"skill_a\nskill_b\nskill_c"}
              disabled={p.disabled}
            />
          </Field>
          <Field label="知识库绑定 (每行或逗号分隔)">
            <textarea
              className={textareaCls}
              value={p.knowledgeBindingsText}
              onChange={(e) => p.onKnowledgeBindingsChange(e.target.value)}
              placeholder={"kb_orders\nkb_finance"}
              disabled={p.disabled}
            />
          </Field>
          <Field label="初始记忆 (memory_config, JSON)">
            <textarea
              className={textareaCls}
              value={p.memoryConfig}
              onChange={(e) => p.onMemoryConfigChange(e.target.value)}
              placeholder={'{"type": "buffer", "max_tokens": 4096}'}
              disabled={p.disabled}
            />
          </Field>
          <Field label="Prompt Pack (JSON: {system, task, ...})">
            <textarea
              className={textareaCls}
              value={p.promptPack}
              onChange={(e) => p.onPromptPackChange(e.target.value)}
              placeholder={'{"system": "...", "task": "..."}'}
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
