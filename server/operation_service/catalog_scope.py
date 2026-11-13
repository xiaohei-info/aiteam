"""目录发布范围（visible_scope）：结构化模型与匹配规则。

- `{"mode": "all"}`：全部企业可见。
- `{"mode": "limited", "industries": [...], "tags": [...]}`：企业的行业命中 **或** 任一标签命中即可见。
- 旧的空值 / 自由 JSON 一律按“全部可见”处理（迁移 0021 同步把存量改成结构化形态）。
"""

from __future__ import annotations

from typing import Any, Iterable, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_SCOPE_ITEMS = 10
MAX_ITEM_LENGTH = 20


def _clean(values: Iterable[str]) -> list[str]:
    seen: list[str] = []
    for value in values:
        text = value.strip()
        if not text:
            continue
        if len(text) > MAX_ITEM_LENGTH:
            raise ValueError(f"单项不超过 {MAX_ITEM_LENGTH} 字")
        if text not in seen:
            seen.append(text)
    if len(seen) > MAX_SCOPE_ITEMS:
        raise ValueError(f"最多 {MAX_SCOPE_ITEMS} 项")
    return seen


class VisibleScope(BaseModel):
    """发布范围（北向请求 / 落库形态）。"""

    model_config = ConfigDict(extra="forbid")

    mode: Literal["all", "limited"] = "all"
    industries: list[str] = Field(default_factory=list, description="命中任一行业即可见（仅 limited）")
    tags: list[str] = Field(default_factory=list, description="命中任一标签即可见（仅 limited）")

    @field_validator("industries", "tags")
    @classmethod
    def _normalize(cls, value: list[str]) -> list[str]:
        return _clean(value)

    @model_validator(mode="after")
    def _check_mode(self) -> "VisibleScope":
        if self.mode == "all":
            self.industries, self.tags = [], []
        elif not self.industries and not self.tags:
            raise ValueError("指定范围时行业与标签至少填一项")
        return self


ALL_SCOPE: dict[str, Any] = {"mode": "all"}


def normalize_scope(raw: Any) -> VisibleScope:
    """读取存量 / 外部值：不合法或无 mode 的一律视为全部可见。"""
    if not isinstance(raw, dict) or "mode" not in raw:
        return VisibleScope()
    try:
        return VisibleScope.model_validate(raw)
    except ValueError:
        return VisibleScope()


def scope_allows(raw: Any, *, industry: str | None, tags: Iterable[str]) -> bool:
    scope = normalize_scope(raw)
    if scope.mode == "all":
        return True
    if industry and industry in scope.industries:
        return True
    return bool(set(tags) & set(scope.tags))
