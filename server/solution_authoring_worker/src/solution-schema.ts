/**
 * 生成结果的 schema，与 Python 侧 `server/shared/solution_authoring/schemas.py` 保持一致。
 *
 * 这里的校验是给模型的「自检」：不合规就把问题列回去让它修订。权威校验在 Python 宿主（Pydantic），
 * 两边不一致时以宿主为准，所以这里宁可略严（例如要求每位专家至少引用一处来源）。
 */
import { Type, type Static } from "typebox";

const strict = { additionalProperties: false } as const;

export const FINDING_KINDS = ["phone", "email", "id_card", "bank_card", "secret", "amount", "company", "person", "other"] as const;
export const RECOGNIZED_KINDS = ["text", "table", "chart"] as const;

export const EvidenceSchema = Type.Object({
  chunk_id: Type.String({ minLength: 1, maxLength: 40, description: "来源片段编号，必须是 read_chunks / search_chunks 返回过的 chunk_id" }),
  quote: Type.Optional(Type.String({ maxLength: 300, description: "支撑该内容的原文短句（可省略）" })),
}, strict);

export const ExpertSchema = Type.Object({
  key: Type.String({ pattern: "^[a-z][a-z0-9_]{1,39}$", description: "方案内唯一标识：小写字母开头，仅小写字母、数字、下划线" }),
  display_name: Type.String({ minLength: 1, maxLength: 40, description: "专家名称" }),
  category: Type.String({ minLength: 1, maxLength: 40, description: "专家分类，如 质量管理 / 财务分析" }),
  description: Type.String({ minLength: 1, maxLength: 200, description: "面向使用者的岗位描述" }),
  system_prompt: Type.String({ minLength: 1, maxLength: 8000, description: "该专家的系统提示词：职责、工作方法、输出要求" }),
  evidence: Type.Array(EvidenceSchema, { minItems: 1, maxItems: 8, description: "该专家依据的来源片段" }),
}, strict);

export const SolutionSchema = Type.Object({
  display_name: Type.String({ minLength: 1, maxLength: 60, description: "方案名称" }),
  description: Type.String({ minLength: 1, maxLength: 1000, description: "方案描述：解决什么行业问题" }),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 20 }), { maxItems: 8 })),
  coordinator_key: Type.String({ minLength: 1, maxLength: 40, description: "协调专家，必须等于 experts 中某一项的 key" }),
  coordinator_instructions: Type.Optional(Type.String({ maxLength: 4000, description: "专家之间如何协作" })),
  output_requirements: Type.Optional(Type.String({ maxLength: 4000, description: "方案最终交付物的要求" })),
  experts: Type.Array(ExpertSchema, { minItems: 1, maxItems: 12 }),
  evidence: Type.Optional(Type.Array(EvidenceSchema, { maxItems: 8, description: "方案整体依据的来源片段" })),
}, strict);

export const FindingSchema = Type.Object({
  kind: Type.Union(FINDING_KINDS.map((kind) => Type.Literal(kind)), { description: "敏感信息类型" }),
  excerpt: Type.String({ minLength: 1, maxLength: 200, description: "原文中的敏感内容片段（原样摘录）" }),
  chunk_id: Type.Optional(Type.String({ maxLength: 40 })),
  field_path: Type.Optional(Type.String({ maxLength: 120 })),
  note: Type.Optional(Type.String({ maxLength: 200, description: "为什么认为它敏感" })),
}, strict);

export const RecognizedBlockSchema = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 20000, description: "转写的文字；图表则写出其结构与含义" }),
  kind: Type.Union(RECOGNIZED_KINDS.map((kind) => Type.Literal(kind))),
  confidence: Type.Number({ minimum: 0, maximum: 1, description: "对这段内容的把握，0–1" }),
}, strict);

export type Evidence = Static<typeof EvidenceSchema>;
export type GeneratedExpert = Static<typeof ExpertSchema>;
export type GeneratedSolution = Static<typeof SolutionSchema>;
export type AgentFinding = Static<typeof FindingSchema>;
export type RecognizedBlock = Static<typeof RecognizedBlockSchema>;

export interface RecognizedImage {
  image_id: string;
  status: "recognized" | "unrecognized";
  blocks: RecognizedBlock[];
  reason: string;
}

/** 结构校验之外的一致性检查。返回问题列表（给模型看的中文说明），为空表示通过。 */
export function solutionProblems(solution: GeneratedSolution, knownChunkIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const keys = solution.experts.map((expert) => expert.key);
  const duplicated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicated.length) problems.push(`experts[].key 重复：${[...new Set(duplicated)].join("、")}`);
  if (!keys.includes(solution.coordinator_key)) problems.push(`coordinator_key「${solution.coordinator_key}」不在 experts[].key 中`);

  const blank = (value: string | undefined) => value !== undefined && value.trim() === "";
  if (blank(solution.display_name)) problems.push("display_name 不能只有空白");
  if (blank(solution.description)) problems.push("description 不能只有空白");
  solution.experts.forEach((expert, index) => {
    for (const field of ["display_name", "category", "description", "system_prompt"] as const) {
      if (blank(expert[field])) problems.push(`experts[${index}].${field} 不能只有空白`);
    }
  });

  const unknown = new Set<string>();
  const collect = (items: Evidence[] | undefined) => {
    for (const item of items ?? []) if (!knownChunkIds.has(item.chunk_id)) unknown.add(item.chunk_id);
  };
  collect(solution.evidence);
  solution.experts.forEach((expert) => collect(expert.evidence));
  if (unknown.size) problems.push(`evidence 引用了不存在的 chunk_id：${[...unknown].slice(0, 10).join("、")}；只能引用工具返回过的编号`);
  return problems;
}

/** 补齐可省略字段，输出与宿主 schema 完全同形的对象。 */
export function normalizeSolution(solution: GeneratedSolution): Required<Omit<GeneratedSolution, "experts" | "evidence">> & {
  experts: Array<Omit<GeneratedExpert, "evidence"> & { evidence: Required<Evidence>[] }>;
  evidence: Required<Evidence>[];
} {
  const evidence = (items: Evidence[] | undefined) => (items ?? []).map((item) => ({ chunk_id: item.chunk_id, quote: item.quote ?? "" }));
  return {
    display_name: solution.display_name.trim(),
    description: solution.description.trim(),
    tags: [...new Set((solution.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    coordinator_key: solution.coordinator_key,
    coordinator_instructions: solution.coordinator_instructions ?? "",
    output_requirements: solution.output_requirements ?? "",
    experts: solution.experts.map((expert) => ({
      key: expert.key,
      display_name: expert.display_name.trim(),
      category: expert.category.trim(),
      description: expert.description.trim(),
      system_prompt: expert.system_prompt.trim(),
      evidence: evidence(expert.evidence),
    })),
    evidence: evidence(solution.evidence),
  };
}

export function normalizeFinding(finding: AgentFinding): Required<AgentFinding> {
  return {
    kind: finding.kind,
    excerpt: finding.excerpt,
    chunk_id: finding.chunk_id ?? "",
    field_path: finding.field_path ?? "",
    note: finding.note ?? "",
  };
}
