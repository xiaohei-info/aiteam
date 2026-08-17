export interface OfficeEmployee { employee_id: string; display_name: string; status: string; task: string | null; avatar_url: string | null; }
export interface OfficeScene { employees: OfficeEmployee[]; summary: Record<string, number>; }

/** A schedule is Conversation metadata; execution state belongs to Pi events, not a Loop record. */
export interface ConversationSchedule {
  type: "conversation_schedule";
  conversation_id: string;
  title: string;
  schedule: Record<string, unknown>;
}
export interface OfficeFeed { events: ConversationSchedule[]; }
