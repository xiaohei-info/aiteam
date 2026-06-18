ALTER TABLE runtime_binding
    DROP CONSTRAINT IF EXISTS runtime_binding_owner_type_check;

ALTER TABLE runtime_binding
    ADD CONSTRAINT runtime_binding_owner_type_check
    CHECK(owner_type IN ('employee','team_run','team_task','scheduled_job','conversation'));
