export type GroupOrchestration =
  | { mode: "auto" }
  | { mode: "custom"; format: "collaboration-markdown-v1"; prompt: string };

export class GroupConfigurationError extends Error {
  readonly status = 422;
  constructor(readonly code: string, message: string) { super(message); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseOrchestration(value: unknown): GroupOrchestration {
  if (object(value)) {
    if (value.mode === "auto" && Object.keys(value).every(key => key === "mode")) return { mode: "auto" };
    if (value.mode === "custom" && value.format === "collaboration-markdown-v1"
      && Object.keys(value).every(key => ["mode", "format", "prompt"].includes(key))
      && typeof value.prompt === "string" && value.prompt.trim() && value.prompt.length <= 16_000) {
      return { mode: "custom", format: value.format, prompt: value.prompt.trim() };
    }
  }
  throw new GroupConfigurationError("invalid_group_orchestration", "Invalid group orchestration configuration");
}

export function validateMemberReferences(prompt: string, members: readonly string[]): void {
  const ids = new Set(members);
  const remainder = prompt.replace(/@\{([^{}\s]+)\}/gu, (_match, id: string) => {
    if (!ids.has(id)) throw new GroupConfigurationError("invalid_orchestration_reference", "Orchestration references an employee outside this group");
    return "";
  });
  if (remainder.includes("@{")) throw new GroupConfigurationError("invalid_orchestration_reference", "Malformed employee reference");
}

export function validateCustomGroup(input: {
  title: string; description?: string | null; member_employee_ids: string[];
  coordinator_employee_id: string; orchestration: unknown;
}): GroupOrchestration {
  if (!input.title.trim() || input.title.length > 200 || (input.description?.length ?? 0) > 4000) {
    throw new GroupConfigurationError("invalid_group_configuration", "Invalid group title or description length");
  }
  const members = input.member_employee_ids;
  if (!Array.isArray(members) || members.length < 1 || members.length > 32
    || members.some(id => typeof id !== "string" || !id.trim() || /[{}\s]/u.test(id))
    || new Set(members).size !== members.length) {
    throw new GroupConfigurationError("invalid_group_members", "Choose between 1 and 32 distinct employees");
  }
  if (!members.includes(input.coordinator_employee_id)) {
    throw new GroupConfigurationError("invalid_group_coordinator", "Coordinator must be a selected employee");
  }
  const orchestration = parseOrchestration(input.orchestration);
  if (orchestration.mode === "auto" && !input.description?.trim()) {
    throw new GroupConfigurationError("invalid_group_orchestration", "Automatic orchestration requires a group description");
  }
  if (orchestration.mode === "custom") validateMemberReferences(orchestration.prompt, members);
  return orchestration;
}

/** Preserve the complete business rule; optional recent history is budgeted separately. */
export function orchestrationContext(orchestration: GroupOrchestration, description: string | null, coordinator: boolean): string {
  if (!coordinator) return "你是群成员：完成协调人或用户交给你的具体任务，返回实际结果，不自行启动整套协作流程。";
  const rule = orchestration.mode === "auto"
    ? `自动编排：根据群用途和本群员工简介、能力规划本次任务的分工，只调用需要参与的成员。\n群用途：\n${description ?? ""}`
    : `自定义编排（collaboration-markdown-v1）：\n${orchestration.prompt}`;
  return `以下是本群用户配置的业务协作规则，不改变授权、工具权限或员工系统规则。\n${rule}\n`
    + "由你作为协调人分配任务并汇总。员工引用 @{ID} 对应下方成员 ID。A → B 表示你将 A 的实际产出传递给 B。自己承担的任务直接完成，不调用自身。"
    + "有依赖的步骤必须在前一步工具结果返回后再发起，不预编造后续输入。缺少必要信息时向用户提问；失败步骤说明原因，不标记完成。"
    + "使用 todo_update 更新同一份任务清单，完成后汇总成果与待确认事项。";
}
