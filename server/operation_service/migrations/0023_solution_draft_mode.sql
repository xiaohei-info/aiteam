-- Solo / group solution drafts: the mode is chosen when the draft is created (before any content exists);
-- confirmations records which generated decisions (coordinator / rules / capabilities) the operator confirmed.
-- Idempotent: migrations are re-run on every deploy.
ALTER TABLE solution_draft ADD COLUMN IF NOT EXISTS solution_mode text NOT NULL DEFAULT 'group';
ALTER TABLE solution_draft ADD COLUMN IF NOT EXISTS confirmations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE solution_draft DROP CONSTRAINT IF EXISTS ck_solution_draft_solution_mode;
ALTER TABLE solution_draft ADD CONSTRAINT ck_solution_draft_solution_mode CHECK (solution_mode IN ('solo', 'group'));
