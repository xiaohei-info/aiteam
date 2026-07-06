"""provider_ref → runtime env 解析器（M4，04 §6.7，D18）。

输入：RunSpec.provider_ref（中立引用，不含明文凭据）。
输出：当前 runtime 需要的一组 env 变量（名/值），值从宿主 os.environ 读取。

铁律（D18）：
- 明文凭据只从宿主 env 读取，绝不写运行时 profile / DB / 日志 / 前端可见配置。
- provider_ref 未知 → ProviderResolutionError（fail fast，禁止回退未知 provider）。
- provider_ref 已知但所需 env var 缺失 → ProviderResolutionError（明确报错，不回退）。
- provider_ref 为空 → 返回空 dict（runtime 用自身默认，不注入）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping


class ProviderResolutionError(Exception):
    """provider_ref 解析失败：未知引用或所需凭据缺失。"""


@dataclass(frozen=True)
class ProviderProfile:
    """单个 provider 的解析配置：所需 env var 名 + 可选 endpoint var。

    env_vars 支持两种形态：
    - tuple[str, ...]：列出的**每一个** env var 都必须存在（AND 语义）。
    - tuple[tuple[str, ...], ...]：每组是"任一即可"（OR 语义），组间仍是 AND。
      例如 (("GOOGLE_API_KEY", "GEMINI_API_KEY"),) 表示两个 key 任一存在即满足。
    """

    env_vars: tuple = ()
    endpoint_var: str | None = None


def _normalize_clauses(env_vars: tuple) -> tuple[tuple[str, ...], ...]:
    """把 env_vars 归一化为 tuple[tuple[str, ...], ...]（每组 OR，组间 AND）。"""
    if not env_vars:
        return ()
    first = env_vars[0]
    if isinstance(first, str):
        return (tuple(env_vars),)
    return tuple(tuple(group) for group in env_vars)


# 已知 provider 注册表（provider_ref → 所需 env var 名）。
# 值从宿主 os.environ 读取；缺失则 fail fast。
# google 用 OR 语义：GOOGLE_API_KEY / GEMINI_API_KEY 任一存在即满足。
PROVIDER_REGISTRY: Mapping[str, ProviderProfile] = {
    "openai": ProviderProfile(env_vars=("OPENAI_API_KEY",)),
    "anthropic": ProviderProfile(env_vars=("ANTHROPIC_API_KEY",)),
    "google": ProviderProfile(env_vars=(("GOOGLE_API_KEY", "GEMINI_API_KEY"),)),
    "ai-relay": ProviderProfile(
        env_vars=("AI_RELAY_TOKEN",), endpoint_var="AI_RELAY_ENDPOINT",
    ),
}


def resolve_provider_env(provider_ref: str | None) -> dict[str, str]:
    """解析 provider_ref → 需要注入的 env 变量（名/值）。

    值从宿主 os.environ 读取；绝不写运行时 profile/DB/日志。
    失败策略：未知引用或所需 env var 缺失 → ProviderResolutionError。
    """
    if not provider_ref:
        return {}
    profile = PROVIDER_REGISTRY.get(provider_ref)
    if profile is None:
        raise ProviderResolutionError(
            f"unknown provider_ref={provider_ref!r}; known: {sorted(PROVIDER_REGISTRY)}"
        )
    env: dict[str, str] = {}
    clauses = _normalize_clauses(profile.env_vars)
    missing_groups: list[tuple[str, ...]] = []
    for group in clauses:
        matched = _resolve_group(group)
        if matched is None:
            missing_groups.append(group)
        else:
            env.update(matched)
    if missing_groups:
        raise ProviderResolutionError(
            f"provider_ref={provider_ref!r} missing env for groups {missing_groups}"
        )
    if profile.endpoint_var and profile.endpoint_var in os.environ:
        env[profile.endpoint_var] = os.environ[profile.endpoint_var]
    return env


def _resolve_group(group: tuple[str, ...]) -> dict[str, str] | None:
    """OR 语义：组内任一 env var 存在即返回其 dict；全缺返回 None。"""
    for name in group:
        value = os.environ.get(name)
        if value:
            return {name: value}
    return None

def is_provider_configured(provider_ref: str | None) -> bool:
    """健康检查：provider_ref 是否已配置（不抛异常）。"""
    try:
        resolve_provider_env(provider_ref)
        return True
    except ProviderResolutionError:
        return False
