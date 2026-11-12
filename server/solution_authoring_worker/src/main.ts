/**
 * 进程入口：stdin 读一个任务 → 执行 → stdout 写一行 JSON 结果 → 退出。
 *
 * stdout 只留给最终结果：其它输出一律改道 stderr，且 stderr 不写任务内容（含密钥与文档正文）。
 * 退出码：0 = 已输出一条合法结果（成功或失败都算）；1 = 连结果都没能输出。
 */
import { EMPTY_USAGE, JobError, PROTOCOL_VERSION, parseJob, safeMessage, type WorkerOutput } from "./protocol.js";
import { runJob } from "./run.js";

const MAX_STDIN_BYTES = 256 * 1024 * 1024;

for (const method of ["log", "info", "debug", "warn"] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of process.stdin) {
    size += part.length;
    if (size > MAX_STDIN_BYTES) throw new JobError("invalid_job", "job exceeds the input size limit");
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

function failed(error: unknown): WorkerOutput {
  return {
    protocol_version: PROTOCOL_VERSION,
    status: "failed",
    error_code: error instanceof JobError ? error.code : "internal_error",
    error_message: safeMessage(error),
    usage: { ...EMPTY_USAGE },
  };
}

async function main(): Promise<WorkerOutput> {
  try {
    const job = parseJob(await readStdin());
    return await runJob(job, { allowFaux: process.env.SOLUTION_AUTHORING_ALLOW_FAUX === "1" });
  } catch (error) {
    return failed(error);
  }
}

main().then(
  (output) => process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0)),
  () => process.exit(1),
);
