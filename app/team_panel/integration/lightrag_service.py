"""LightRAG integration service — real document ingestion and retrieval.

Per 业务解决方案设计 §5.2-A / §7.2: AI Team manages knowledge-base objects
(library/document/binding/permission); LightRAG owns chunking, vectorization
and retrieval. This module is the only place that talks to the LightRAG
engine.

Design notes
------------
- One LightRAG instance per knowledge base, working_dir under
  ``app/.state/lightrag/{kb_id}`` (profile-scoped isolation).
- Embeddings: fastembed BAAI/bge-small-zh-v1.5 — real local vectors, no
  external credential required.
- LLM (entity/graph extraction + answer synthesis): optional. When
  ``LIGHTRAG_LLM_API_KEY`` / ``OPENROUTER_API_KEY`` is configured the engine
  runs full graph extraction; without it we degrade gracefully to a pure
  vector index (naive mode retrieval), which is still real semantic search.
- All LightRAG coroutines run on a single dedicated event-loop thread so the
  synchronous Team Panel router can call in from any request thread.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from pathlib import Path

_STATE_ROOT = Path(__file__).resolve().parents[2] / ".state" / "lightrag"

_EMBED_MODEL = os.getenv("LIGHTRAG_EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
_EMBED_DIM = int(os.getenv("LIGHTRAG_EMBED_DIM", "512"))

# ── Singleton event loop thread ──────────────────────────────────────────

_loop: asyncio.AbstractEventLoop | None = None
_loop_lock = threading.Lock()


def _get_loop() -> asyncio.AbstractEventLoop:
    global _loop
    with _loop_lock:
        if _loop is None or _loop.is_closed():
            loop = asyncio.new_event_loop()
            t = threading.Thread(target=loop.run_forever, name="lightrag-loop", daemon=True)
            t.start()
            _loop = loop
        return _loop


def _run(coro):
    """Run a coroutine on the LightRAG loop from a sync caller."""
    return asyncio.run_coroutine_threadsafe(coro, _get_loop()).result()


# ── Embedding (lazy fastembed singleton) ─────────────────────────────────

_embedder = None
_embedder_lock = threading.Lock()


def _get_embedder():
    global _embedder
    with _embedder_lock:
        if _embedder is None:
            from fastembed import TextEmbedding
            _embedder = TextEmbedding(_EMBED_MODEL)
        return _embedder


async def _embed_func(texts: list[str]):
    import numpy as np
    em = _get_embedder()
    return np.array(list(em.embed(texts)))


# ── LLM func (optional, credential-gated) ────────────────────────────────

def _llm_credentials() -> tuple[str, str, str] | None:
    """Return (api_key, base_url, model) when an LLM is configured."""
    api_key = os.getenv("LIGHTRAG_LLM_API_KEY") or os.getenv("OPENROUTER_API_KEY") or ""
    if not api_key.strip():
        return None
    base_url = os.getenv("LIGHTRAG_LLM_BASE_URL", "https://openrouter.ai/api/v1")
    model = os.getenv("LIGHTRAG_LLM_MODEL", "openai/gpt-4o-mini")
    return api_key.strip(), base_url, model


def _build_llm_func():
    creds = _llm_credentials()
    if creds is None:
        async def _noop_llm(prompt, system_prompt=None, history_messages=None, **kw):
            # No credential: skip graph extraction; vector index stays real.
            return ""
        return _noop_llm

    api_key, base_url, model = creds

    async def _openai_llm(prompt, system_prompt=None, history_messages=None, **kw):
        from lightrag.llm.openai import openai_complete_if_cache
        return await openai_complete_if_cache(
            model, prompt,
            system_prompt=system_prompt,
            history_messages=history_messages or [],
            api_key=api_key, base_url=base_url,
        )
    return _openai_llm


def llm_available() -> bool:
    return _llm_credentials() is not None


# ── Per-KB instance registry ─────────────────────────────────────────────

_instances: dict[str, object] = {}
_instances_lock = threading.Lock()
_pipeline_ready = False


async def _create_instance(kb_id: str):
    from lightrag import LightRAG
    from lightrag.utils import EmbeddingFunc
    from lightrag.kg.shared_storage import initialize_pipeline_status

    working_dir = _STATE_ROOT / kb_id
    working_dir.mkdir(parents=True, exist_ok=True)
    rag = LightRAG(
        working_dir=str(working_dir),
        llm_model_func=_build_llm_func(),
        embedding_func=EmbeddingFunc(
            embedding_dim=_EMBED_DIM, max_token_size=512, func=_embed_func,
        ),
    )
    await rag.initialize_storages()
    global _pipeline_ready
    if not _pipeline_ready:
        await initialize_pipeline_status()
        _pipeline_ready = True
    return rag


def _get_instance(kb_id: str):
    with _instances_lock:
        rag = _instances.get(kb_id)
    if rag is None:
        rag = _run(_create_instance(kb_id))
        with _instances_lock:
            _instances[kb_id] = rag
    return rag


# ── Public API ───────────────────────────────────────────────────────────

def ingest_document(kb_id: str, rag_document_id: str, text: str,
                    file_name: str = "") -> int:
    """Chunk + embed (+ extract when LLM available) a document.

    Returns the real chunk count stored in the vector index.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("document text is empty")
    rag = _get_instance(kb_id)
    _run(rag.ainsert(text, ids=[rag_document_id], file_paths=[file_name or rag_document_id]))
    return _count_chunks(kb_id, rag_document_id)


def _count_chunks(kb_id: str, rag_document_id: str) -> int:
    chunks_file = _STATE_ROOT / kb_id / "kv_store_text_chunks.json"
    if not chunks_file.exists():
        return 0
    try:
        data = json.loads(chunks_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    return sum(
        1 for v in data.values()
        if isinstance(v, dict) and v.get("full_doc_id") == rag_document_id
    )


def query(kb_id: str, question: str, top_k: int = 5) -> dict:
    """Real semantic retrieval over the KB's vector index.

    Returns {"chunks": [{"content", "doc_id", "file_name"}...], "answer": str}.
    ``answer`` is LLM-synthesized when credentials exist; otherwise empty —
    callers (digital employees / search endpoint) compose their own answer
    from the retrieved chunks, which matches the design split: LightRAG
    retrieves, the employee LLM answers.
    """
    from lightrag import QueryParam

    rag = _get_instance(kb_id)
    chunks = _retrieve_chunks(kb_id, rag, question, top_k)
    answer = ""
    if llm_available():
        answer = _run(rag.aquery(
            question, param=QueryParam(mode="naive", top_k=top_k),
        )) or ""
    return {"chunks": chunks, "answer": str(answer)}


def _retrieve_chunks(kb_id: str, rag, question: str, top_k: int) -> list[dict]:
    """Vector search against the chunks index; independent of LLM."""
    async def _search():
        results = await rag.chunks_vdb.query(question, top_k=top_k)
        return results or []

    raw = _run(_search())
    chunks: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        chunks.append({
            "content": str(item.get("content") or "")[:600],
            "doc_id": str(item.get("full_doc_id") or ""),
            "file_name": str(item.get("file_path") or ""),
            "score": float(item.get("distance") or item.get("score") or 0.0),
        })
    return chunks


def delete_kb_index(kb_id: str) -> None:
    """Drop the in-memory instance (storage dir left for ops to clean)."""
    with _instances_lock:
        _instances.pop(kb_id, None)
