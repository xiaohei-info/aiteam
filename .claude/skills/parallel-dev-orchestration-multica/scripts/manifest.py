# manifest.py
from dataclasses import dataclass, field
import yaml

@dataclass
class Node:
    id: str
    worker: str
    blocked_by: list = field(default_factory=list)
    title: str | None = None
    description: str | None = None
    reviewer: str | None = None
    risk: str | None = None
    gate: dict | None = None

@dataclass
class Manifest:
    meta: dict
    nodes: dict  # id -> Node

def load_manifest(path: str) -> Manifest:
    with open(path) as f:
        raw = yaml.safe_load(f)
    nodes = {}
    for n in raw.get("nodes", []):
        if "id" not in n:
            raise ValueError("node missing 'id'")
        if not n.get("worker"):
            raise ValueError(f"node {n['id']} missing required 'worker'")
        nodes[n["id"]] = Node(
            id=n["id"],
            worker=n["worker"],
            blocked_by=list(n.get("blocked_by", [])),
            title=n.get("title"),
            description=n.get("description"),
            reviewer=n.get("reviewer"),
            risk=n.get("risk"),
            gate=n.get("gate"),
        )
    return Manifest(meta=raw.get("meta", {}), nodes=nodes)
