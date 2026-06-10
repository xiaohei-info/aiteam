-- 005: allow canonical solution apply modes beyond append

ALTER TABLE solution_apply_record
    DROP CONSTRAINT IF EXISTS solution_apply_record_mode_check;

ALTER TABLE solution_apply_record
    ADD CONSTRAINT solution_apply_record_mode_check
    CHECK (mode IN ('append', 'replace', 'reapply'));
