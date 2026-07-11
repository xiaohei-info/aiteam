export interface AuditEvent extends Record<string, unknown> {
  event_id: string;
  event_type: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}
