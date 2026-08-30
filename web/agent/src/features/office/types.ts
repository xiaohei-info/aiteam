export interface OfficeEmployee {
  employee_id: string;
  display_name: string;
  status: string;
  task: string | null;
  avatar_url: string | null;
}

export interface OfficeScene {
  employees: OfficeEmployee[];
  summary: Record<string, number>;
}

/** A feed item is Conversation metadata; execution state belongs to the Pi event stream. */
export interface ConversationSchedule {
  type: string;
  conversation_id: string;
  title: string;
  schedule: Record<string, unknown> | null;
}

export interface OfficeFeed {
  events: ConversationSchedule[];
}
