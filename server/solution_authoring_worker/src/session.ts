/**
 * 受控 Pi 会话 + 预算守卫。
 *
 * 隔离要点（2026-11-12 实测 Pi SDK 0.84.2）：
 * - `tools` 白名单只列自定义工具后，模型看不到 bash / read / write / edit，强行调用得到 "Tool not found"；
 * - 资源加载器关闭 extensions / skills / prompt templates / themes / context files 后，工作目录里的
 *   AGENTS.md 不会进入 system prompt；
 * - 会话与设置都只在内存里，不写会话文件。
 * 创建后再断言一次实际启用的工具集合，SDK 行为若变化会直接失败而不是悄悄多出工具。
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ModelHandle } from "./model.js";
import { EMPTY_USAGE, JobError, type Budget, type ErrorCode, type Usage } from "./protocol.js";

export const DEFAULT_MODEL_RETRIES = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 30_000;

export async function createIsolatedSession(options: {
  handle: ModelHandle;
  workDir: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  budget: Budget;
}): Promise<AgentSession> {
  const { handle, workDir, systemPrompt, tools, budget } = options;
  const maxRetries = budget.model_retries ?? DEFAULT_MODEL_RETRIES;
  const loader = new DefaultResourceLoader({
    cwd: workDir,
    agentDir: workDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await loader.reload();
  const names = tools.map((tool) => tool.name);
  const { session } = await createAgentSession({
    cwd: workDir,
    agentDir: workDir,
    model: handle.model,
    modelRuntime: handle.runtime,
    thinkingLevel: handle.thinkingLevel,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(workDir),
    // 上下文压缩会在预算守卫之外调用模型：关掉。
    // 自动重试只对临时错误（限流、5xx、网络中断）生效，额度 / 计费类错误不重试；重试是新的一轮，
    // 会触发 turn_start 与 message_end，所以仍在轮数 / token / 超时预算之内；守卫中止时 abort() 也会打断退避等待。
    // SDK 层自己的重试关掉，避免两层叠加。
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: {
        enabled: maxRetries > 0,
        maxRetries,
        baseDelayMs: budget.retry_base_delay_ms ?? DEFAULT_RETRY_BASE_DELAY_MS,
        provider: { maxRetries: 0, maxRetryDelayMs: MAX_RETRY_DELAY_MS },
      },
    }),
    customTools: tools,
    tools: names,
  });
  const active = session.getActiveToolNames();
  if (active.length !== names.length || active.some((name) => !names.includes(name))) {
    session.dispose();
    throw new JobError("internal_error", "session started with an unexpected tool set");
  }
  return session;
}

export interface SessionWatch {
  /** 最近一次助手消息若以错误结束，这里是错误说明；之后有正常消息则清空。 */
  modelError?: string;
  stop(): void;
}

export interface WatchHooks {
  onTurnStart?(): void;
  onToolEnd?(toolName: string, isError: boolean): void;
}

type Trip = { code: ErrorCode; message: string };

/** 累计用量并在超出预算 / 超时时中止当前会话。一个任务一个守卫，可先后监视多个会话。 */
export class RunGuard {
  readonly usage: Usage = { ...EMPTY_USAGE };
  tripped?: Trip;
  private session?: AgentSession;
  private timer?: NodeJS.Timeout;
  private readonly tripSignal: Promise<void>;
  private notifyTrip: () => void = () => undefined;

  constructor(private readonly budget: Budget) {
    this.tripSignal = new Promise<void>((resolve) => { this.notifyTrip = resolve; });
  }

  /**
   * 等一次模型调用结束；预算或超时触发时不再等它（模型端挂住也不会拖住任务）。
   * 触发守卫 → 抛守卫的错误码；模型调用自身失败 → 抛 model_error。
   */
  async race(work: Promise<void>): Promise<void> {
    work.catch(() => undefined);
    try {
      await Promise.race([work, this.tripSignal]);
    } catch (error) {
      if (!this.tripped) throw new JobError("model_error", error instanceof Error ? error.message : String(error));
    }
    if (this.tripped) throw new JobError(this.tripped.code, this.tripped.message);
  }

  start(): void {
    this.timer = setTimeout(() => this.trip("timeout", `exceeded the ${this.budget.timeout_ms} ms time limit`), this.budget.timeout_ms);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.session = undefined;
  }

  trip(code: ErrorCode, message: string): void {
    if (this.tripped) return;
    this.tripped = { code, message };
    this.notifyTrip();
    void this.session?.abort().catch(() => undefined);
  }

  watch(session: AgentSession, hooks: WatchHooks = {}): SessionWatch {
    this.session = session;
    const watch: SessionWatch = { stop: () => undefined };
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case "turn_start":
          if (this.usage.turns >= this.budget.max_turns) this.trip("budget_exceeded", `exceeded ${this.budget.max_turns} turns`);
          else this.usage.turns += 1;
          hooks.onTurnStart?.();
          break;
        case "tool_execution_start":
          this.usage.tool_calls += 1;
          if (this.usage.tool_calls > this.budget.max_tool_calls) this.trip("budget_exceeded", `exceeded ${this.budget.max_tool_calls} tool calls`);
          break;
        case "tool_execution_end":
          hooks.onToolEnd?.(event.toolName, Boolean(event.isError));
          break;
        case "message_end":
          this.recordAssistantMessage(event.message, watch);
          break;
        default:
          break;
      }
    });
    watch.stop = () => {
      unsubscribe();
      if (this.session === session) this.session = undefined;
    };
    return watch;
  }

  private recordAssistantMessage(message: unknown, watch: SessionWatch): void {
    const assistant = message as { role?: string; stopReason?: string; errorMessage?: string; usage?: Record<string, number | undefined> };
    if (assistant.role !== "assistant") return;
    watch.modelError = assistant.stopReason === "error" ? assistant.errorMessage || "model request failed" : undefined;
    const usage = assistant.usage;
    if (!usage) return;
    const input = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    const output = usage.output ?? 0;
    this.usage.input_tokens += input;
    this.usage.output_tokens += output;
    this.usage.total_tokens += usage.totalTokens || input + output;
    if (this.usage.total_tokens > this.budget.max_total_tokens) {
      this.trip("budget_exceeded", `exceeded ${this.budget.max_total_tokens} tokens`);
    }
  }
}

export function textResult(text: string, terminate = false) {
  return { content: [{ type: "text" as const, text }], details: {}, ...(terminate ? { terminate: true } : {}) };
}
