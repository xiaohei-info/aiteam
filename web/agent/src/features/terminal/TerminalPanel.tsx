/**
 * W-A.3 Terminal / 命令执行面板（issue #415）。
 *
 * 用户端本地 Agent 的终端：在会话内执行 bash / 文件 / 网络命令，stdout / stderr 归一为
 * command_output 事件流式回显；终态展示 completed / error / cancelled。
 *
 * 红线（D6）：只消费归一命令事件（command_started/command_output/completed/error/cancelled），
 * 不绑 runtime-native 事件形态。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, cn } from "@aiteam/shared/ui";
import type { AgentApiClient } from "../../lib/api-client";
import { useApp } from "../../lib/app-context";
import { executeCommand, type TerminalEvent } from "./useTerminalApi";

export interface TerminalLine {
  id: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface TerminalPanelProps {
  client: AgentApiClient;
  conversationId: string;
  /** 外部刷新信号：会话切换时重置历史。 */
  refreshSignal?: number;
}

type RunState = "idle" | "running" | "completed" | "error" | "cancelled";

const SHELL_HINT = "bash";

export function TerminalPanel({ client, conversationId, refreshSignal = 0 }: TerminalPanelProps) {
  const { token, session } = useApp();
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [command, setCommand] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const outRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  const pushLine = useCallback((stream: TerminalLine["stream"], text: string) => {
    const id = ++idRef.current;
    setLines((prev) => [...prev, { id, stream, text }]);
  }, []);

  // 会话切换 / 刷新信号：清空历史。
  useEffect(() => {
    setLines([]);
    setError(null);
    setRunState("idle");
    idRef.current = 0;
  }, [conversationId, refreshSignal]);

  // 输出区自动滚动到底。
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const running = runState === "running";

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const cmd = command.trim();
      if (!cmd || running) return;

      setError(null);
      pushLine("system", "$ " + cmd);
      setCommand("");
      setRunState("running");

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const { success, err } = await executeCommand(
          {
            command: cmd,
            conversationId,
            token,
            baseUrl: "",
            signal: controller.signal,
          },
          (ev: TerminalEvent) => {
            if (ev.type === "command_output") {
              const stream = ev.payload.stream === "stderr" ? "stderr" : "stdout";
              const data = typeof ev.payload.data === "string" ? ev.payload.data : "";
              if (data) pushLine(stream, data);
            }
          },
        );
        if (success) {
          setRunState("completed");
        } else if (err === "cancelled") {
          setRunState("cancelled");
          pushLine("system", "(已取消)");
        } else {
          setRunState("error");
          setError(err ?? "命令执行失败");
          if (err) pushLine("system", "Error: " + err);
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          setRunState("cancelled");
        } else {
          setRunState("error");
          setError((err as Error)?.message ?? "执行失败");
        }
      } finally {
        abortRef.current = null;
      }
    },
    [command, conversationId, pushLine, running, token],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  void client;
  if (!session) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-sm">
          <span className="text-xs font-semibold text-text-primary">Terminal</span>
          <span className="rounded-sm border border-gold/15 px-xs text-xs text-text-muted">
            {SHELL_HINT}
          </span>
        </div>
        <span
          className={cn(
            "text-xs",
            runState === "completed" && "text-success",
            runState === "error" && "text-danger",
            runState === "cancelled" && "text-text-muted",
            running && "text-gold",
          )}
        >
          {runState}
        </span>
      </div>

      <div
        ref={outRef}
        className="flex min-h-[160px] flex-1 flex-col gap-xs overflow-auto rounded-md border border-gold/15 bg-surface p-sm font-mono text-xs text-text-primary"
        role="log"
        aria-live="polite"
        aria-label="命令输出"
      >
        {lines.length === 0 && !running && (
          <span className="text-text-muted">
            输入命令开始执行。命令在用户端本地隔离 cwd 中执行。
          </span>
        )}
        {lines.map((line) => (
          <pre
            key={line.id}
            className={cn(
              "m-0 whitespace-pre-wrap break-all",
              line.stream === "stderr" && "text-danger",
              line.stream === "system" && "text-text-muted",
            )}
          >
            {line.text}
          </pre>
        ))}
        {error && runState === "error" && (
          <pre className="m-0 whitespace-pre-wrap break-all text-danger">{error}</pre>
        )}
      </div>

      <form className="flex items-center gap-sm" onSubmit={handleSubmit}>
        <Input
          value={command}
          onChange={(e) => setCommand(e.currentTarget.value)}
          placeholder="例如：echo hello"
          aria-label="命令输入"
          className="flex-1"
          disabled={running}
          autoComplete="off"
          spellCheck={false}
        />
        {running ? (
          <Button type="button" variant="ghost" size="sm" onClick={handleCancel}>
            取消
          </Button>
        ) : (
          <Button type="submit" size="sm" disabled={running || command.trim().length === 0}>
            执行
          </Button>
        )}
      </form>
    </div>
  );
}
