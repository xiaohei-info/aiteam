-- Memory policy is employee_memory_setting truth. Do not touch Hindsight or import seed text.
ALTER TABLE employee_memory_setting ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'legacy_pending';
ALTER TABLE employee_memory_setting ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;
ALTER TABLE employee_memory_setting ADD COLUMN IF NOT EXISTS explicit_auto_retain boolean NOT NULL DEFAULT false;
ALTER TABLE employee_memory_setting ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}';

-- Normalize only observed evidence; absent operations are not automatic write consent.
CREATE OR REPLACE FUNCTION memory_policy_observed(p jsonb) RETURNS jsonb AS $$
DECLARE
    v jsonb := CASE WHEN jsonb_typeof(p)='object' THEN p ELSE '{}'::jsonb END;
    ops jsonb := '["recall"]';
    op text; key text; days integer := NULL;
BEGIN
    IF v ? 'allowed_operations' OR v ? 'operations' THEN
        ops := '[]';
        FOREACH op IN ARRAY ARRAY['recall','retain'] LOOP
            IF (NOT v ? 'allowed_operations' OR (jsonb_typeof(v->'allowed_operations')='array' AND v->'allowed_operations' ? op))
               AND (NOT v ? 'operations' OR (jsonb_typeof(v->'operations')='array' AND v->'operations' ? op)) THEN
                ops := ops || to_jsonb(op);
            END IF;
        END LOOP;
    END IF;
    FOREACH op IN ARRAY ARRAY['recall','retain'] LOOP
        FOREACH key IN ARRAY ARRAY[op, 'allow_'||op, op||'_enabled'] LOOP
            IF v->key = 'false'::jsonb THEN ops := ops - op; END IF;
        END LOOP;
    END LOOP;
    IF v ? 'enabled' AND v->'enabled' <> 'true'::jsonb THEN ops := '[]'; END IF;
    IF v ? 'retention_days' AND v->'retention_days' <> 'null'::jsonb THEN
        BEGIN
            days := GREATEST(1, (v->>'retention_days')::integer);
        EXCEPTION WHEN OTHERS THEN days := 1; END;
    END IF;
    RETURN jsonb_build_object('enabled', NOT v ? 'enabled' OR v->'enabled'='true'::jsonb,
      'allowed_operations',ops, 'explicit_auto_retain', v->'explicit_auto_retain'='true'::jsonb AND ops ? 'retain',
      'retention_days',days,'scope','employee') || jsonb_build_object(
      'explicit_auto_retain',COALESCE(v->'explicit_auto_retain'='true'::jsonb AND ops ? 'retain',false));
END;
$$ LANGUAGE plpgsql;

-- Add missing rows without losing the distinction from a previously present setting.
INSERT INTO employee_memory_setting (tenant_id,employee_id,policy,source,provenance)
SELECT tenant_id,id,'{}','legacy_missing_setting',jsonb_build_object('setting_present',false)
FROM employee ON CONFLICT (tenant_id,employee_id) DO NOTHING;

