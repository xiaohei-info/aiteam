/**
 * 草稿工作台的纯逻辑：流程步骤、页头唯一主操作、编排规则里的成员引用校验、后端英文错误的中文化。
 * 不依赖 React，便于单测；文案集中在这里与 labels.ts，页面组件只负责渲染。
 */
import type { ConfirmItem, DraftDetail, Gate, GeneratedSolution, SolutionMode } from "./types";

// ---- 流程步骤 ----

export type StepKey = "sources" | "generate" | "confirm" | "review" | "publish";
export type StepState = "done" | "current" | "todo";

export interface Step {
  key: StepKey;
  label: string;
  state: StepState;
  /** 阻塞原因，用文字写在步骤下（不依赖 tooltip 或颜色）。 */
  blocker?: string;
}

const STEP_LABELS: Record<StepKey, string> = {
  sources: "资料",
  generate: "生成",
  confirm: "确认",
  review: "审核",
  publish: "发布",
};
const ORDER: StepKey[] = ["sources", "generate", "confirm", "review", "publish"];

/** 当前所处步骤。archived 没有流程；rejected 退回「确认」（要改了再提交）。 */
function currentStep(detail: Pick<DraftDetail, "status" | "sources">): StepKey | null {
  switch (detail.status) {
    case "draft": return detail.sources.length === 0 ? "sources" : "generate";
    case "generating": return "generate";
    case "ready_for_review":
    case "rejected": return "confirm";
    case "in_review": return "review";
    case "approved": return "publish";
    case "published":
    case "archived": return null;
    default: return null;
  }
}

/**
 * 群主 + 编排规则在界面上是「一次确认」：后端仍按两项分别记录（任何一项内容被改都会各自失效），
 * 这里把它们合成一个状态，让使用者只面对「确认群主与编排规则」一个动作。
 */
export interface OrchestrationState {
  /** 单人方案没有这一项。 */
  applicable: boolean;
  ok: boolean;
  /** 还没生效的确认项；点「确认」时依次提交。 */
  pending: ConfirmItem[];
  /** 之前确认过，但内容后来被改动。 */
  stale: boolean;
  /** 规则为空等原因导致现在还不能确认。 */
  blocked: boolean;
  /** 面向人的原因（ok 时为空）。 */
  reason: string;
}

export function orchestrationState(gates: Gate[] | undefined): OrchestrationState {
  const own = (gates ?? []).filter((gate) => gate.key === "coordinator" || gate.key === "rules");
  const pending = own.filter((gate) => !gate.ok).map((gate) => gate.key as ConfirmItem);
  const blocked = own.some((gate) => !gate.ok && gate.message.includes("required for a group"));
  const stale = own.some((gate) => !gate.ok && gate.message.includes("changed after"));
  const reason = pending.length === 0 ? ""
    : blocked ? "还没有编排规则，请先点「编辑规则」补充，或重新生成"
      : stale ? "确认后内容有改动，需要重新确认" : "还没有确认";
  return { applicable: own.length > 0, ok: pending.length === 0, pending, stale, blocked, reason };
}

export interface ChecklistRow {
  key: "findings" | "orchestration";
  label: string;
  ok: boolean;
  /** 未满足时的原因（文字，不靠颜色）。 */
  reason: string;
  /** 页面内对应分节的锚点，用于「去处理」。 */
  anchor: string;
}

/** 提交审核前的发布清单（右侧栏只读展示）：每一行都能对应到主区一个分节。 */
export function checklist(detail: Pick<DraftDetail, "open_finding_count" | "gates">): ChecklistRow[] {
  const rows: ChecklistRow[] = [{
    key: "findings", label: "敏感项已全部处理", ok: detail.open_finding_count === 0,
    reason: `还有 ${detail.open_finding_count} 项待处理`, anchor: "section-findings",
  }];
  const team = orchestrationState(detail.gates);
  if (team.applicable) rows.push({ key: "orchestration", label: "群主与编排规则已确认", ok: team.ok, reason: team.reason, anchor: "section-team" });
  return rows;
}

/** 还差哪些事才能提交审核（面向人的中文短句）。 */
export function submitBlockers(detail: Pick<DraftDetail, "open_finding_count" | "gates">): string[] {
  return checklist(detail).filter((row) => !row.ok).map((row) =>
    row.key === "findings" ? `还差 ${detail.open_finding_count} 项敏感项未处理` : "群主与编排规则未确认");
}

export function workflowSteps(detail: DraftDetail): Step[] {
  const current = currentStep(detail);
  const published = detail.status === "published";
  const index = current ? ORDER.indexOf(current) : published ? ORDER.length : -1;
  return ORDER.map((key, position) => {
    const state: StepState = position < index ? "done" : position === index ? "current" : "todo";
    const step: Step = { key, label: STEP_LABELS[key], state };
    if (state === "current" && key === "confirm") {
      const blockers = submitBlockers(detail);
      if (detail.status === "rejected") step.blocker = "已驳回：按理由修改后重新提交";
      else if (blockers.length > 0) step.blocker = blockers.join("；");
    }
    if (state === "current" && key === "sources") step.blocker = "上传至少一份行业资料";
    if (state === "current" && key === "generate" && detail.status === "generating") step.blocker = "AI 正在生成，页面会自动刷新";
    if (state === "current" && key === "publish" && detail.publish_started) step.blocker = "上一次发布未完成，请重新发布";
    return step;
  });
}

