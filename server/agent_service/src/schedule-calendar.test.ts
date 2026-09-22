import test from "node:test";
import assert from "node:assert/strict";
import { calendarOccurrence, validateCalendar } from "./schedule-calendar.js";
import { nextScheduleAt, validateSchedule } from "./schedule.js";
const next = (rule: unknown, at: string) => new Date(calendarOccurrence(validateCalendar(rule), Date.parse(at), 1)!).toISOString();
test("calendar monthly skips invalid dates and weekly uses ISO weekday", () => {
  assert.equal(next({ mode: "monthly", timezone: "Asia/Shanghai", time: "09:00:00", day_of_month: 31, invalid_date_policy: "skip" }, "2026-02-01T00:00:00Z"), "2026-03-31T01:00:00.000Z");
  assert.equal(next({ mode: "weekly", timezone: "Asia/Shanghai", time: "09:00:00", weekday: 1 }, "2026-09-22T00:00:00Z"), "2026-09-28T01:00:00.000Z");
});
test("DST gap skips the day and fold runs only at the earlier instant", () => {
  const rule = { mode: "daily", timezone: "America/New_York", time: "02:30:00" };
  assert.equal(next(rule, "2026-03-08T00:00:00Z"), "2026-03-09T06:30:00.000Z");
  assert.equal(next({ ...rule, time: "01:30:00" }, "2026-11-01T00:00:00Z"), "2026-11-01T05:30:00.000Z");
  assert.equal(next({ ...rule, time: "01:30:00" }, "2026-11-01T05:30:00Z"), "2026-11-02T06:30:00.000Z");
});
test("calendar validation preserves legacy interval and rejects mixed rules", () => {
  assert.throws(() => validateCalendar({ mode: "daily", timezone: "+08:00", time: "09:00:00" }));
  assert.throws(() => validateCalendar({ mode: "daily", timezone: "UTC", time: "25:00:00" }));
  assert.throws(() => validateSchedule({ schedule_id: "c", prompt_template: "run", calendar: { mode: "daily", timezone: "UTC", time: "09:00:00" }, interval_seconds: 300 }));
  const legacy = validateSchedule({ schedule_id: "old", prompt_template: "run", interval_seconds: 1 });
  assert.equal(nextScheduleAt(legacy, 1200), "1970-01-01T00:00:02.000Z");
});
