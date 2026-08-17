/** Agent-local Pi session contracts. The browser consumes the Pi stream and persisted entries. */

export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiEventEnvelope {
  id: string;
  event: PiEvent;
}

export interface PiEntry {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface ConversationEntries {
  conversation_id: string;
  entries: PiEntry[];
}