DO $$
DECLARE r record; a jsonb; b jsonb; merged jsonb; ops jsonb; op text; days integer;
BEGIN
    FOR r IN SELECT s.id,s.policy,s.retention_days,s.scope,s.source,s.provenance,e.memory_policy
             FROM employee_memory_setting s JOIN employee e ON e.id=s.employee_id AND e.tenant_id=s.tenant_id
             WHERE s.revision=0 LOOP
        a := memory_policy_observed(r.memory_policy);
        b := memory_policy_observed(r.policy);
        -- Only explicit operation sets constrain the other source; missing source is not [].
        ops := '[]';
        FOREACH op IN ARRAY ARRAY['recall','retain'] LOOP
            IF (a->'allowed_operations' ? op OR (NOT COALESCE(r.memory_policy ?| ARRAY['allowed_operations','operations'],false) AND op='retain'))
            AND (b->'allowed_operations' ? op OR (NOT r.policy ?| ARRAY['allowed_operations','operations'] AND op='retain'))
            AND ((a->'allowed_operations' ? op) OR (b->'allowed_operations' ? op)) THEN
                ops := ops || to_jsonb(op);
            END IF;
        END LOOP;
        -- Explicit false flags always win, even without an operation array.
        FOREACH op IN ARRAY ARRAY['recall','retain'] LOOP
            IF r.policy->op='false'::jsonb OR r.policy->('allow_'||op)='false'::jsonb OR r.policy->(op||'_enabled')='false'::jsonb
            OR r.memory_policy->op='false'::jsonb OR r.memory_policy->('allow_'||op)='false'::jsonb OR r.memory_policy->(op||'_enabled')='false'::jsonb THEN ops:=ops-op; END IF;
        END LOOP;
        IF a->'enabled'='false'::jsonb OR b->'enabled'='false'::jsonb THEN ops:='[]'; END IF;
        days := LEAST((a->>'retention_days')::integer,(b->>'retention_days')::integer,r.retention_days);
        IF days IS NOT NULL THEN days:=GREATEST(1,days); END IF;
        merged := jsonb_build_object('enabled',a->'enabled'='true'::jsonb AND b->'enabled'='true'::jsonb,
          'allowed_operations',ops,'explicit_auto_retain',
          ops ? 'retain' AND (a->'explicit_auto_retain'='true'::jsonb OR b->'explicit_auto_retain'='true'::jsonb)
          AND NOT COALESCE(r.policy->'explicit_auto_retain'='false'::jsonb,false)
          AND NOT COALESCE(r.memory_policy->'explicit_auto_retain'='false'::jsonb,false),
          'retention_days',days,'scope','employee');
        UPDATE employee_memory_setting SET policy=merged,retention_days=days,scope='employee',revision=1,
          explicit_auto_retain=(merged->>'explicit_auto_retain')::boolean,source='legacy_restrictive',
          provenance=jsonb_build_object('employee_policy',r.memory_policy,'setting_policy',r.policy,
          'setting_present',r.source<>'legacy_missing_setting','retention_days',r.retention_days,'scope',r.scope)
          WHERE id=r.id;
    END LOOP;
END $$;

-- Later retention migrations project a server-owned sticky guard. Replaying the
-- source migration must not erase that field or spuriously increment employee.version.
UPDATE employee e SET memory_policy=s.policy || jsonb_build_object('source',s.source,'revision',s.revision)
  || CASE WHEN e.memory_policy ? 'retention_guarded'
     THEN jsonb_build_object('retention_guarded',e.memory_policy->'retention_guarded') ELSE '{}'::jsonb END
FROM employee_memory_setting s WHERE e.tenant_id=s.tenant_id AND e.id=s.employee_id
AND (CASE WHEN jsonb_typeof(e.memory_policy)='object' THEN e.memory_policy - 'retention_guarded'
     ELSE e.memory_policy END) IS DISTINCT FROM s.policy || jsonb_build_object('source',s.source,'revision',s.revision);

ALTER TABLE hindsight_lease ADD COLUMN IF NOT EXISTS allowed_operations jsonb;
ALTER TABLE hindsight_lease ADD COLUMN IF NOT EXISTS policy_revision bigint;
-- No backfill of protocol evidence: pre-negotiation leases cannot retain.
ALTER TABLE hindsight_lease ADD COLUMN IF NOT EXISTS client_protocol text;
UPDATE hindsight_lease SET revoked_at=COALESCE(revoked_at,now())
WHERE allowed_operations IS NULL OR policy_revision IS NULL;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employee_memory_setting_owner_fk') THEN
        ALTER TABLE employee_memory_setting ADD CONSTRAINT employee_memory_setting_owner_fk
        FOREIGN KEY (tenant_id,employee_id) REFERENCES employee(tenant_id,id) ON DELETE CASCADE;
    END IF;
END $$;
