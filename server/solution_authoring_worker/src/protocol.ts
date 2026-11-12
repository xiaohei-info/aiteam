/**
 * 宿主（Python）与 worker 之间的协议：stdin 一个 JSON 任务，stdout 一行 JSON 结果。
 *
 * 模型凭据只出现在 stdin 的任务里：不进环境变量、不落盘、不进日志与结果。
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { AgentFinding, RecognizedImage } from "./solution-schema.js";
import type { normalizeSolution } from "./solution-schema.js";

export const PROTOCOL_VERSION = 1;

const strict = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const positive = (maximum: number) => Type.Integer({ minimum: 1, maximum });

const InputModes = Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { minItems: 1, maxItems: 2 });

const ProviderModelSchema = Type.Object({
  kind: Type.Literal("provider"),
  base_url: text(2000),
  api_protocol: Type.Union([Type.Literal("openai-completions"), Type.Literal("openai-responses"), Type.Literal("anthropic-messages")]),
  model_id: text(200),
  api_key: text(4000),
  provider_ref: text(200),
  input: InputModes,
  reasoning: Type.Optional(Type.Boolean()),
  thinking_level: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high"].map((level) => Type.Literal(level)))),
  context_window: Type.Optional(positive(10_000_000)),
  max_tokens: Type.Optional(positive(1_000_000)),
}, strict);

/** 仅用于自动化测试与本机联调；需要环境变量显式放行（见 main.ts）。 */
const FauxModelSchema = Type.Object({ kind: Type.Literal("faux"), input: InputModes }, strict);

const BudgetSchema = Type.Object({
  max_turns: positive(500),
  max_tool_calls: positive(2000),
  max_total_tokens: positive(100_000_000),
  timeout_ms: positive(3_600_000),
  max_submit_attempts: positive(20),
}, strict);

const ChunkSchema = Type.Object({
  chunk_id: text(40),
  source_id: text(40),
  source_name: Type.String({ maxLength: 255 }),
  locator: Type.String({ maxLength: 120 }),
  text: Type.String({ minLength: 1 }),
  origin: Type.Union([Type.Literal("text"), Type.Literal("image")]),
  low_confidence: Type.Boolean(),
}, strict);

const ImageSchema = Type.Object({
  image_id: text(40),
  source_name: Type.String({ maxLength: 255 }),
  locator: Type.String({ maxLength: 120 }),
  media_type: Type.Union([Type.Literal("image/jpeg"), Type.Literal("image/png"), Type.Literal("image/webp")]),
  data_base64: Type.String({ minLength: 1 }),
}, strict);

const common = {
  protocol_version: Type.Literal(PROTOCOL_VERSION),
  budget: BudgetSchema,
  system_prompt: text(40_000),
  task_prompt: text(40_000),
};

const GenerateJobSchema = Type.Object({
  ...common,
  mode: Type.Literal("generate"),
  model: Type.Union([ProviderModelSchema, FauxModelSchema]),
  chunks: Type.Array(ChunkSchema, { minItems: 1, maxItems: 20_000 }),
}, strict);

const RecognizeJobSchema = Type.Object({
  ...common,
  mode: Type.Literal("recognize"),
  model: Type.Union([ProviderModelSchema, FauxModelSchema]),
  images: Type.Array(ImageSchema, { minItems: 1, maxItems: 500 }),
}, strict);

export type ProviderModelConfig = Static<typeof ProviderModelSchema>;
export type FauxModelConfig = Static<typeof FauxModelSchema>;
export type ModelConfig = ProviderModelConfig | FauxModelConfig;
export type Budget = Static<typeof BudgetSchema>;
export type SourceChunk = Static<typeof ChunkSchema>;
export type ImageInput = Static<typeof ImageSchema>;
export type GenerateJob = Static<typeof GenerateJobSchema>;
export type RecognizeJob = Static<typeof RecognizeJobSchema>;
export type Job = GenerateJob | RecognizeJob;

export type ErrorCode =
  | "invalid_job"
  | "faux_not_allowed"
  | "vision_unsupported"
  | "budget_exceeded"
  | "timeout"
  | "model_error"
  | "no_submission"
  | "schema_invalid"
  | "internal_error";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  turns: number;
  tool_calls: number;
}

export interface GenerateResult {
  solution: ReturnType<typeof normalizeSolution>;
  findings: Required<AgentFinding>[];
}

export interface RecognizeResult {
  images: RecognizedImage[];
}

export type WorkerOutput =
  | { protocol_version: typeof PROTOCOL_VERSION; status: "succeeded"; result: GenerateResult | RecognizeResult; usage: Usage }
  | { protocol_version: typeof PROTOCOL_VERSION; status: "failed"; error_code: ErrorCode; error_message: string; usage: Usage };

export const EMPTY_USAGE: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, turns: 0, tool_calls: 0 };

export class JobError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

/** 解析并校验任务。错误信息只描述哪条路径不合规，不回显任务内容（里面有密钥与文档正文）。 */
export function parseJob(raw: string): Job {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new JobError("invalid_job", "job is not valid JSON");
  }
  const mode = typeof value === "object" && value !== null ? (value as { mode?: unknown }).mode : undefined;
  const schema = mode === "generate" ? GenerateJobSchema : mode === "recognize" ? RecognizeJobSchema : undefined;
  if (!schema) throw new JobError("invalid_job", "job.mode must be generate or recognize");
  if (!Value.Check(schema, value)) {
    const paths = Value.Errors(schema, value).slice(0, 5).map((error) => `${error.instancePath || "/"}: ${error.keyword}`);
    throw new JobError("invalid_job", `job does not match the protocol schema (${paths.join("; ")})`);
  }
  if (schema === GenerateJobSchema) {
    const ids = (value as GenerateJob).chunks.map((chunk) => chunk.chunk_id);
    if (new Set(ids).size !== ids.length) throw new JobError("invalid_job", "chunk_id must be unique");
  } else {
    const ids = (value as RecognizeJob).images.map((image) => image.image_id);
    if (new Set(ids).size !== ids.length) throw new JobError("invalid_job", "image_id must be unique");
  }
  return value as Job;
}

/** 对外的错误信息：去掉密钥、压成单行、限长。 */
export function safeMessage(message: unknown, secrets: readonly string[] = []): string {
  let result = typeof message === "string" ? message : message instanceof Error ? message.message : String(message);
  for (const secret of secrets) if (secret) result = result.split(secret).join("[redacted]");
  return result.replace(/\s+/g, " ").trim().slice(0, 300);
}
