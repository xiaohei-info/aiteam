import assert from "node:assert/strict";
import { test } from "node:test";
import { JobError, parseJob, safeMessage } from "./protocol.js";
import { normalizeSolution, solutionProblems, type GeneratedSolution } from "./solution-schema.js";
import { chunk, generateJob, recognizeJob, validSolution } from "./test-helpers.js";

function rejects(raw: string, pattern: RegExp): void {
  assert.throws(() => parseJob(raw), (error: unknown) => {
    assert.ok(error instanceof JobError);
    assert.equal(error.code, "invalid_job");
    assert.match(error.message, pattern);
    return true;
  });
}

test("parseJob accepts generate and recognize jobs", () => {
  assert.equal(parseJob(JSON.stringify(generateJob())).mode, "generate");
  assert.equal(parseJob(JSON.stringify(recognizeJob())).mode, "recognize");
});

test("parseJob accepts an injected provider model", () => {
  const job = generateJob({
    model: { kind: "provider", base_url: "https://relay.example/v1", api_protocol: "openai-completions", model_id: "m1", api_key: "k", provider_ref: "internal", input: ["text", "image"] },
  });
  assert.equal(parseJob(JSON.stringify(job)).model.kind, "provider");
});

test("parseJob rejects malformed input without echoing it", () => {
  rejects("{not json", /not valid JSON/);
  rejects(JSON.stringify({ mode: "other" }), /mode must be/);
  rejects(JSON.stringify({ ...generateJob(), extra: 1 }), /protocol schema/);
  rejects(JSON.stringify({ ...generateJob(), protocol_version: 2 }), /protocol schema/);
  rejects(JSON.stringify(generateJob({ chunks: [] })), /protocol schema/);
  rejects(JSON.stringify(generateJob({ chunks: [chunk("a", "x"), chunk("a", "y")] })), /chunk_id must be unique/);
  rejects(JSON.stringify(recognizeJob(["i1", "i1"])), /image_id must be unique/);

  const secret = "sk-SECRET-VALUE-123456";
  const bad = { ...generateJob(), model: { kind: "provider", api_key: secret } };
  assert.throws(() => parseJob(JSON.stringify(bad)), (error: unknown) => {
    assert.ok(error instanceof JobError);
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes("来料检验"));
    return true;
  });
});

test("safeMessage redacts secrets, flattens whitespace and bounds length", () => {
  assert.equal(safeMessage(new Error("401 for key abc123\n  retry"), ["abc123"]), "401 for key [redacted] retry");
  assert.equal(safeMessage("x".repeat(1000)).length, 300);
  assert.equal(safeMessage(42), "42");
});

test("solutionProblems reports team and evidence inconsistencies", () => {
  const known = new Set(["s1-c1", "s1-c2"]);
  assert.deepEqual(solutionProblems(validSolution() as GeneratedSolution, known), []);

  const broken = validSolution({ coordinator_key: "ghost" }) as GeneratedSolution;
  broken.experts[1]!.key = "lead";
  broken.experts[0]!.evidence = [{ chunk_id: "s9-c9" }];
  broken.experts[1]!.display_name = "   ";
  const problems = solutionProblems(broken, known).join("\n");
  assert.match(problems, /key 重复：lead/);
  assert.match(problems, /coordinator_key「ghost」/);
  assert.match(problems, /s9-c9/);
  assert.match(problems, /experts\[1\]\.display_name/);
});

test("normalizeSolution fills optional fields so the host schema sees one shape", () => {
  const normalized = normalizeSolution(validSolution({ tags: [" 质检 ", "质检", ""] }) as GeneratedSolution);
  assert.deepEqual(normalized.tags, ["质检"]);
  assert.equal(normalized.coordinator_instructions, "");
  assert.equal(normalized.output_requirements, "");
  assert.deepEqual(normalized.evidence, []);
  assert.deepEqual(normalized.experts[1]!.evidence, [{ chunk_id: "s1-c1", quote: "" }]);
});
