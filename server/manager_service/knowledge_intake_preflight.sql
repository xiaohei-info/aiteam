-- S05 rollout preflight. Run only with approved deployment access in a READ ONLY
-- transaction. Compatible before/after 0039. No source bodies, filenames,
-- error_message, native response payloads or credentials are selected.
SELECT j.tenant_id, j.id AS job_id, j.document_id, j.status AS job_status,
       d.status AS document_status, j.error_code,
       CASE WHEN to_jsonb(j) ? 'file_source' THEN 'recovery-v1' ELSE 'legacy-unfenced' END AS evidence_format,
       to_jsonb(j)->>'submission_state' AS submission_state,
       to_jsonb(j)->>'claim_owner' AS claim_owner,
       to_jsonb(j)->>'lease_until' AS lease_until,
       to_jsonb(j)->>'heartbeat_at' AS heartbeat_at,
       to_jsonb(j)->>'attempts' AS attempts,
       to_jsonb(j)->>'next_attempt_at' AS next_attempt_at,
       to_jsonb(j)->>'file_source' AS file_source,
       to_jsonb(j)->>'track_id' AS track_id,
       to_jsonb(j)->>'upstream_document_id' AS upstream_document_id,
       j.created_at, j.completed_at
FROM knowledge_ingestion_job j JOIN knowledge_document d ON d.id=j.document_id
WHERE j.status NOT IN ('done','failed') OR to_jsonb(j)->>'submission_state'='submitted'
   OR j.error_code IN ('INDEX_FAILED','BINDING_PROPAGATION_FAILED','SUBMISSION_UNKNOWN')
ORDER BY j.tenant_id, j.created_at, j.id;

SELECT tenant_id, count(*) AS incomplete_jobs,
       count(*) FILTER (WHERE to_jsonb(j)->>'submission_state'='submitted') AS fenced_jobs,
       count(*) FILTER (WHERE error_code='SUBMISSION_UNKNOWN') AS unknown_jobs,
       count(*) FILTER (WHERE status='indexing' AND to_jsonb(j)->>'track_id' IS NULL) AS indexing_without_track
FROM knowledge_ingestion_job j
WHERE status NOT IN ('done','failed') OR to_jsonb(j)->>'submission_state'='submitted'
   OR error_code IN ('INDEX_FAILED','BINDING_PROPAGATION_FAILED','SUBMISSION_UNKNOWN')
GROUP BY tenant_id ORDER BY tenant_id;

SELECT d.tenant_id, d.id AS document_id, d.status AS document_status, 'missing_job' AS evidence_gap
FROM knowledge_document d
WHERE d.status IN ('uploaded','parsing','indexing','reindex_requested')
  AND NOT EXISTS (SELECT 1 FROM knowledge_ingestion_job j WHERE j.document_id=d.id)
ORDER BY d.tenant_id, d.id;

SELECT tenant_id, skill_id, version, catalog_version, content_hash,
       CASE WHEN jsonb_typeof(files)='array' THEN jsonb_array_length(files) ELSE NULL END AS file_count
FROM skill_catalog ORDER BY tenant_id, skill_id;

-- Report ownership mismatches before the new composite FK; never repair them.
SELECT j.id AS job_id, j.tenant_id AS job_tenant_id, j.knowledge_space_id AS job_space,
       d.id AS document_id, d.tenant_id AS document_tenant_id, d.knowledge_space_id AS document_space
FROM knowledge_ingestion_job j JOIN knowledge_document d ON d.id=j.document_id
WHERE j.tenant_id IS DISTINCT FROM d.tenant_id OR j.knowledge_space_id IS DISTINCT FROM d.knowledge_space_id
ORDER BY j.id;

-- A legacy pending receipt is not linked to a job just because document_id matches.
SELECT o.tenant_id, o.id AS operation_id, o.document_id, o.status, o.created_at,
       'unproven_reindex_job' AS evidence_gap
FROM knowledge_document_operation o
WHERE o.operation='reindex' AND o.status IN ('pending','accepted')
  AND NOT EXISTS (SELECT 1 FROM knowledge_ingestion_job j
                  WHERE to_jsonb(j)->>'operation_id'=o.id::text)
ORDER BY o.tenant_id, o.created_at, o.id;
