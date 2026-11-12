/**
 * 假模型的固定剧本：不联网，按「列资料 → 读片段 → 提交」走一遍真实的工具链路。
 *
 * 只用于自动化测试与本机联调（需要 SOLUTION_AUTHORING_ALLOW_FAUX=1）。输出内容是占位的，
 * 不代表真实生成质量；专家提示词里会带一段资料摘录，方便联调时看到证据与敏感扫描的效果。
 */
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { GenerateJob, Job, RecognizeJob } from "./protocol.js";

function generateScript(job: GenerateJob): FauxResponseStep[] {
  const first = job.chunks[0]!;
  const last = job.chunks[job.chunks.length - 1]!;
  const ids = [...new Set([first.chunk_id, last.chunk_id])];
  const sources = new Set(job.chunks.map((chunk) => chunk.source_id)).size;
  const stem = first.source_name.replace(/\.[A-Za-z0-9]+$/, "").slice(0, 40) || "行业资料";
  const excerpt = (text: string, length: number) => text.replace(/\s+/g, " ").trim().slice(0, length);
  return [
    fauxAssistantMessage([fauxToolCall("list_sources", {})]),
    fauxAssistantMessage([fauxToolCall("read_chunks", { chunk_ids: ids })]),
    fauxAssistantMessage([fauxToolCall("submit_solution", {
      display_name: `${stem}方案`,
      description: `基于 ${sources} 份资料生成的方案草稿（测试模型输出，内容仅用于联调）。`,
      tags: ["测试生成"],
      coordinator_key: "coordinator",
      coordinator_instructions: "协调专家先拆解任务，再分派给业务专家，最后汇总并复核交付物。",
      output_requirements: "交付物需列出依据的资料位置，并标明待人工确认的事项。",
      experts: [
        {
          key: "coordinator",
          display_name: "方案协调专家",
          category: "综合管理",
          description: "统筹各专家分工、把控进度并汇总交付。",
          system_prompt: "你是方案协调专家，负责理解需求、拆解任务、分派给业务专家并汇总结果。",
          evidence: [{ chunk_id: first.chunk_id, quote: excerpt(first.text, 80) }],
        },
        {
          key: "domain_expert",
          display_name: "业务专家",
          category: "行业业务",
          description: "依据资料中的制度与流程回答业务问题。",
          system_prompt: `你是业务专家，依据资料中的制度与流程开展工作。资料摘录：${excerpt(last.text, 200)}`,
          evidence: [{ chunk_id: last.chunk_id, quote: excerpt(last.text, 80) }],
        },
      ],
      evidence: [{ chunk_id: first.chunk_id }],
    })]),
  ];
}

function recognizeScript(job: RecognizeJob): FauxResponseStep[] {
  return job.images.map((image) => fauxAssistantMessage([fauxToolCall("submit_recognition", {
    blocks: [{ text: `（测试模型）${image.source_name} ${image.locator} 的图片内容`, kind: "text", confidence: 0.9 }],
  })]));
}

export function fauxScript(job: Job): FauxResponseStep[] {
  return job.mode === "generate" ? generateScript(job) : recognizeScript(job);
}
