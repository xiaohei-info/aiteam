"""Disposable, network-isolated proof against the approved Hindsight OCI image.

Only models are deterministic doubles. Native HTTP routes, PostgreSQL migrations,
recall SQL, curation and observation pruning run unchanged. No real bank is used.
"""
import asyncio
import json
import uuid

import httpx
from hindsight_api import RequestContext
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
        return None

    def encode(self, texts):
        return [[1.0] + [0.0] * 7 for _ in texts]


class FixtureReranker(CrossEncoderModel):
    provider_name = "fixture"

    async def initialize(self):
        return None

    async def predict(self, pairs):
        return [1.0 for _ in pairs]


async def main():
    memory = MemoryEngine(
        db_url="pg0://s04-native-fixture", memory_llm_provider="mock", memory_llm_model="mock",
        memory_llm_api_key="", embeddings=FixtureEmbeddings(), cross_encoder=FixtureReranker(),
        query_analyzer=DateparserQueryAnalyzer(), pool_min_size=1, pool_max_size=8,
        task_backend=SyncTaskBackend(), skip_llm_verification=True,
    )
    await memory.initialize()
    try:
        banks = ["s04-synthetic-main", "s04-synthetic-other"]
        for bank in banks:
            await memory.get_bank_profile(bank_id=bank, request_context=RequestContext())
        pool = await memory._get_pool()
        expired, fresh, other, observation, entity = [uuid.uuid4() for _ in range(5)]
        metadata = {"aiteam_acceptance": "fixture-generation", "aiteam_accepted_at": "2026-01-01T00:00:00Z"}
        async with pool.acquire() as conn:
            await conn.execute("INSERT INTO documents(id,bank_id,original_text) VALUES('shared-document',$1,'EXPIRED_MARKER FRESH_MARKER')", banks[0])
            await conn.execute("INSERT INTO chunks(chunk_id,document_id,bank_id,chunk_index,chunk_text) VALUES('shared-chunk','shared-document',$1,0,'EXPIRED_MARKER FRESH_MARKER')", banks[0])
            for mid, bank, text in [(expired,banks[0],"EXPIRED_MARKER fixture fact"), (fresh,banks[0],"FRESH_MARKER fixture fact"), (other,banks[1],"OTHER_MARKER fixture fact")]:
                await conn.execute(
                    "INSERT INTO memory_units(id,bank_id,text,fact_type,embedding,event_date,metadata,document_id,chunk_id,consolidated_at) "
                    "VALUES($1,$2,$3,'world',$4::vector,now(),$5::jsonb,$6,$7,now())",
                    mid, bank, text, str([1.0]+[0.0]*7), json.dumps(metadata),
                    "shared-document" if bank==banks[0] else None, "shared-chunk" if bank==banks[0] else None,
                )
            await conn.execute("INSERT INTO memory_units(id,bank_id,text,fact_type,embedding,event_date,source_memory_ids,proof_count) VALUES($1,$2,'EXPIRED_MARKER derived observation','observation',$3::vector,now(),$4,2)", observation,banks[0],str([1.0]+[0.0]*7),[expired,fresh])
            await conn.execute("INSERT INTO entities(id,bank_id,canonical_name) VALUES($1,$2,'EXPIRED_MARKER entity')",entity,banks[0])
            await conn.execute("INSERT INTO unit_entities(unit_id,entity_id) VALUES($1,$2)",expired,entity)
        app = create_app(memory, initialize_memory=False)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
            base = f"/v1/default/banks/{banks[0]}"
            query = {"query":"fixture fact", "types":["world","experience"], "budget":"low", "max_tokens":4096,
                     "prefer_observations":False, "include":{"entities":None,"chunks":None,"source_facts":None}}
            before = await client.post(base+"/memories/recall", json=query)
            assert before.status_code == 200, before.status_code
            ids = {row["id"] for row in before.json()["results"]}
            assert str(expired) in ids and str(fresh) in ids and str(other) not in ids
            assert any(row.get("metadata")==metadata for row in before.json()["results"])
            listed = await client.get(base+"/memories/list", params={"document_id":"shared-document","state":"valid","limit":1,"offset":0})
            page2 = await client.get(base+"/memories/list", params={"document_id":"shared-document","state":"valid","limit":1,"offset":1})
            assert listed.status_code == page2.status_code == 200
            assert len(listed.json()["items"])==len(page2.json()["items"])==1
            assert listed.json()["items"][0]["id"] != page2.json()["items"][0]["id"]
            assert listed.json()["items"][0]["metadata"] == metadata
            wrong = await client.patch(f"/v1/default/banks/{banks[1]}/memories/{expired}",json={"state":"invalidated"})
            assert wrong.status_code == 404
            for _ in range(2):
                result = await client.patch(base+f"/memories/{expired}", json={"state":"invalidated","reason":"synthetic retention expiry"})
                assert result.status_code==200 and result.json()["state"]=="invalidated"
            async with pool.acquire() as conn:
                assert not await conn.fetchval("SELECT 1 FROM memory_units WHERE id=$1",expired)
                assert await conn.fetchval("SELECT 1 FROM invalidated_memory_units WHERE id=$1",expired)
                assert not await conn.fetchval("SELECT 1 FROM memory_units WHERE id=$1",observation)
                assert not await conn.fetchval("SELECT 1 FROM unit_entities WHERE unit_id=$1",expired)
                assert await conn.fetchval("SELECT 1 FROM memory_units WHERE id=$1",fresh)
                assert await conn.fetchval("SELECT 1 FROM memory_units WHERE id=$1",other)
            after = await client.post(base+"/memories/recall",json=query)
            assert after.status_code==200
            data=after.json()
            assert str(fresh) in {row["id"] for row in data["results"]}
            assert "EXPIRED_MARKER" not in json.dumps(data), "fact-only recall leaked invalidated content"
            # Native invalidation is NOT erasure: raw shared chunks still contain
            # historical text. Finite Manager mode must never deliver this field.
            async with pool.acquire() as conn:
                assert "EXPIRED_MARKER" in await conn.fetchval("SELECT chunk_text FROM chunks WHERE chunk_id='shared-chunk'")
            other_result=await client.post(f"/v1/default/banks/{banks[1]}/memories/recall",json=query)
            assert str(other) in {row["id"] for row in other_result.json()["results"]}
            async_base = "/v1/default/banks/s04-synthetic-async"
            assert (await client.put(async_base, json={"retain_extraction_mode":"verbatim", "enable_observations":False})).status_code == 200
            op = str(uuid.uuid4())
            retain = {"items":[{"content":"ASYNC_MARKER accepted fixture", "document_id":"async-document-v1", "metadata":metadata}], "async":True,"operation_id":op}
            accepted = await client.post(async_base+"/memories",json=retain)
            assert accepted.status_code == 200 and accepted.json()["operation_id"]==op and accepted.json()["success"] is True
            for _ in range(100):
                status = await client.get(async_base+f"/operations/{op}",params={"include_payload":"false"})
                assert status.status_code == 200
                if status.json()["status"]=="completed": break
                assert status.json()["status"] in ("pending","processing"), status.json()["status"]
                await asyncio.sleep(0.1)
            assert status.json()["status"]=="completed", "native async retain did not settle within fixture budget"
            assert "payload" not in status.json()
            retried = await client.post(async_base+"/memories",json=retain)
            assert retried.status_code==200 and retried.json()["operation_id"]==op
            facts = await client.get(async_base+"/memories/list",params={"document_id":"async-document-v1","state":"valid","limit":100,"offset":0})
            assert facts.status_code==200 and facts.json()["items"]
            assert all(row["metadata"]==metadata and row["document_id"]=="async-document-v1" for row in facts.json()["items"])
        print(json.dumps({"native_curation":"passed","native_fact_only_recall":"passed","derived_observation_pruned":True,
                          "entity_association_pruned":True,"paged_metadata":"passed","cross_bank":"passed",
                          "idempotent_invalidation":"passed","fresh_fact_preserved":True,"raw_chunk_erased":False,
                          "async_acceptance_settlement_verified":True}))
    finally:
        await memory.close()


if __name__ == "__main__":
    asyncio.run(main())
