/** 执行一个任务并把任何结局都收敛成协议里的一条输出。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxScript } from "./faux-script.js";
import { runGenerate } from "./generate.js";
import { createFauxModelHandle, createProviderModelHandle, type ModelHandle } from "./model.js";
import { JobError, PROTOCOL_VERSION, safeMessage, type Job, type WorkerOutput } from "./protocol.js";
import { runRecognize } from "./recognize.js";
import { RunGuard } from "./session.js";

export interface RunOptions {
  /** 是否允许任务使用假模型；由入口根据环境变量决定，默认不允许。 */
  allowFaux?: boolean;
  /** 测试注入：替换模型装配。 */
  createHandle?: (job: Job) => Promise<ModelHandle>;
}

async function defaultHandle(job: Job, allowFaux: boolean): Promise<ModelHandle> {
  if (job.model.kind === "provider") return createProviderModelHandle(job.model);
  if (!allowFaux) throw new JobError("faux_not_allowed", "the faux model is disabled in this environment");
  return createFauxModelHandle(job.model.input, fauxScript(job));
}

export async function runJob(job: Job, options: RunOptions = {}): Promise<WorkerOutput> {
  const guard = new RunGuard(job.budget);
  const secrets = job.model.kind === "provider" ? [job.model.api_key] : [];
  // 每个任务一个空的临时目录作工作目录：Pi 在里面找不到任何项目文件、配置或上下文。
  const workDir = await mkdtemp(join(tmpdir(), "solution-authoring-"));
  try {
    const handle = await (options.createHandle ?? ((current) => defaultHandle(current, options.allowFaux ?? false)))(job);
    guard.start();
    const result = job.mode === "generate"
      ? await runGenerate(job, handle, workDir, guard)
      : await runRecognize(job, handle, workDir, guard);
    return { protocol_version: PROTOCOL_VERSION, status: "succeeded", result, usage: { ...guard.usage } };
  } catch (error) {
    return {
      protocol_version: PROTOCOL_VERSION,
      status: "failed",
      error_code: error instanceof JobError ? error.code : "internal_error",
      error_message: safeMessage(error, secrets),
      usage: { ...guard.usage },
    };
  } finally {
    guard.stop();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
