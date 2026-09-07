-- Read-only rollout preflight. Run under a deployment-authorized read-only identity.
-- No content, secret, actor, or inferred historical permission is exported.
BEGIN TRANSACTION READ ONLY;
SELECT 'whole_history_unknown' AS finding, e.tenant_id, e.id AS employee_id
FROM employee e
WHERE NOT EXISTS (SELECT 1 FROM employee_knowledge_binding b
                  WHERE b.tenant_id = e.tenant_id AND b.employee_id = e.id);
SELECT 'document_resource_not_admin_intent' AS finding,
       tenant_id, employee_id, document_id, status
FROM knowledge_document_binding WHERE status IN ('revoked', 'stale');
SELECT 'invalid_whole_employee_owner' AS finding, b.tenant_id, b.employee_id
FROM employee_knowledge_binding b LEFT JOIN employee e
    ON (e.tenant_id, e.id) = (b.tenant_id, b.employee_id) WHERE e.id IS NULL;
SELECT 'invalid_document_binding_owner' AS finding, b.tenant_id, b.employee_id, b.document_id
FROM knowledge_document_binding b
LEFT JOIN employee e ON (e.tenant_id, e.id) = (b.tenant_id, b.employee_id)
LEFT JOIN knowledge_document d ON (d.tenant_id, d.knowledge_space_id, d.id)
    = (b.tenant_id, b.knowledge_space_id, b.document_id)
WHERE e.id IS NULL OR d.id IS NULL;
ROLLBACK;