// ---- 页头唯一主操作 ----

export type PrimaryKind = "upload" | "generate" | "submit" | "approve" | "publish" | "wait";

export interface PrimaryAction {
  kind: PrimaryKind;
  label: string;
  /** 不可用时的原因，直接以文字显示在按钮旁。 */
  disabledReason?: string;
}

/** 一个状态一个主操作；没有可做的事（等别人 / 已完成）返回 null。 */
export function primaryAction(
  detail: DraftDetail, isAdmin: boolean, editing: boolean,
): PrimaryAction | null {
  switch (detail.status) {
    case "draft":
      return detail.sources.length === 0
        ? { kind: "upload", label: "上传资料" }
        : { kind: "generate", label: "开始生成" };
    case "ready_for_review":
    case "rejected": {
      if (detail.package === null) return null;
      const blockers = submitBlockers(detail);
      const reason = editing ? "有未保存的修改，请先保存或取消" : blockers.length > 0 ? blockers.join("；") : undefined;
      return { kind: "submit", label: "提交审核", disabledReason: reason };
    }
    case "in_review":
      return isAdmin ? { kind: "approve", label: "审核通过" } : null;
    case "approved":
      return isAdmin ? { kind: "publish", label: detail.publish_started ? "重新发布" : "发布到目录" } : null;
    default:
      return null;
  }
}

// ---- 编排规则里的成员引用 ----

const REF = /@\{([^{}\s]+)\}/g;

export function referencedMembers(rules: string): string[] {
  return [...new Set([...rules.matchAll(REF)].map((match) => match[1]!))];
}

/** 返回问题描述；合法返回 null。口径与后端 `validate_member_refs` 一致。 */
export function validateRules(rules: string, memberKeys: string[], mode: SolutionMode): string | null {
  const text = rules.trim();
  if (mode === "solo") return text ? "单人方案不需要群聊编排规则" : null;
  if (!text) return "组群方案必须写出群聊编排规则";
  if (rules.replace(REF, "").includes("@{")) return "有成员引用格式不对，应写成 @{成员标识}";
  const unknown = referencedMembers(rules).find((key) => !memberKeys.includes(key));
  return unknown ? `规则里引用了方案外的成员「${unknown}」` : null;
}

export type RulePart = { kind: "text"; text: string } | { kind: "member"; key: string; name: string; known: boolean };

/** 把规则拆成文本与成员引用，用于预览（成员显示名字，未知引用标红）。 */
export function ruleParts(rules: string, solution: Pick<GeneratedSolution, "experts">): RulePart[] {
  const parts: RulePart[] = [];
  let last = 0;
  for (const match of rules.matchAll(REF)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: "text", text: rules.slice(last, index) });
    const key = match[1]!;
    const expert = solution.experts.find((item) => item.key === key);
    parts.push({ kind: "member", key, name: expert?.display_name || key, known: expert !== undefined });
    last = index + match[0].length;
  }
  if (last < rules.length) parts.push({ kind: "text", text: rules.slice(last) });
  return parts;
}

/** 删除专家前：规则里还引用着它则不允许（返回原因）。 */
export function removalBlocker(rules: string | undefined, key: string): string | null {
  return referencedMembers(rules ?? "").includes(key) ? "群聊编排规则里还引用着这位专家，请先修改规则" : null;
}

// ---- 后端英文错误 → 中文 ----

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/orchestration rules are required/i, "组群方案必须先写出群聊编排规则"],
  [/reference a member outside/i, "编排规则里引用了方案外的成员"],
  [/unmapped member/i, "编排规则里有无法对应到专家的引用"],
  [/Malformed member reference/i, "编排规则里有成员引用格式不对，应写成 @{成员标识}"],
  [/does not need to be confirmed/i, "这一项对当前方案类型不需要确认"],
  [/changed after/i, "内容在确认后被修改，需要重新确认"],
  [/has already been resolved/i, "这个敏感项已经处理过了"],
  [/leave a required field empty/i, "删除这段内容会让必填项变空，请改为直接编辑正文"],
  [/only a system_admin/i, "只有管理员可以执行这个操作"],
  [/cannot be archived while it is generating/i, "生成中的草稿不能直接删除，请先取消生成"],
  [/publishing has already started/i, "发布已经开始，不能驳回，请重试发布"],
  [/only a draft in review can be approved/i, "只有审核中的草稿可以通过"],
  [/only an approved draft can be published/i, "只有审核通过的草稿可以发布"],
  [/draft changed while it was being published/i, "发布期间草稿被改动，请刷新后重试"],
  [/a reason is required/i, "驳回需要填写理由"],
  [/sources cannot be changed/i, "当前状态下不能修改资料"],
  [/is not available while the draft is/i, "当前状态下不能执行这个操作"],
  [/version/i, "草稿已被其他人修改，请刷新后重试"],
];

/** 把后端的英文说明说成中文；认不出的原样返回（不吞信息）。 */
export function friendlyError(text: string): string {
  if (/[\u4e00-\u9fff]/.test(text)) return text;
  for (const [pattern, zh] of ERROR_PATTERNS) if (pattern.test(text)) return zh;
  return text;
}
