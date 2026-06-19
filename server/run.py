"""统一启动器（09 §14.2，D15）。

dev 便利：`python server/run.py --tier=operation|manager|agent`（或 APP_TIER 环境变量），
只挂载该端的 app。**仅供 dev 与按端构建入口选择**；生产按端产出三个精简产物，
不做"运行时胖产物 / 一个产物切端"（D15）。

用法:
    python run.py --tier agent
    APP_TIER=manager python run.py
"""

from __future__ import annotations

import argparse
import importlib

from fastapi import FastAPI

_TIER_MODULES = {
    "operation": "operation_service.app",
    "manager": "manager_service.app",
    "agent": "agent_service.app",
}


def get_app(tier: str) -> FastAPI:
    """按 tier 取该端 FastAPI app（供启动与测试复用）。"""
    if tier not in _TIER_MODULES:
        raise ValueError(f"无效 tier={tier!r}，应为 {tuple(_TIER_MODULES)} 之一")
    module = importlib.import_module(_TIER_MODULES[tier])
    return module.app


def main() -> None:
    import os

    parser = argparse.ArgumentParser(description="AI Team v1 统一启动器")
    parser.add_argument("--tier", default=os.getenv("APP_TIER"), choices=list(_TIER_MODULES))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not args.tier:
        parser.error("必须指定 --tier 或设置 APP_TIER")

    import uvicorn

    uvicorn.run(_TIER_MODULES[args.tier] + ":app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
