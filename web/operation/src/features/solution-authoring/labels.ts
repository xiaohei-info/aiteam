/** 状态、错误码等到中文文案的映射。未知取值原样显示，不吞掉。 */
import type { BadgeVariant } from "@astryxdesign/core/Badge";
import type { DraftStatus, FindingStatus, GeneratedSolution, JobStatus } from "./types";

const DRAFT_STATUS: Record<DraftStatus, { label: string; variant: BadgeVariant }> = {
  draft: { label: "待生成", variant: "neutral" },
  generating: { label: "生成中", variant: "info" },
  ready_for_review: { label: "待处理", variant: "warning" },
  in_review: { label: "审核中", variant: "info" },
  approved: { label: "已通过", variant: "success" },
  published: { label: "已发布", variant: "success" },
  rejected: { label: "已驳回", variant: "error" },
  archived: { label: "已归档", variant: "neutral" },
};

export function draftStatus(status: DraftStatus): { label: string; variant: BadgeVariant } {
  return DRAFT_STATUS[status] ?? { label: status, variant: "neutral" };
}

const JOB_STATUS: Record<JobStatus, string> = {
  queued: "排队中",
  parsing: "正在解析资料",
  analyzing: "正在分析并生成方案",
  succeeded: "生成完成",
  failed: "生成失败",
};

export function jobStatus(status: JobStatus): string {
  return JOB_STATUS[status] ?? status;
}

const JOB_ERRORS: Record<string, string> = {
  budget_exceeded: "超出了本次生成的预算（轮数、工具调用或 token）。可以减少资料后重试。",
  timeout: "生成超时。可以减少资料后重试。",
  worker_timeout: "生成超时。可以减少资料后重试。",
  model_error: "调用模型失败。请检查所选模型是否可用后重试。",
  model_unavailable: "所选模型当前不可用。请检查模型是否已发布、生成服务是否已配置。",
  no_submission: "模型没有提交方案。可以重试，或换一个模型。",
  schema_invalid: "模型提交的方案不符合格式要求。可以重试，或换一个模型。",
  vision_unsupported: "所选模型不支持图片输入，无法识别图片。",
  image_recognition_failed: "超过一半的图片识别失败。可以关闭图片识别或换一个模型后重试。",
  source_unavailable: "有资料原件丢失或损坏。请删除后重新上传。",
  source_parse_failed: "有资料无法解析。请删除后重新上传。",
  no_content: "资料里没有可读取的文字。",
  attempts_exhausted: "任务多次被中断，已停止重试。请重新发起生成。",
  worker_unavailable: "生成服务未就绪（服务器缺少运行环境）。请联系平台运维。",
  worker_crashed: "生成进程异常退出。请重试。",
  worker_output_too_large: "生成结果过大。请减少资料后重试。",
  worker_protocol_error: "生成进程返回了无法识别的结果。请重试。",
  internal_error: "生成时发生内部错误。请重试。",
};

export function jobError(code: string | null): string {
  if (!code) return "";
  return JOB_ERRORS[code] ?? `生成失败（${code}）`;
}

const FINDING_KIND: Record<string, string> = {
  phone: "电话号码",
  email: "邮箱",
  id_card: "身份证号",
  bank_card: "银行卡号",
  secret: "密钥或口令",
  amount: "金额",
  company: "公司名称",
  person: "人名",
  other: "其他敏感信息",
  image_unrecognized: "未识别的图片",
};

export function findingKind(kind: string): string {
  return FINDING_KIND[kind] ?? kind;
}

const FINDING_STATUS: Record<FindingStatus, { label: string; variant: BadgeVariant }> = {
  open: { label: "待处理", variant: "warning" },
  redacted: { label: "已脱敏", variant: "success" },
  removed: { label: "已删除", variant: "success" },
  accepted_public: { label: "已确认可公开", variant: "info" },
  acknowledged: { label: "已知悉", variant: "neutral" },
};

export function findingStatus(status: FindingStatus): { label: string; variant: BadgeVariant } {
  return FINDING_STATUS[status] ?? { label: status, variant: "neutral" };
}

const IMAGE_REASONS: Record<string, string> = {
  recognition_disabled: "未开启图片识别",
  image_limit: "超出单次识别的图片数量上限",
  unreadable: "图片内容无法辨认",
  no_result: "没有识别结果",
};

export function findingNote(kind: string, note: string): string {
  if (kind !== "image_unrecognized") return note;
  return IMAGE_REASONS[note] ?? (note ? `识别失败（${note}）` : "未识别");
}

const SOLUTION_FIELDS: Record<string, string> = {
  display_name: "方案名称",
  description: "方案描述",
  coordinator_instructions: "协作说明",
  output_requirements: "交付要求",
};

const EXPERT_FIELDS: Record<string, string> = {
  display_name: "专家名称",
  category: "分类",
  description: "岗位描述",
  system_prompt: "系统提示词",
};

/** 把后端的字段路径（如 `experts[1].system_prompt`）说成编辑页上能找到的位置；认不出的原样显示。 */
export function findingField(path: string, solution: GeneratedSolution | null): string {
  if (SOLUTION_FIELDS[path]) return SOLUTION_FIELDS[path];
  if (/^tags\[\d+\]$/.test(path)) return "标签";
  const expert = /^experts\[(\d+)\]\.(\w+)$/.exec(path);
  const field = expert ? EXPERT_FIELDS[expert[2] ?? ""] : undefined;
  if (!expert || !field) return path;
  const name = solution?.experts[Number(expert[1])]?.display_name;
  return name ? `专家「${name}」的${field}` : `第 ${Number(expert[1]) + 1} 位专家的${field}`;
}

const SOURCE_WARNINGS: Record<string, string> = {
  text_truncated: "文字过长，超出部分未读取",
  images_truncated: "图片过多，超出部分未读取",
  image_skipped: "有图片无法读取，已跳过",
};

export function sourceWarning(code: string): string {
  return SOURCE_WARNINGS[code] ?? code;
}

const EVENT_ACTIONS: Record<string, string> = {
  created: "新建草稿",
  generation_requested: "发起生成",
  generation_succeeded: "生成完成",
  generation_failed: "生成失败",
  package_edited: "编辑正文",
  finding_redacted: "脱敏处理",
  finding_removed: "删除敏感内容",
  finding_accepted_public: "确认可公开",
  finding_acknowledged: "确认已知悉",
  submitted_for_review: "提交审核",
  approved: "审核通过",
  rejected: "审核驳回",
  publish_started: "开始发布",
  published: "发布到目录",
  archived: "归档",
};

export function eventAction(action: string): string {
  return EVENT_ACTIONS[action] ?? action;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function formatTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
