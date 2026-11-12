/**
 * 识别模式（图片识别方案 B：多模态模型）。
 *
 * 每张图片一个全新的会话：图片之间互不可见，一张图里的文字影响不到另一张的识别。
 * 单张失败只标记为 unrecognized，由宿主记成发现项；预算 / 超时才让整个任务失败。
 */
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelHandle } from "./model.js";
import { JobError, type ImageInput, type RecognizeJob, type RecognizeResult } from "./protocol.js";
import { createIsolatedSession, textResult, type RunGuard } from "./session.js";
import { RecognizedBlockSchema, type RecognizedBlock, type RecognizedImage } from "./solution-schema.js";

interface ImageState {
  blocks?: RecognizedBlock[];
  unreadable?: string;
}

function createRecognizeTools(state: ImageState): ToolDefinition[] {
  const submit = defineTool({
    name: "submit_recognition",
    label: "Submit recognition",
    description: "提交这张图片的识别结果：按阅读顺序给出文字、表格、图表各块。只转写图片里实际存在的内容。",
    parameters: Type.Object({
      blocks: Type.Array(RecognizedBlockSchema, { minItems: 1, maxItems: 40 }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      state.blocks = params.blocks;
      return textResult("已接收。", true);
    },
  });
  const unreadable = defineTool({
    name: "report_unreadable",
    label: "Report unreadable",
    description: "图片里没有可识别的文字或图表（空白、纯装饰、过于模糊）时调用，说明原因。",
    parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      state.unreadable = params.reason;
      return textResult("已记录。", true);
    },
  });
  return [submit, unreadable] as ToolDefinition[];
}

async function recognizeOne(job: RecognizeJob, image: ImageInput, handle: ModelHandle, workDir: string, guard: RunGuard): Promise<RecognizedImage> {
  const state: ImageState = {};
  const session = await createIsolatedSession({ handle, workDir, systemPrompt: job.system_prompt, tools: createRecognizeTools(state), budget: job.budget });
  const watch = guard.watch(session);
  const unrecognized = (reason: string): RecognizedImage => ({ image_id: image.image_id, status: "unrecognized", blocks: [], reason });
  try {
    await guard.race(session.prompt(job.task_prompt, {
      images: [{ type: "image", data: image.data_base64, mimeType: image.media_type }],
      expandPromptTemplates: false,
    }));
    if (state.blocks) return { image_id: image.image_id, status: "recognized", blocks: state.blocks, reason: "" };
    if (state.unreadable) return unrecognized(state.unreadable.replace(/\s+/g, " ").trim().slice(0, 200));
    return unrecognized(watch.modelError ? "model_error" : "no_result");
  } catch (error) {
    if (error instanceof JobError && error.code === "model_error") return unrecognized("model_error");
    throw error;
  } finally {
    watch.stop();
    session.dispose();
  }
}

export async function runRecognize(job: RecognizeJob, handle: ModelHandle, workDir: string, guard: RunGuard): Promise<RecognizeResult> {
  if (!handle.supportsImages) throw new JobError("vision_unsupported", "the injected model does not accept image input");
  const images: RecognizedImage[] = [];
  for (const image of job.images) images.push(await recognizeOne(job, image, handle, workDir, guard));
  return { images };
}
