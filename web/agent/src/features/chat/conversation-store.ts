import type { Conversation } from "./useChatApi";

const STORAGE_KEY = "aiteam.agent.conversations";

export function readLocalConversations(): Conversation[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value as Conversation[] : [];
  } catch {
    return [];
  }
}

export function writeLocalConversation(conversation: Conversation): void {
  const conversations = readLocalConversations().filter((item) => item.id !== conversation.id);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([conversation, ...conversations]));
  }
}

export function updateLocalConversation(id: string, patch: Partial<Conversation>): Conversation | null {
  const conversation = readLocalConversations().find((item) => item.id === id);
  if (!conversation) return null;
  const updated = { ...conversation, ...patch, updated_at: new Date().toISOString() };
  writeLocalConversation(updated);
  return updated;
}

export function makeLocalConversation(input: {
  title?: string | null;
  collaboration_mode?: "free" | "orchestrated" | null;
  entry_employee_id?: string | null;
  solution_instance_id?: string | null;
}): Conversation {
  const now = new Date().toISOString();
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `conversation-${Date.now()}`;
  return {
    id,
    title: input.title ?? null,
    state: "active",
    collaboration_mode: input.collaboration_mode ?? "free",
    ...(input.entry_employee_id ? { entry_employee_id: input.entry_employee_id } : {}),
    ...(input.solution_instance_id ? { solution_instance_id: input.solution_instance_id } : {}),
    last_read_at: null,
    last_read_message_id: null,
    created_at: now,
    updated_at: now,
  };
}
