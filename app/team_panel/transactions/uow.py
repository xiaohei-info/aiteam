"""Unit of Work — transaction boundary for repository operations."""

from __future__ import annotations

import psycopg2.extensions

from ..repositories.agent_template_repo import AgentTemplateRepo
from ..repositories.audit_event_repo import AuditEventRepo
from ..repositories.connector_definition_repo import ConnectorDefinitionRepo
from ..repositories.connector_repo import EnterpriseConnectorRepo
from ..repositories.conversation_repo import ConversationRepo
from ..repositories.conversation_message_repo import ConversationMessageRepo
from ..repositories.employee_connector_binding_repo import EmployeeConnectorBindingRepo
from ..repositories.employee_knowledge_binding_repo import EmployeeKnowledgeBindingRepo
from ..repositories.employee_memory_binding_repo import EmployeeMemoryBindingRepo
from ..repositories.enterprise_skill_install_repo import EnterpriseSkillInstallRepo
from ..repositories.memory_item_repo import MemoryItemRepo, MemoryReviewDecisionRepo
from ..repositories.employee_prompt_repo import EmployeePromptRepo
from ..repositories.employee_repo import EmployeeRepo
from ..repositories.employee_skill_binding_repo import EmployeeSkillBindingRepo
from ..repositories.enterprise_repo import EnterpriseRepo
from ..repositories.industry_solution_repo import IndustrySolutionRepo
from ..repositories.knowledge_base_repo import KnowledgeBaseRepo
from ..repositories.knowledge_document_repo import KnowledgeDocumentRepo
from ..repositories.knowledge_index_binding_repo import KnowledgeIndexBindingRepo
from ..repositories.knowledge_ingestion_job_repo import KnowledgeIngestionJobRepo
from ..repositories.recruitment_order_repo import RecruitmentOrderRepo
from ..repositories.run_event_repo import RunEventRepo
from ..repositories.runtime_binding_repo import RuntimeBindingRepo
from ..repositories.scheduled_job_repo import ScheduledJobRepo
from ..repositories.solution_apply_record_repo import SolutionApplyRecordRepo
from ..repositories.solution_template_binding_repo import SolutionTemplateBindingRepo
from ..repositories.team_run_repo import TeamRunRepo
from ..repositories.usage_ledger_repo import UsageLedgerRepo
from ..repositories.team_task_repo import TeamTaskRepo
from ..repositories.workbench_state_repo import ConversationReadStateRepo, WorkbenchEmployeePreferenceRepo


class UnitOfWork:
    """Context manager that opens a transaction and exposes repository accessors.

    All repositories created through this UoW share the same cursor within
    the transaction boundary.  On successful exit the transaction is
    committed; on exception it is rolled back and the cursor is closed.
    """

    def __init__(self, conn: psycopg2.extensions.connection) -> None:
        self._conn = conn
        self._cur: psycopg2.extensions.cursor | None = None
        self._committed = False
        self._prev_autocommit: bool | None = None

    def __enter__(self) -> 'UnitOfWork':
        self._prev_autocommit = self._conn.autocommit
        self._conn.autocommit = False
        self._cur = self._conn.cursor()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool | None:
        try:
            if exc_type is not None:
                self._conn.rollback()
            else:
                self._conn.commit()
                self._committed = True
        finally:
            if self._cur is not None:
                self._cur.close()
                self._cur = None
            if self._prev_autocommit is not None:
                self._conn.autocommit = self._prev_autocommit
        return False

    @property
    def cur(self) -> psycopg2.extensions.cursor:
        if self._cur is None:
            raise RuntimeError("UnitOfWork cursor is not available outside the context.")
        return self._cur

    @property
    def committed(self) -> bool:
        return self._committed

    def enterprises(self) -> EnterpriseRepo:
        return EnterpriseRepo(self.cur)

    def employees(self) -> EmployeeRepo:
        return EmployeeRepo(self.cur)

    def agent_templates(self) -> AgentTemplateRepo:
        return AgentTemplateRepo(self.cur)

    def recruitment_orders(self) -> RecruitmentOrderRepo:
        return RecruitmentOrderRepo(self.cur)

    def industry_solutions(self) -> IndustrySolutionRepo:
        return IndustrySolutionRepo(self.cur)

    def solution_apply_records(self) -> SolutionApplyRecordRepo:
        return SolutionApplyRecordRepo(self.cur)

    def solution_template_bindings(self) -> SolutionTemplateBindingRepo:
        return SolutionTemplateBindingRepo(self.cur)

    def employee_prompts(self) -> EmployeePromptRepo:
        return EmployeePromptRepo(self.cur)

    def employee_skill_bindings(self) -> EmployeeSkillBindingRepo:
        return EmployeeSkillBindingRepo(self.cur)

    def employee_knowledge_bindings(self) -> EmployeeKnowledgeBindingRepo:
        return EmployeeKnowledgeBindingRepo(self.cur)

    def employee_memory_bindings(self) -> EmployeeMemoryBindingRepo:
        return EmployeeMemoryBindingRepo(self.cur)

    def knowledge_bases(self) -> KnowledgeBaseRepo:
        return KnowledgeBaseRepo(self.cur)

    def knowledge_documents(self) -> KnowledgeDocumentRepo:
        return KnowledgeDocumentRepo(self.cur)

    def knowledge_index_bindings(self) -> KnowledgeIndexBindingRepo:
        return KnowledgeIndexBindingRepo(self.cur)

    def knowledge_ingestion_jobs(self) -> KnowledgeIngestionJobRepo:
        return KnowledgeIngestionJobRepo(self.cur)

    def connector_definitions(self) -> ConnectorDefinitionRepo:
        return ConnectorDefinitionRepo(self.cur)

    def enterprise_skill_installs(self) -> EnterpriseSkillInstallRepo:
        return EnterpriseSkillInstallRepo(self.cur)

    def memory_items(self) -> MemoryItemRepo:
        return MemoryItemRepo(self.cur)

    def memory_review_decisions(self) -> MemoryReviewDecisionRepo:
        return MemoryReviewDecisionRepo(self.cur)

    def enterprise_connectors(self) -> EnterpriseConnectorRepo:
        return EnterpriseConnectorRepo(self.cur)

    def employee_connector_bindings(self) -> EmployeeConnectorBindingRepo:
        return EmployeeConnectorBindingRepo(self.cur)

    def conversations(self) -> ConversationRepo:
        return ConversationRepo(self.cur)

    def conversation_messages(self) -> ConversationMessageRepo:
        return ConversationMessageRepo(self.cur)

    def team_runs(self) -> TeamRunRepo:
        return TeamRunRepo(self.cur)

    def usage_ledgers(self) -> UsageLedgerRepo:
        return UsageLedgerRepo(self.cur)

    def team_tasks(self) -> TeamTaskRepo:
        return TeamTaskRepo(self.cur)

    def scheduled_jobs(self) -> ScheduledJobRepo:
        return ScheduledJobRepo(self.cur)

    def runtime_bindings(self) -> RuntimeBindingRepo:
        return RuntimeBindingRepo(self.cur)

    def run_events(self) -> RunEventRepo:
        return RunEventRepo(self.cur)

    def audit_events(self) -> AuditEventRepo:
        return AuditEventRepo(self.cur)

    def workbench_employee_preferences(self) -> WorkbenchEmployeePreferenceRepo:
        return WorkbenchEmployeePreferenceRepo(self.cur)

    def conversation_read_states(self) -> ConversationReadStateRepo:
        return ConversationReadStateRepo(self.cur)
