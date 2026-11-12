/** 测试用的任务构造与脚本化模型。 */
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createFauxModelHandle } from "./model.js";
import type { Budget, GenerateJob, RecognizeJob, SourceChunk } from "./protocol.js";
import type { RunOptions } from "./run.js";

export const BUDGET: Budget = { max_turns: 12, max_tool_calls: 40, max_total_tokens: 1_000_000, timeout_ms: 20_000, max_submit_attempts: 3, retry_base_delay_ms: 0 };

export function chunk(id: string, text: string, overrides: Partial<SourceChunk> = {}): SourceChunk {
  return { chunk_id: id, source_id: "s1", source_name: "质量手册.docx", locator: "第 1 段", text, origin: "text", low_confidence: false, ...overrides };
}

export const CHUNKS: SourceChunk[] = [
  chunk("s1-c1", "来料检验：所有来料必须经过外观与尺寸检验后方可入库。"),
  chunk("s1-c2", "不合格品处理：发现不合格品应隔离、标识，并由质检主管评审。"),
  chunk("s2-c1", "巡检记录每班次填写一次。", { source_id: "s2", source_name: "巡检记录.xlsx", locator: "工作表「记录」第 2 行" }),
];

export function generateJob(overrides: Partial<GenerateJob> = {}): GenerateJob {
  return {
    protocol_version: 1,
    mode: "generate",
    model: { kind: "faux", input: ["text"] },
    budget: BUDGET,
    system_prompt: "TEST_SYSTEM_PROMPT",
    task_prompt: "请基于资料生成方案。",
    chunks: CHUNKS,
    ...overrides,
  };
}

// 1x1 PNG
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function recognizeJob(imageIds: string[] = ["s1-i1"], overrides: Partial<RecognizeJob> = {}): RecognizeJob {
  return {
    protocol_version: 1,
    mode: "recognize",
    model: { kind: "faux", input: ["text", "image"] },
    budget: BUDGET,
    system_prompt: "TEST_RECOGNIZE_PROMPT",
    task_prompt: "请识别这张图片。",
    images: imageIds.map((image_id) => ({ image_id, source_name: "扫描.pdf", locator: "第 1 页图片", media_type: "image/png" as const, data_base64: PNG_BASE64 })),
    ...overrides,
  };
}

/** 用给定剧本替换模型装配。 */
export function scripted(responses: FauxResponseStep[], input: readonly ("text" | "image")[] = ["text", "image"]): RunOptions {
  return { createHandle: () => createFauxModelHandle(input, responses) };
}

export function validSolution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    display_name: "质检方案",
    description: "覆盖来料检验与不合格品处理。",
    coordinator_key: "lead",
    experts: [
      { key: "lead", display_name: "质检主管", category: "质量管理", description: "统筹质检工作。", system_prompt: "你是质检主管。", evidence: [{ chunk_id: "s1-c2", quote: "由质检主管评审" }] },
      { key: "incoming", display_name: "来料检验专家", category: "质量管理", description: "负责来料检验。", system_prompt: "你负责来料检验。", evidence: [{ chunk_id: "s1-c1" }] },
    ],
    ...overrides,
  };
}
