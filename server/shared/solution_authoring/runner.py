"""Pi worker 调用器：为每个任务起一个 Node 子进程（设计 D-T）。

宿主把任务与模型配置经 stdin 交给 `server/solution_authoring_worker`，从 stdout 读回一行 JSON。
- 模型密钥只走 stdin：不进命令行参数、不进环境变量、不落盘。
- 子进程环境是白名单：宿主自己的数据库口令、服务 token 等一律不继承。
- 子进程的 stderr 直接丢弃：它可能带文档内容，不进宿主日志。启动类故障由 `default_worker_command`
  的预检给出明确原因。
- 墙钟超时、stdout 体积上限由宿主强制执行；worker 自己的预算守卫先于宿主超时触发。
"""

from __future__ import annotations

import base64
import contextlib
import json
import os
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError

from .schemas import (
    PROTOCOL_VERSION,
    AuthoringResult,
    AuthoringUsage,
    ImageAsset,
    RecognizedImage,
    SourceChunk,
)

ApiProtocol = Literal["openai-completions", "openai-responses", "anthropic-messages"]
InputMode = Literal["text", "image"]

# worker 自己报告的失败码（与 solution_authoring_worker/src/protocol.ts 的 ErrorCode 一致）。
WORKER_ERROR_CODES = frozenset({
    "invalid_job", "faux_not_allowed", "vision_unsupported", "budget_exceeded", "timeout",
    "model_error", "no_submission", "schema_invalid", "internal_error",
})
# 宿主侧判定的失败码。
HOST_ERROR_CODES = frozenset({
    "worker_unavailable", "worker_timeout", "worker_output_too_large", "worker_crashed", "worker_protocol_error",
})

_ENV_ALLOWLIST = ("PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE")
_HOST_GRACE_SECONDS = 20.0
_MAX_MESSAGE_CHARS = 300
_ABORT_POLL_SECONDS = 0.25


class WorkerError(Exception):
    """一次 worker 调用失败。`code` 稳定可枚举；`message` 不含密钥与文档内容。"""

    def __init__(self, code: str, message: str, usage: AuthoringUsage | None = None):
        super().__init__(message)
        self.code = code
        self.usage = usage or AuthoringUsage()


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProviderModelConfig(_Strict):
    """宿主解析并注入的模型配置。`api_key` 是 SecretStr：打印、日志、序列化默认都是掩码。"""

    kind: Literal["provider"] = "provider"
    base_url: str = Field(min_length=1, max_length=2000)
    api_protocol: ApiProtocol
    model_id: str = Field(min_length=1, max_length=200)
    api_key: SecretStr
    provider_ref: str = Field(min_length=1, max_length=200)
    input: list[InputMode] = Field(default_factory=lambda: ["text"], min_length=1, max_length=2)
    reasoning: bool = False
    thinking_level: Literal["off", "minimal", "low", "medium", "high"] = "off"
    context_window: int | None = Field(default=None, ge=1)
    max_tokens: int | None = Field(default=None, ge=1)

    @property
    def supports_images(self) -> bool:
        return "image" in self.input

    def to_job(self) -> dict[str, Any]:
        job = self.model_dump(mode="json", exclude={"api_key"}, exclude_none=True)
        job["api_key"] = self.api_key.get_secret_value()
        return job

    def secrets(self) -> list[str]:
        return [self.api_key.get_secret_value()]


class FauxModelConfig(_Strict):
    """脚本化假模型：自动化测试与本机联调用。只有 runner 显式 `allow_faux=True` 时 worker 才接受。"""

    kind: Literal["faux"] = "faux"
    input: list[InputMode] = Field(default_factory=lambda: ["text"], min_length=1, max_length=2)

    @property
    def supports_images(self) -> bool:
        return "image" in self.input

    def to_job(self) -> dict[str, Any]:
        return self.model_dump(mode="json")

    def secrets(self) -> list[str]:
        return []


ModelConfig = ProviderModelConfig | FauxModelConfig


class AuthoringBudget(_Strict):
    max_turns: int = Field(default=60, ge=1, le=500)
    max_tool_calls: int = Field(default=300, ge=1, le=2000)
    max_total_tokens: int = Field(default=2_000_000, ge=1, le=100_000_000)
    timeout_ms: int = Field(default=900_000, ge=1, le=3_600_000)
    max_submit_attempts: int = Field(default=4, ge=1, le=20)
    # 模型临时错误（限流、5xx、网络中断）由 worker 内的 Pi 会话按指数退避重试；额度 / 计费类错误不重试。
    # 每次重试是新的一轮，仍计入轮数 / token / 超时预算。
    model_retries: int = Field(default=3, ge=0, le=5)
    retry_base_delay_ms: int = Field(default=2000, ge=0, le=60_000)


@dataclass(frozen=True)
class GenerateOutcome:
    result: AuthoringResult
    usage: AuthoringUsage


