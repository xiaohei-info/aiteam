import { safeText } from "../pi/event-sse.js";

/** Display metadata only; never infer a position or a primary department from roles/persona. */
export function employeeDisplay(value?: { role_title?: unknown; department_ids?: unknown }) {
  return {
    role_title: typeof value?.role_title === "string" && value.role_title.length > 0 ? safeText(value.role_title, 100) : null,
    department_ids: Array.isArray(value?.department_ids)
      ? value.department_ids.filter((id): id is string => typeof id === "string" && id.length > 0).map((id) => safeText(id, 256))
      : [],
  };
}
