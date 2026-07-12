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
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
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
        const { success, error: execError } = await executeCommand(
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
        } else if (execError === "cancelled") {
          setRunState("cancelled");
          pushLine("system", "(已取消)");
        } else {
          setRunState("error");
          setError(execError ?? "命令执行失败");
          if (execError) pushLine("system", "Error: " + execError);
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
    <VStack gap={2} role="region" aria-label="本地终端" minHeight={0}>
      <HStack justify="between" align="center">
        <HStack gap={1} align="center">
          <Text type="label">Terminal</Text>
          <Badge label={SHELL_HINT} />
        </HStack>
        <Badge
          label={runState}
          variant={runState === "completed" ? "success" : runState === "error" ? "error" : running ? "warning" : "neutral"}
        />
      </HStack>

      <Card
        ref={outRef}
        minHeight={160}
        padding={2}
        role="log"
        aria-live="polite"
        aria-label="命令输出"
      >
        <VStack gap={1}>
          {lines.length === 0 && !running && (
            <Text type="supporting" as="div">
            输入命令开始执行。命令在用户端本地隔离 cwd 中执行。
            </Text>
          )}
          {lines.map((line) => (
            <pre key={line.id} data-stream={line.stream}>{line.text}</pre>
          ))}
          {error && runState === "error" && <pre data-stream="stderr">{error}</pre>}
        </VStack>
      </Card>

      <form onSubmit={handleSubmit}>
        <HStack gap={2} align="end">
        <TextInput
          width="100%"
          label="命令输入"
          isLabelHidden
          value={command}
          onChange={setCommand}
          placeholder="例如：echo hello"
          isDisabled={running}
        />
        {running ? (
          <Button type="button" label="取消" variant="secondary" size="sm" onClick={handleCancel} />
        ) : (
          <Button type="submit" label="执行" variant="primary" size="sm" isDisabled={command.trim().length === 0} />
        )}
        </HStack>
      </form>
    </VStack>
  );
}
