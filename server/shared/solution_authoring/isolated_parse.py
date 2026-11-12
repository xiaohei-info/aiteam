"""在独立子进程里解析不可信资料：带墙钟超时与资源上限，解析库的死循环 / 内存炸弹不拖垮 API 进程。

- 子进程用 `python -I` 启动，环境变量走白名单（不继承数据库口令、服务 token 等）；
- 输入走 stdin（一行 JSON 头 + 原始字节），输出走 stdout（一行 JSON），不落盘、不用 pickle；
- 子进程内设 CPU 时间与地址空间上限（平台不支持时跳过，墙钟超时仍然生效）；
- 子进程的 stderr 丢弃：可能带文档内容。
解析逻辑本身仍是 `parsing.parse_source`，这里只负责隔离。
"""

from __future__ import annotations

import base64
import contextlib
import dataclasses
import json
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .parsing import ParsedSource, ParseLimits, SourceParseError, parse_source
from .schemas import ImageAsset, SourceChunk

DEFAULT_PARSE_TIMEOUT_SECONDS = 60.0
_MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
_ENV_ALLOWLIST = ("PATH", "LANG", "LC_ALL", "TZ", "TMPDIR")
_SERVER_ROOT = Path(__file__).resolve().parents[2]
_BOOTSTRAP = (
    "import sys; sys.path.insert(0, sys.argv[1]); "
    "from shared.solution_authoring.isolated_parse import _child_main; _child_main()"
)


def parse_source_isolated(
    source_id: str, name: str, data: bytes, limits: ParseLimits | None = None,
    *, timeout_seconds: float = DEFAULT_PARSE_TIMEOUT_SECONDS,
) -> ParsedSource:
    """与 `parse_source` 同签名同语义；子进程超时 / 崩溃 / 输出异常都转成 `SourceParseError`。"""
    limits = limits or ParseLimits()
    cpu_seconds = max(1, round(timeout_seconds)) + 5
    header = json.dumps({"source_id": source_id, "name": name, "limits": dataclasses.asdict(limits),
                         "cpu_seconds": cpu_seconds}, ensure_ascii=False)
    env = {key: os.environ[key] for key in _ENV_ALLOWLIST if os.environ.get(key)}
    try:
        process = subprocess.Popen(  # noqa: S603 — 固定命令，无 shell；资料只走 stdin
            [sys.executable, "-I", "-c", _BOOTSTRAP, str(_SERVER_ROOT)], env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
        )
    except OSError as exc:
        raise SourceParseError("parse_failed", "文件解析进程无法启动") from exc
    try:
        stdout, _ = process.communicate(header.encode("utf-8") + b"\n" + data, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        _kill(process)
        process.communicate()
        raise SourceParseError("parse_timeout", "文件结构过于复杂，解析超时") from exc
    if process.returncode != 0 or not stdout.strip() or len(stdout) > _MAX_OUTPUT_BYTES:
        raise SourceParseError("parse_failed", "文件解析异常中止")
    return _decode(stdout)


def _kill(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (AttributeError, OSError):
        with contextlib.suppress(OSError):
            process.kill()


def _decode(stdout: bytes) -> ParsedSource:
    try:
        output = json.loads(stdout)
        if "error" in output:
            error = output["error"]
            raise SourceParseError(str(error["code"])[:40], str(error["message"])[:200])
        return ParsedSource(
            chunks=[SourceChunk.model_validate(item) for item in output["chunks"]],
            images=[
                ImageAsset(**{**item, "data": base64.b64decode(item["data"], validate=True)}) for item in output["images"]
            ],
            warnings=[str(code) for code in output["warnings"]],
        )
    except SourceParseError:
        raise
    except (ValueError, KeyError, TypeError, ValidationError) as exc:
        raise SourceParseError("parse_failed", "文件解析结果无效") from exc


def _apply_resource_limits(cpu_seconds: int) -> None:
    try:
        import resource
    except ImportError:  # 非 POSIX 平台：只靠宿主的墙钟超时
        return
    for limit, value in ((resource.RLIMIT_CPU, cpu_seconds), (resource.RLIMIT_AS, _MEMORY_LIMIT_BYTES)):
        with contextlib.suppress(ValueError, OSError):  # macOS 不支持 RLIMIT_AS 等情况
            resource.setrlimit(limit, (value, value))


def _encode(parsed: ParsedSource) -> dict[str, Any]:
    return {
        "chunks": [chunk.model_dump(mode="json") for chunk in parsed.chunks],
        "images": [
            {**dataclasses.asdict(image), "data": base64.b64encode(image.data).decode("ascii")} for image in parsed.images
        ],
        "warnings": parsed.warnings,
    }


def _child_main() -> None:
    stream = sys.stdin.buffer
    try:
        header = json.loads(stream.readline())
        cpu_seconds = int(header["cpu_seconds"])
        limits = ParseLimits(**header["limits"])
    except (ValueError, KeyError, TypeError):
        sys.exit(2)  # 宿主按非零退出码记为 parse_failed
    _apply_resource_limits(cpu_seconds)
    data = stream.read()
    try:
        parsed = parse_source(header["source_id"], header["name"], data, limits)
        output: dict[str, Any] = _encode(parsed)
    except SourceParseError as exc:
        output = {"error": {"code": exc.code, "message": str(exc)}}
    sys.stdout.write(json.dumps(output, ensure_ascii=False))
    sys.stdout.flush()
