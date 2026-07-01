/**
 * Agent Terminal / command execution adapter (issue #415).
 * Runs one bash command; streams normalized events over SSE.
 * EventSource cannot POST with headers, so we use fetch + ReadableStream.
 */

import { AgentApiClient } from "../../lib/api-client";

export type TerminalEventType =
  | "command_started"
  | "command_output"
  | "completed"
  | "error"
  | "cancelled";

export interface TerminalEvent {
  type: TerminalEventType;
  run_id: string;
  source: string;
  timestamp: string | null;
  payload: Record<string, unknown>;
}

export interface ExecuteOptions {
  command: string;
  timeoutSeconds?: number | null;
  conversationId: string;
  token: string | null;
  baseUrl?: string;
  signal?: AbortSignal;
}

export async function executeCommand(
  options: ExecuteOptions,
  onEvent: (event: TerminalEvent) => void,
): Promise<{ success: boolean; error: string | null }> {
  const { command, timeoutSeconds, conversationId, token, baseUrl = "" } = options;
  const url =
    baseUrl + "/api/agent/conversations/" + encodeURIComponent(conversationId) + "/terminal/execute";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (token) headers.Authorization = "Bearer " + token;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ command, timeout_seconds: timeoutSeconds ?? null }),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    let detail = "HTTP " + String(res.status);
    try {
      const data = await res.json();
      const d = data as { detail?: string } | null;
      if (d && typeof d.detail === "string") detail = d.detail;
    } catch {
      /* keep status text */
    }
    return { success: false, error: detail };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let terminal: TerminalEventType | null = null;
  let errorMessage: string | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseSseBlock(block);
        if (!parsed || parsed.event !== "terminal.event") continue;
        onEvent(parsed.data);
        terminal = applyTerminalState(terminal, parsed.data.type);
        if (parsed.data.type === "error") {
          const m = parsed.data.payload?.message;
          errorMessage = typeof m === "string" ? m : null;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (terminal === "completed") return { success: true, error: null };
  if (terminal === "error") return { success: false, error: errorMessage };
  if (terminal === "cancelled") return { success: false, error: "cancelled" };
  return { success: false, error: errorMessage ?? "stream closed unexpectedly" };
}

function applyTerminalState(
  current: TerminalEventType | null,
  next: TerminalEventType,
): TerminalEventType {
  if (next === "completed" || next === "error" || next === "cancelled") return next;
  return current ?? next;
}

const client = new AgentApiClient();
void client;

function parseSseBlock(block: string): { event: string; data: TerminalEvent } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) {
      event = line.slice(6).trimStart();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as TerminalEvent };
  } catch {
    return null;
  }
}
