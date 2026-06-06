"""P08 knowledge data-path tests for data-rd owned storage semantics."""

import psycopg2
import pytest

from team_panel.domain.entities import (
    Employee,
    EmployeeKnowledgeBinding,
    Enterprise,
    KnowledgeBase,
    KnowledgeDocument,
    KnowledgeIndexBinding,
    KnowledgeIngestionJob,
)
from team_panel.migrations.runner import is_applied
from team_panel.repositories.employee_knowledge_binding_repo import EmployeeKnowledgeBindingRepo
from team_panel.repositories.employee_repo import EmployeeRepo
from team_panel.repositories.enterprise_repo import EnterpriseRepo
from team_panel.repositories.knowledge_base_repo import KnowledgeBaseRepo
from team_panel.repositories.knowledge_document_repo import KnowledgeDocumentRepo
from team_panel.repositories.knowledge_index_binding_repo import KnowledgeIndexBindingRepo
from team_panel.repositories.knowledge_ingestion_job_repo import KnowledgeIngestionJobRepo
from team_panel.transactions.uow import UnitOfWork


pytestmark = pytest.mark.usefixtures("clean_tables")


def _seed_enterprise(cur):
    EnterpriseRepo(cur).create(
        Enterprise(id="ent_kb", slug="ent-kb", name="Knowledge Enterprise", owner_user_id="owner_001")
    )


def _seed_employee(cur, employee_id: str = "emp_kb"):
    EmployeeRepo(cur).create(
        Employee(
            id=employee_id,
            enterprise_id="ent_kb",
            profile_name=f"profile-{employee_id}",
            display_name=f"Employee {employee_id}",
            status="active",
        )
    )


def _seed_knowledge_base(cur, kb_id: str = "kb_001"):
    repo = KnowledgeBaseRepo(cur)
    repo.create(
        KnowledgeBase(
            id=kb_id,
            enterprise_id="ent_kb",
            name="Support Docs",
            description="Customer support knowledge",
            storage_prefix="aiteam/ent_kb/knowledge/support",
        )
    )


def _seed_employee_kb_binding(cur, binding_id: str = "ekb_001", employee_id: str = "emp_kb", kb_id: str = "kb_001"):
    EmployeeKnowledgeBindingRepo(cur).create(
        EmployeeKnowledgeBinding(
            id=binding_id,
            enterprise_id="ent_kb",
            employee_id=employee_id,
            knowledge_base_id=kb_id,
        )
    )


class TestKnowledgeDomainLifecycle:
    def test_document_retry_lifecycle(self):
        doc = KnowledgeDocument(
            id="doc_001",
            knowledge_base_id="kb_001",
            enterprise_id="ent_kb",
            file_name="faq.pdf",
            file_type="application/pdf",
        )

        doc.start_ingesting("ing_001")
        doc.mark_error("LIGHTRAG_TIMEOUT", "insert timeout")
        assert doc.status == "error"
        assert doc.error_code == "LIGHTRAG_TIMEOUT"

        doc.reset_for_retry()
        assert doc.status == "uploaded"
        assert doc.ingestion_job_id is None

        doc.start_ingesting("ing_002")
        doc.mark_ready(rag_document_id="rag_doc_001", chunk_count=12)
        assert doc.status == "ready"
        assert doc.rag_document_id == "rag_doc_001"
        assert doc.chunk_count == 12

    def test_index_binding_ready_error_disable(self):
        binding = KnowledgeIndexBinding(
            id="kib_001",
            enterprise_id="ent_kb",
            employee_id="emp_kb",
            knowledge_base_id="kb_001",
            rag_index_id="rag_idx_001",
        )

        binding.mark_ready(rag_document_id="rag_doc_001")
        assert binding.status == "ready"
        assert binding.rag_document_id == "rag_doc_001"

        binding.mark_error("sync drift")
        assert binding.status == "error"
        assert binding.error_message == "sync drift"

        binding.disable()
        assert binding.status == "disabled"

    def test_ingestion_job_lifecycle(self):
        job = KnowledgeIngestionJob(
            id="ing_001",
            knowledge_base_id="kb_001",
            enterprise_id="ent_kb",
            document_id="doc_001",
        )

        job.start()
        job.start_inserting()
        job.complete(rag_document_id="rag_doc_001", chunk_count=9)
        assert job.status == "completed"
        assert job.rag_document_id == "rag_doc_001"
        assert job.chunk_count == 9
        assert job.started_at is not None
        assert job.completed_at is not None


