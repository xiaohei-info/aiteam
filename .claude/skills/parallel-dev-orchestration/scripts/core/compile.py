# compile.py
from .manifest import Manifest
from clients import MulticaClient

def compile_manifest(m: Manifest, client: MulticaClient):
    """单向编译：manifest 节点的 blocked_by/worker/旋钮 → issue metadata。"""
    for node in m.nodes.values():
        client.set_metadata(node.id, "blocked_by", list(node.blocked_by))
        client.set_metadata(node.id, "worker", node.worker)
        if node.reviewer is not None:
            client.set_metadata(node.id, "reviewer", node.reviewer)
        if node.risk is not None:
            client.set_metadata(node.id, "risk", node.risk)
