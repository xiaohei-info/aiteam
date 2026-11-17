"""行业文档生成：共享数据模型（Operator / Manager 两端宿主共用）。

这里的模型是 Python 宿主与 Node Pi worker 之间的协议边界，也是草稿内容的权威 schema；
worker 侧 `server/solution_authoring_worker/src/solution-schema.ts` 与之保持一致。
全部 `extra=forbid`：worker 输出多一个字段也会被拒绝，不落半成品。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .orchestration import OrchestrationRefError, validate_member_refs

PROTOCOL_VERSION = 1

ChunkOrigin = Literal["text", "image"]
RecognizedKind = Literal["text", "table", "chart"]
FindingKind = Literal[
    "phone", "email", "id_card", "bank_card", "secret", "amount", "company", "person", "other",
]
FindingSource = Literal["rule", "agent"]

MAX_EXPERTS = 12
MAX_EVIDENCE_PER_ITEM = 8
MAX_QUOTE_CHARS = 300
_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,39}$")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceChunk(_Strict):
    """一段可被 Agent 引用的来源文本。`locator` 是给人看的位置描述（第几页 / 第几张幻灯片）。"""

    chunk_id: str = Field(min_length=1, max_length=40)
    source_id: str = Field(min_length=1, max_length=40)
    source_name: str = Field(max_length=255)
    locator: str = Field(max_length=120)
    text: str = Field(min_length=1)
    origin: ChunkOrigin = "text"
    low_confidence: bool = False


@dataclass(frozen=True)
class ImageAsset:
    """从资料里抽出的待识别图片（已归一化为 PNG / JPEG，尺寸受限）。不进 JSON schema，字节不落日志。"""

    image_id: str
    source_id: str
    source_name: str
    locator: str
    media_type: str
    data: bytes


class RecognizedBlock(_Strict):
    text: str = Field(min_length=1, max_length=20_000)
    kind: RecognizedKind = "text"
    confidence: float = Field(ge=0.0, le=1.0)


class RecognizedImage(_Strict):
    """一张图片的识别结果；OCR 与多模态两种实现输出同构（设计 §3.8）。"""

    image_id: str
    status: Literal["recognized", "unrecognized"]
    blocks: list[RecognizedBlock] = Field(default_factory=list)
    reason: str = Field(default="", max_length=200)


class Evidence(_Strict):
    chunk_id: str = Field(min_length=1, max_length=40)
    quote: str = Field(default="", max_length=MAX_QUOTE_CHARS)


_MCP_KEY_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
SolutionMode = Literal["solo", "group"]


class ExpertSkillRef(_Strict):
    """专家所需的平台 skill：固定版本引用，只能指向平台目录里已发布的 skill（由宿主校验）。"""

    skill_id: str = Field(min_length=1, max_length=64)
    version: str = Field(min_length=1, max_length=64)
    content_hash: str = Field(min_length=1, max_length=128)
    reason: str = Field(default="", max_length=200, description="为什么需要这个 skill")


class ExpertMcpDecl(_Strict):
    """专家所需的 MCP 连接器声明。只声明，不含地址与凭据；由用户在本机安装。"""

    key: str = Field(max_length=64, description="连接器标识，与用户端连接器 ID 同规则")
    display_name: str = Field(min_length=1, max_length=80)
    purpose: str = Field(default="", max_length=200)
    required: bool = False

    @field_validator("key")
    @classmethod
    def _valid_key(cls, value: str) -> str:
        if not _MCP_KEY_RE.fullmatch(value):
            raise ValueError("key must match ^[a-z][a-z0-9_-]{0,63}$")
        return value


class GeneratedExpert(_Strict):
    """生成的专家。`key` 只在本方案内唯一，发布时才换成目录里的 template_id。"""

    key: str = Field(description="方案内唯一标识：小写字母开头，仅小写字母 / 数字 / 下划线")
    display_name: str = Field(min_length=1, max_length=40)
    category: str = Field(min_length=1, max_length=40)
    description: str = Field(min_length=1, max_length=200)
    system_prompt: str = Field(min_length=1, max_length=8000)
    evidence: list[Evidence] = Field(default_factory=list, max_length=MAX_EVIDENCE_PER_ITEM)
    skills: list[ExpertSkillRef] = Field(default_factory=list, max_length=10)
    mcps: list[ExpertMcpDecl] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def _unique_capabilities(self) -> GeneratedExpert:
        skills = [(item.skill_id, item.version) for item in self.skills]
        if len(set(skills)) != len(skills):
            raise ValueError("duplicate skill in one expert")
        mcps = [item.key for item in self.mcps]
        if len(set(mcps)) != len(mcps):
            raise ValueError("duplicate mcp in one expert")
        return self

    @field_validator("key")
    @classmethod
    def _valid_key(cls, value: str) -> str:
        if not _KEY_RE.fullmatch(value):
            raise ValueError("key must match ^[a-z][a-z0-9_]{1,39}$")
        return value

    @field_validator("display_name", "category", "description", "system_prompt")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value.strip()


class GeneratedSolution(_Strict):
    """草稿内容：专家团队、协调专家、协作说明、交付要求。"""

    display_name: str = Field(min_length=1, max_length=60)
    description: str = Field(min_length=1, max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=8)
    coordinator_key: str
    coordinator_instructions: str = Field(default="", max_length=4000)
    output_requirements: str = Field(default="", max_length=4000)
    experts: list[GeneratedExpert] = Field(min_length=1, max_length=MAX_EXPERTS)
    evidence: list[Evidence] = Field(default_factory=list, max_length=MAX_EVIDENCE_PER_ITEM)
    mode: SolutionMode = Field(description="solo：1 位专家、不建群；group：2 位以上专家，需要群主与编排规则")
    orchestration_rules: str = Field(
        default="", max_length=8000,
        description="群聊编排规则（collaboration-markdown-v1），用 @{专家 key} 引用成员；solo 必须为空",
    )

    @model_validator(mode="before")
    @classmethod
    def _infer_mode(cls, data: object) -> object:
        # 旧草稿没有 mode：按专家数推断，保证已有草稿可读、可编辑。
        if isinstance(data, dict) and "mode" not in data and isinstance(data.get("experts"), list):
            return {**data, "mode": "solo" if len(data["experts"]) == 1 else "group"}
        return data

    @field_validator("display_name", "description")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value.strip()

    @field_validator("tags")
    @classmethod
    def _clean_tags(cls, value: list[str]) -> list[str]:
        cleaned = list(dict.fromkeys(tag.strip() for tag in value if tag.strip()))
        if any(len(tag) > 20 for tag in cleaned):
            raise ValueError("tag must be at most 20 characters")
        return cleaned

    @model_validator(mode="after")
    def _consistent_team(self) -> GeneratedSolution:
        keys = [expert.key for expert in self.experts]
        if len(set(keys)) != len(keys):
            raise ValueError("expert keys must be unique")
        if self.coordinator_key not in keys:
            raise ValueError("coordinator_key must reference one of experts[].key")
        if self.mode == "solo":
            if len(keys) != 1:
                raise ValueError("a solo solution must have exactly one expert")
            if self.orchestration_rules.strip():
                raise ValueError("orchestration_rules must be empty for a solo solution")
        else:
            if len(keys) < 2:
                raise ValueError("a group solution must have at least two experts")
            try:
                validate_member_refs(self.orchestration_rules, frozenset(keys))
            except OrchestrationRefError as exc:
                raise ValueError(str(exc)) from exc
        return self

    def evidence_chunk_ids(self) -> set[str]:
        ids = {item.chunk_id for item in self.evidence}
        for expert in self.experts:
            ids.update(item.chunk_id for item in expert.evidence)
        return ids


class AgentFinding(_Strict):
    """Agent 主动标注的敏感项。`excerpt` 由宿主再做脱敏展示，不直接进日志。"""

    kind: FindingKind
    field_path: str = Field(default="", max_length=120)
    chunk_id: str = Field(default="", max_length=40)
    excerpt: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=200)


class AuthoringUsage(_Strict):
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0)
    turns: int = Field(default=0, ge=0)
    tool_calls: int = Field(default=0, ge=0)


class AuthoringResult(_Strict):
    solution: GeneratedSolution
    findings: list[AgentFinding] = Field(default_factory=list, max_length=200)


class SensitiveMatch(_Strict):
    """规则扫描命中。`excerpt` 是原文片段，只在宿主内部用于定位与替换；对外只展示 `masked`。"""

    kind: FindingKind
    field_path: str
    excerpt: str
    fingerprint: str
    masked: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)
