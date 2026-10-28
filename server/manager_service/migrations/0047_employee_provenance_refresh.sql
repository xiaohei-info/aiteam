-- Refresh existing template-backed projections through the existing config revision.
-- The migration ledger applies this update once; later configuration changes use
-- the normal employee version mechanism. Unrelated employees stay unchanged.
UPDATE employee
SET version = version + 1
WHERE source_template_id IS NOT NULL;
