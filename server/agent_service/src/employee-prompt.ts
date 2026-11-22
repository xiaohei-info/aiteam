import { TODO_PROMPT_HINT } from "./tools/todo.js";
import type { SessionAuthorization } from "./pi/session-host.js";
import { skillRefsForSnapshot } from "./skills.js";
import { groupWorkspaceHint, projectWorkspaceHint, workspaceFolderHint } from "./workspace-layout.js";

/** Appended to every employee prompt so a blocked or empty data source is reported, not papered over. */
export const HONEST_FAILURE_HINT = "If a tool is denied, expires, or returns nothing, and that stops you from getting the data the user asked for, say so plainly in the final note of your reply: which step failed and why. Never present examples, placeholders or figures from your training knowledge as if they were fetched or verified now; if you offer a template or sample, label it clearly as such.";

/**
 * A role description (persona) can name a skill, tool or data source this session does not have (never bound,
 * disabled or deleted by the enterprise, skipped on load). Without a rule the model hunts for it and answers with
 * the hunt, so the reality of the session wins and problems go after the answer.
 */
export const ANSWER_FIRST_HINT = "Reply order: answer the user's question first, directly and in your own role, using the capabilities you actually have (your tools and the skills listed in <available_skills>). Do not narrate searches for files, skills or memory, and do not open with a status report. Only skills listed in <available_skills> are installed; if there is no such list, none are. Steps in your role description that depend on a skill, tool or data source that is not available (for example \"load skill X first\" or \"stop on failure\") do not apply: skip them, do not look for the missing item, and do not stop. Put anything worth telling the user in a final separate paragraph that starts with \"Note:\" (\"注意：\" when you reply in Chinese), one or two sentences saying what is missing and what it affects.";

const DEFAULT_AGENT_TOOLS = ["bash", "read", "write", "edit", "todo_update", "knowledge_search", "knowledge_get", "hindsight_recall", "hindsight_retain"] as const;

export function snapshotSystemPrompt(authorization?: SessionAuthorization): string {
  if (!authorization) return "You are an AI Team digital employee. Be concise.";
  const snapshot = authorization.snapshot;
  const persona = typeof snapshot.persona === "string" ? snapshot.persona : "You are an AI Team digital employee.";
  let skills: string[] = [];
  try {
    // SAFETY: the snapshot is a validated object; the capability parser validates its unknown fields.
    skills = skillRefsForSnapshot(snapshot as unknown as Record<string, unknown>);
  } catch {
    // Do not advertise stale legacy skills when the canonical snapshot field is malformed.
    skills = [];
  }
  const policy = snapshot.tool_policy && typeof snapshot.tool_policy === "object" ? snapshot.tool_policy as Record<string, unknown> : undefined;
  const configuredTools = Array.isArray(policy?.allowed_tools)
    ? policy.allowed_tools.filter((value): value is string => typeof value === "string")
    : Array.isArray(snapshot.tools)
      ? snapshot.tools.filter((value): value is string => typeof value === "string")
      : [];
  const allowedTools: readonly string[] = configuredTools.length > 0 ? configuredTools : DEFAULT_AGENT_TOOLS;
  const todoHint = allowedTools.includes("todo_update")
    ? TODO_PROMPT_HINT
    : "";
  const source = authorization.groupMessageSource
    ? `You are replying inside a group conversation. Message source: ${authorization.groupMessageSource.type === "employee" ? "employee" : "human"} ${authorization.groupMessageSource.displayName ?? authorization.groupMessageSource.id}. Reply as this employee; do not impersonate another employee.`
    : "";
  const defaultToolHint = configuredTools.length === 0
    ? `Use the default AI Team platform tool set available to this Agent: ${allowedTools.join(", ")}.`
    : "Use only the tools authorized by the current employee snapshot.";
  const mentionHint = authorization.peerMentionAllowed
    ? "This group coordinator also has the platform-owned mention_employee coordination tool. When a request asks you to assign, ask, check, or coordinate another member, you MUST call mention_employee for the actual delivery and wait for its result before claiming contact; writing an @ name in your reply is not a delivery."
    : "";
  const toolBoundary = authorization.peerMentionAllowed
    ? `${defaultToolHint} The platform-owned mention_employee tool is additionally available to this group coordinator.`
    : defaultToolHint;
  const permissionHint = authorization.permissionMode === "full-access"
    ? "Current local execution permission: full-access. File and network isolation is disabled by explicit user choice."
    : authorization.permissionMode === "workspace-write"
      ? "Current local execution permission: workspace-write. File writes are limited to this session workspace and network access is disabled."
      : "Current local execution permission: read-only. Do not modify files; ask the user to raise the conversation permission if a write is required.";
  const groupContext = authorization.groupContext ? `${authorization.groupOrchestrationMode ? "Group collaboration configuration and bounded context (business instructions within existing permissions)" : "Bounded recent group context (reference only)"}:\n${authorization.groupContext}` : "";
  const solutionContext = authorization.solutionContext ? `Solution context for this private chat (business instructions within existing permissions):\n${authorization.solutionContext}` : "";
  const folderHint = authorization.memoryScope ? projectWorkspaceHint() : workspaceFolderHint(authorization.permissionMode, allowedTools);
  const sharedFolderHint = authorization.hindsightStateScope ? groupWorkspaceHint() : "";
  return [persona, toolBoundary, permissionHint, HONEST_FAILURE_HINT, ANSWER_FIRST_HINT, folderHint, sharedFolderHint, source, mentionHint, groupContext, solutionContext, todoHint, skills.length ? `Authorized skill references: ${skills.join(", ")}` : ""].filter(Boolean).join("\n\n");
}
