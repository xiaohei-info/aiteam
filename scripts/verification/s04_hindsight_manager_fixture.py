"""Isolated native HTTP/pg0 fixture for the S04 Manager integration gate.

Run only in the approved image with --network none. The sole host-writable mount
is an empty managed temporary socket directory. No enterprise or credential data.
"""
import asyncio

import uvicorn
from hindsight_api.api import create_app
from hindsight_api.engine.memory_engine import MemoryEngine
from hindsight_api.engine.embeddings import Embeddings
from hindsight_api.engine.cross_encoder import CrossEncoderModel
from hindsight_api.engine.query_analyzer import DateparserQueryAnalyzer
from hindsight_api.engine.task_backend import SyncTaskBackend


class FixtureEmbeddings(Embeddings):
    provider_name = "fixture"
    dimension = 8

    async def initialize(self):
        pass

    def encode(self, texts):
        return [[1.0] + [0.0] * 7 for _ in texts]


class FixtureReranker(CrossEncoderModel):
    provider_name = "fixture"

    async def initialize(self):
        pass

    async def predict(self, pairs):
        return [1.0 for _ in pairs]


async def main():
    memory = MemoryEngine(
        db_url="pg0://s04-manager-fixture", memory_llm_provider="mock", memory_llm_model="mock",
        memory_llm_api_key="", embeddings=FixtureEmbeddings(), cross_encoder=FixtureReranker(),
        query_analyzer=DateparserQueryAnalyzer(), pool_min_size=1, pool_max_size=8,
        task_backend=SyncTaskBackend(), skip_llm_verification=True,
    )
    await memory.initialize()
    try:
        app = create_app(memory, initialize_memory=False)
        # Only this synthetic fixture socket is exposed; there is no TCP listener.
        server = uvicorn.Server(uvicorn.Config(app, uds="/fixture/native.sock", log_level="warning", access_log=False))
        await server.serve()
    finally:
        await memory.close()


if __name__ == "__main__":
    asyncio.run(main())