class TestKnowledgeRepositories:
    def test_knowledge_base_repo_crud(self, db_conn):
        _seed_enterprise(db_conn.cursor())
        repo = KnowledgeBaseRepo(db_conn.cursor())
        kb = KnowledgeBase(id="kb_repo", enterprise_id="ent_kb", name="Policies", storage_prefix="aiteam/policies")

        repo.create(kb)
        loaded = repo.get_by_id("kb_repo")
        assert loaded is not None
        assert loaded.name == "Policies"

        loaded.description = "HR policies"
        repo.update(loaded)
        reloaded = repo.get_by_id("kb_repo")
        assert reloaded is not None
        assert reloaded.description == "HR policies"

    def test_document_repo_tracks_rag_document_state(self, db_conn):
        cur = db_conn.cursor()
        _seed_enterprise(cur)
        _seed_knowledge_base(cur)
        repo = KnowledgeDocumentRepo(db_conn.cursor())
        doc = KnowledgeDocument(
            id="doc_repo",
            knowledge_base_id="kb_001",
            enterprise_id="ent_kb",
            asset_id="asset_001",
            display_name="FAQ",
            file_name="faq.pdf",
            file_type="application/pdf",
            storage_key="uploads/faq.pdf",
        )

        repo.create(doc)
        repo.update_state(
            "doc_repo",
            status="ready",
            ingestion_job_id="ing_repo",
            rag_document_id="rag_doc_repo",
            chunk_count=7,
        )
        loaded = repo.get_by_id("doc_repo")
        assert loaded is not None
        assert loaded.status == "ready"
        assert loaded.rag_document_id == "rag_doc_repo"
        assert loaded.chunk_count == 7
        by_asset = repo.get_by_asset("kb_001", "asset_001")
        assert by_asset is not None
        assert by_asset.id == "doc_repo"

    def test_ingestion_job_repo_lists_pending_and_latest(self, db_conn):
        cur = db_conn.cursor()
        _seed_enterprise(cur)
        _seed_knowledge_base(cur)
        KnowledgeDocumentRepo(cur).create(
            KnowledgeDocument(
                id="doc_job",
                knowledge_base_id="kb_001",
                enterprise_id="ent_kb",
                asset_id="asset_job",
                display_name="Playbook",
                file_name="playbook.md",
                file_type="text/markdown",
            )
        )

        repo = KnowledgeIngestionJobRepo(db_conn.cursor())
        repo.create(
            KnowledgeIngestionJob(
                id="ing_job",
                knowledge_base_id="kb_001",
                enterprise_id="ent_kb",
                document_id="doc_job",
            )
        )
        pending = repo.list_pending()
        assert [job.id for job in pending] == ["ing_job"]

        repo.update_state("ing_job", status="completed", rag_document_id="rag_doc_job", chunk_count=3)
        loaded = repo.get_latest_by_document("doc_job")
        assert loaded is not None
        assert loaded.status == "completed"
        assert loaded.rag_document_id == "rag_doc_job"

    def test_index_binding_repo_filters_employee_ready_bindings(self, db_conn):
        cur = db_conn.cursor()
        _seed_enterprise(cur)
        _seed_employee(cur)
        _seed_knowledge_base(cur)
        _seed_employee_kb_binding(cur)
        KnowledgeDocumentRepo(cur).create(
            KnowledgeDocument(
                id="doc_bind",
                knowledge_base_id="kb_001",
                enterprise_id="ent_kb",
                asset_id="asset_bind",
                display_name="Binder",
                file_name="binder.pdf",
                file_type="application/pdf",
            )
        )

        repo = KnowledgeIndexBindingRepo(db_conn.cursor())
        repo.create(
            KnowledgeIndexBinding(
                id="kib_ready",
                enterprise_id="ent_kb",
                employee_id="emp_kb",
                knowledge_base_id="kb_001",
                employee_knowledge_binding_id="ekb_001",
                document_id="doc_bind",
                rag_index_id="rag_idx_ready",
                status="ready",
                rag_document_id="rag_doc_ready",
            )
        )
        repo.create(
            KnowledgeIndexBinding(
                id="kib_pending",
                enterprise_id="ent_kb",
                employee_id="emp_kb",
                knowledge_base_id="kb_001",
                employee_knowledge_binding_id="ekb_001",
                document_id="doc_bind",
                rag_index_id="rag_idx_pending",
            )
        )

        ready = repo.list_by_employee("emp_kb", status="ready")
        assert [binding.id for binding in ready] == ["kib_ready"]
        by_doc = repo.list_by_document("doc_bind")
        assert {binding.id for binding in by_doc} == {"kib_ready", "kib_pending"}

    def test_unique_employee_rag_index_binding(self, db_conn):
        cur = db_conn.cursor()
        _seed_enterprise(cur)
        _seed_employee(cur)
        _seed_knowledge_base(cur)
        _seed_employee_kb_binding(cur)
        repo = KnowledgeIndexBindingRepo(db_conn.cursor())
        repo.create(
            KnowledgeIndexBinding(
                id="kib_dup_1",
                enterprise_id="ent_kb",
                employee_id="emp_kb",
                knowledge_base_id="kb_001",
                employee_knowledge_binding_id="ekb_001",
                rag_index_id="rag_idx_dup",
            )
        )
        with pytest.raises(psycopg2.errors.UniqueViolation):
            repo.create(
                KnowledgeIndexBinding(
                    id="kib_dup_2",
                    enterprise_id="ent_kb",
                    employee_id="emp_kb",
                    knowledge_base_id="kb_001",
                    employee_knowledge_binding_id="ekb_001",
                    rag_index_id="rag_idx_dup",
                )
            )