@dataclass(frozen=True)
class RecognizeOutcome:
    images: list[RecognizedImage]
    usage: AuthoringUsage


def default_worker_command() -> tuple[list[str], Path]:
    """定位 Node 与 worker 入口；缺什么就明确报什么。"""
    configured = os.getenv("SOLUTION_AUTHORING_WORKER_DIR")
    root = Path(configured) if configured else Path(__file__).resolve().parents[2] / "solution_authoring_worker"
    node = os.getenv("SOLUTION_AUTHORING_NODE") or shutil.which("node")
    if not node:
        raise WorkerError("worker_unavailable", "node executable not found (set SOLUTION_AUTHORING_NODE)")
    entry = root / "src" / "main.ts"
    if not entry.is_file():
        raise WorkerError("worker_unavailable", "authoring worker entry not found (set SOLUTION_AUTHORING_WORKER_DIR)")
    if not (root / "node_modules" / "tsx").is_dir():
        raise WorkerError("worker_unavailable", "authoring worker dependencies are not installed (run pnpm install in the worker directory)")
    return [node, "--import", "tsx", str(entry)], root


def _kill(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (AttributeError, OSError):  # 进程组已不存在，或平台没有 killpg
        with contextlib.suppress(OSError):
            process.kill()


def _safe(message: object, secrets: Sequence[str]) -> str:
    text = str(message)
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[redacted]")
    return " ".join(text.split())[:_MAX_MESSAGE_CHARS]


class PiWorkerRunner:
    """同步调用器：一次调用一个子进程。宿主的任务 worker 在线程里调用它。"""

    def __init__(
        self,
        command: Sequence[str] | None = None,
        *,
        cwd: str | Path | None = None,
        allow_faux: bool = False,
        max_stdout_bytes: int = 32 * 1024 * 1024,
        host_grace_seconds: float = _HOST_GRACE_SECONDS,
    ):
        self._command = list(command) if command is not None else None
        self._cwd = Path(cwd) if cwd is not None else None
        self._allow_faux = allow_faux
        self._max_stdout_bytes = max_stdout_bytes
        self._host_grace_seconds = host_grace_seconds
        self._active: set[subprocess.Popen[bytes]] = set()
        self._active_lock = threading.Lock()
        self._closed = False

    def close(self) -> None:
        """宿主关停：杀掉仍在运行的 worker 子进程，之后的调用直接失败。对应的调用会以 worker_crashed 结束。"""
        with self._active_lock:
            self._closed = True
            running = list(self._active)
        for process in running:
            _kill(process)

    # ---- 对外：两种任务 ----

    def generate(
        self,
        chunks: Sequence[SourceChunk],
        *,
        model: ModelConfig,
        budget: AuthoringBudget,
        system_prompt: str,
        task_prompt: str,
        abort: threading.Event | None = None,
    ) -> GenerateOutcome:
        job = self._job("generate", model, budget, system_prompt, task_prompt)
        job["chunks"] = [chunk.model_dump(mode="json") for chunk in chunks]
        result, usage = self._run(job, model, budget, abort)
        try:
            parsed = AuthoringResult.model_validate(result)
        except ValidationError as exc:
            raise WorkerError("worker_protocol_error", f"worker result failed host validation ({exc.error_count()} errors)", usage) from exc
        unknown = parsed.solution.evidence_chunk_ids() - {chunk.chunk_id for chunk in chunks}
        if unknown:
            raise WorkerError("worker_protocol_error", "worker result cites chunks that were not part of the job", usage)
        return GenerateOutcome(result=parsed, usage=usage)

    def recognize(
        self,
        images: Sequence[ImageAsset],
        *,
        model: ModelConfig,
        budget: AuthoringBudget,
        system_prompt: str,
        task_prompt: str,
        abort: threading.Event | None = None,
    ) -> RecognizeOutcome:
        job = self._job("recognize", model, budget, system_prompt, task_prompt)
        job["images"] = [
            {
                "image_id": image.image_id, "source_name": image.source_name[:255], "locator": image.locator[:120],
                "media_type": image.media_type, "data_base64": base64.b64encode(image.data).decode("ascii"),
            }
            for image in images
        ]
        result, usage = self._run(job, model, budget, abort)
        try:
            recognized = [RecognizedImage.model_validate(item) for item in result.get("images", [])]
        except (ValidationError, AttributeError, TypeError) as exc:
            raise WorkerError("worker_protocol_error", "worker recognition result failed host validation", usage) from exc
        if [item.image_id for item in recognized] != [image.image_id for image in images]:
            raise WorkerError("worker_protocol_error", "worker recognition result does not match the requested images", usage)
        return RecognizeOutcome(images=recognized, usage=usage)

    # ---- 内部 ----

    @staticmethod
    def _job(mode: str, model: ModelConfig, budget: AuthoringBudget, system_prompt: str, task_prompt: str) -> dict[str, Any]:
        return {
            "protocol_version": PROTOCOL_VERSION, "mode": mode, "model": model.to_job(),
            "budget": budget.model_dump(mode="json"), "system_prompt": system_prompt, "task_prompt": task_prompt,
        }

    def _environment(self) -> dict[str, str]:
        env = {name: os.environ[name] for name in _ENV_ALLOWLIST if os.environ.get(name)}
        if self._allow_faux:
            env["SOLUTION_AUTHORING_ALLOW_FAUX"] = "1"
        return env

    def _run(
        self, job: dict[str, Any], model: ModelConfig, budget: AuthoringBudget, abort: threading.Event | None = None,
    ) -> tuple[dict[str, Any], AuthoringUsage]:
        secrets = model.secrets()
        raw = self._execute(
            json.dumps(job, ensure_ascii=False).encode("utf-8"), budget.timeout_ms / 1000 + self._host_grace_seconds, abort,
        )
        lines = [line for line in raw.decode("utf-8", errors="replace").splitlines() if line.strip()]
        try:
            if len(lines) != 1:
                raise ValueError("expected exactly one output line")
            output = json.loads(lines[0])
            if not isinstance(output, dict) or output.get("protocol_version") != PROTOCOL_VERSION:
                raise ValueError("unexpected protocol version")
            usage = AuthoringUsage.model_validate(output.get("usage") or {})
            status = output.get("status")
            if status == "succeeded" and isinstance(output.get("result"), dict):
                return output["result"], usage
            if status != "failed":
                raise ValueError("unexpected status")
        except (ValueError, ValidationError) as exc:
            raise WorkerError("worker_protocol_error", "authoring worker returned malformed output") from exc
        code = output.get("error_code")
        raise WorkerError(
            code if code in WORKER_ERROR_CODES else "internal_error",
            _safe(output.get("error_message") or "authoring worker failed", secrets),
            usage,
        )

    def _execute(self, payload: bytes, timeout_seconds: float, abort: threading.Event | None = None) -> bytes:
        if self._command is None:
            command, cwd = default_worker_command()
        else:
            command, cwd = self._command, self._cwd
        with self._active_lock:
            if self._closed:
                raise WorkerError("worker_unavailable", "the authoring worker host is shutting down")
            if abort is not None and abort.is_set():
                raise WorkerError("worker_crashed", "the job was aborted before the authoring worker started")
            try:
                process = subprocess.Popen(  # noqa: S603 — 固定命令，无 shell；任务内容只走 stdin
                    command, cwd=cwd, env=self._environment(),
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError as exc:
                raise WorkerError("worker_unavailable", "failed to start the authoring worker") from exc
            self._active.add(process)
        try:
            return self._collect(process, payload, timeout_seconds, abort)
        finally:
            with self._active_lock:
                self._active.discard(process)

    def _collect(
        self, process: subprocess.Popen[bytes], payload: bytes, timeout_seconds: float, abort: threading.Event | None = None,
    ) -> bytes:
        stdin, out = process.stdin, process.stdout
        if stdin is None or out is None:
            _kill(process)
            raise WorkerError("worker_unavailable", "failed to open pipes to the authoring worker")
        stdout = bytearray()
        overflow = threading.Event()

        def feed() -> None:
            # 子进程提前退出时写入会失败：由退出码与输出判定失败，这里不必再报。
            with contextlib.suppress(OSError):
                stdin.write(payload)
            with contextlib.suppress(OSError):
                stdin.close()

        def drain() -> None:
            while True:
                part = out.read(65536)
                if not part:
                    return
                if len(stdout) + len(part) > self._max_stdout_bytes:
                    overflow.set()
                    _kill(process)
                    return
                stdout.extend(part)

        threads = [threading.Thread(target=feed, daemon=True), threading.Thread(target=drain, daemon=True)]
        for thread in threads:
            thread.start()
        timed_out = aborted = False
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                process.wait(timeout=max(0.0, min(_ABORT_POLL_SECONDS, deadline - time.monotonic())))
                break
            except subprocess.TimeoutExpired:
                pass
            if abort is not None and abort.is_set():
                aborted = True
            elif time.monotonic() >= deadline:
                timed_out = True
            else:
                continue
            _kill(process)
            process.wait()
            break
        for thread in threads:
            thread.join(timeout=5)
        out.close()

        if aborted:
            raise WorkerError("worker_crashed", "the job was aborted and the authoring worker was stopped")
        if overflow.is_set():
            raise WorkerError("worker_output_too_large", "authoring worker output exceeded the size limit")
        if timed_out:
            raise WorkerError("worker_timeout", "authoring worker did not finish within the time limit")
        if process.returncode != 0 or not stdout.strip():
            raise WorkerError("worker_crashed", f"authoring worker exited with code {process.returncode} without a result")
        return bytes(stdout)
