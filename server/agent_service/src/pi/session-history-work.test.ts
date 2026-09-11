import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WorkRecordRow } from "../storage/work-records.js";
import { workIdsForEntries } from "./session-history.js";

const entries = Array.from({ length: 6 }, (_, index) => ({ id: `e${index}` })) as SessionEntry[];
const work = (id: string, start: number, end: number | null, extra: Partial<WorkRecordRow> = {}) => ({
  id, provenance: "live", outcome: end === null ? "active" : "succeeded", start_ordinal: start,
  end_ordinal: end, first_entry_id: end === null ? null : `e${start}`,
  last_entry_id: end === null ? null : `e${end - 1}`, ...extra,
}) as WorkRecordRow;

test("live work ranges retain their IDs during execution and after finalization", () => {
  assert.deepEqual([...workIdsForEntries(entries, [work("w1", 0, 3), work("w2", 3, null)])], [
    [0, "w1"], [1, "w1"], [2, "w1"], [3, "w2"], [4, "w2"], [5, "w2"],
  ]);
  assert.deepEqual(workIdsForEntries(entries, [work("w2", 3, null)]), workIdsForEntries(entries, [work("w2", 3, 6)]));
});
test("unknown, inferred, mismatched and overlapping work ranges cannot misattribute entries", () => {
  assert.equal(workIdsForEntries(entries, [work("w", 0, null, { outcome: "unknown" })]).size, 0);
  assert.equal(workIdsForEntries(entries, [work("w", 0, 6, { provenance: "pi_history" })]).size, 0);
  assert.equal(workIdsForEntries(entries, [work("w", 0, 6, { first_entry_id: "other" })]).size, 0);
  assert.equal(workIdsForEntries(entries, [work("w", 0, 7)]).size, 0);
  assert.deepEqual([...workIdsForEntries(entries, [work("a", 0, 4), work("b", 2, 6)])], [[0, "a"], [1, "a"], [4, "b"], [5, "b"]]);
});