class TestKnowledgeUowAndMigration:
    def test_uow_accessors_cover_knowledge_repos(self, db_conn):
        with UnitOfWork(db_conn) as uow:
            _seed_enterprise(uow.cur)
            _seed_employee(uow.cur)
            uow.knowledge_bases().create(
                KnowledgeBase(id="kb_uow", enterprise_id="ent_kb", name="UoW KB")
            )
            _seed_employee_kb_binding(uow.cur, binding_id="ekb_uow", kb_id="kb_uow")
            uow.knowledge_documents().create(
                KnowledgeDocument(
                    id="doc_uow",
                    knowledge_base_id="kb_uow",
                    enterprise_id="ent_kb",
                    asset_id="asset_uow",
                    display_name="UoW Doc",
                    file_name="uow.txt",
                    file_type="text/plain",
                )
            )
            uow.knowledge_ingestion_jobs().create(
                KnowledgeIngestionJob(
                    id="ing_uow",
                    knowledge_base_id="kb_uow",
                    enterprise_id="ent_kb",
                    document_id="doc_uow",
                )
            )
            uow.knowledge_index_bindings().create(
                KnowledgeIndexBinding(
                    id="kib_uow",
                    enterprise_id="ent_kb",
                    employee_id="emp_kb",
                    knowledge_base_id="kb_uow",
                    employee_knowledge_binding_id="ekb_uow",
                    document_id="doc_uow",
                    rag_index_id="rag_idx_uow",
                )
            )

        cur = db_conn.cursor()
        cur.execute("SELECT COUNT(*) FROM knowledge_index_binding WHERE id = 'kib_uow'")
        assert cur.fetchone()[0] == 1
        cur.close()

    def test_knowledge_migration_recorded(self, db_conn):
        assert is_applied(db_conn, "004_knowledge_data_path.sql")
