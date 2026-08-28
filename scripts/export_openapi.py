#!/usr/bin/env python3
"""Export the two FastAPI OpenAPI documents without starting a server."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("OPERATION_SYSTEM_USERNAME", "sysadmin")
    os.environ.setdefault("OPERATION_SYSTEM_PASSWORD", "changeme-me")
    os.environ.setdefault("OPERATOR_URL", "http://operator.invalid")
    os.environ.setdefault("AITEAM_ENV", "test")

    from operation_service.app import app as operation_app
    from manager_service.app import app as manager_app

    for name, app in (("operation", operation_app), ("manager", manager_app)):
        path = args.output_dir / f"{name}.json"
        path.write_text(json.dumps(app.openapi(), ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{name} OpenAPI written to {path}")


if __name__ == "__main__":
    main()
