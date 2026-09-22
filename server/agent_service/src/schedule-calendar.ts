import { Temporal } from "@js-temporal/polyfill";

export interface CalendarRule {
  mode: "daily" | "weekly" | "monthly";
  timezone: string;
  time: string;
  weekday?: number;
  day_of_month?: number;
  invalid_date_policy?: "skip";
}

export function validateCalendar(value: unknown): CalendarRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("calendar must be an object");
  const raw = value as Record<string, unknown>;
  const keys = ["mode", "timezone", "time", ...(raw.mode === "weekly" ? ["weekday"] : []), ...(raw.mode === "monthly" ? ["day_of_month", "invalid_date_policy"] : [])];
  if (Object.keys(raw).some(key => !keys.includes(key)) || !["daily", "weekly", "monthly"].includes(String(raw.mode))) throw new Error("Unsupported calendar fields");
  if (typeof raw.timezone !== "string" || /^[+-]/.test(raw.timezone)) throw new Error("IANA timezone required");
  new Intl.DateTimeFormat("en", { timeZone: raw.timezone });
  if (typeof raw.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(raw.time)) throw new Error("time must be HH:mm:ss");
  if (raw.mode === "weekly" && (!Number.isInteger(raw.weekday) || Number(raw.weekday) < 1 || Number(raw.weekday) > 7)) throw new Error("weekday must be 1–7");
  if (raw.mode === "monthly" && (!Number.isInteger(raw.day_of_month) || Number(raw.day_of_month) < 1 || Number(raw.day_of_month) > 31 || raw.invalid_date_policy !== "skip")) throw new Error("monthly requires day_of_month 1–31 and invalid_date_policy skip");
  return raw as unknown as CalendarRule;
}

/** DST gaps are skipped; a fold fires at its earlier instant only. Search is bounded to one year. */
export function calendarOccurrence(rule: CalendarRule, timestamp: number, direction: 1 | -1): number | undefined {
  let date = Temporal.Instant.fromEpochMilliseconds(timestamp).toZonedDateTimeISO(rule.timezone).toPlainDate();
  const time = Temporal.PlainTime.from(rule.time);
  for (let days = 0; days < 370; days++, date = date.add({ days: direction })) {
    if (rule.mode === "weekly" && date.dayOfWeek !== rule.weekday) continue;
    if (rule.mode === "monthly" && date.day !== rule.day_of_month) continue;
    const local = date.toPlainDateTime(time);
    const zoned = local.toZonedDateTime(rule.timezone, { disambiguation: "earlier" });
    if (!zoned.toPlainDateTime().equals(local)) continue;
    const candidate = zoned.epochMilliseconds;
    if (direction === 1 ? candidate > timestamp : candidate <= timestamp) return candidate;
  }
  return undefined;
}
