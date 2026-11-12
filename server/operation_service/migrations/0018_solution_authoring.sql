-- Industry-document solution authoring (operator side, public pool).
--
-- Drafts generated from uploaded industry documents by the server-side Pi agent,
-- reviewed by a human and then published into catalog_template. The Operation
-- database is single-tenant; no RLS is needed here. Idempotent.
--
-- Uploaded files themselves live on the Operator host's storage directory;
-- solution_source_document keeps only metadata, a storage key and the sha256.

CREATE TABLE IF NOT EXISTS solution_draft (
    draft_id              uuid PRIMARY KEY,
    title                 text NOT NULL,
    status                text NOT NULL DEFAULT 'draft',
    model_provider_id     text NOT NULL,
    model_id              text NOT NULL,
    image_recognition     text NOT NULL DEFAULT 'none',
    supplement            text NOT NULL DEFAULT '',
    -- Generated content (shared.solution_authoring.schemas.GeneratedSolution); NULL until a job succeeds.
    package               jsonb,
    -- Cited source chunks only: chunk_id -> {source_name, locator, excerpt, origin, low_confidence}.
    evidence_sources      jsonb NOT NULL DEFAULT '{}'::jsonb,
    warnings              jsonb NOT NULL DEFAULT '[]'::jsonb,
    prompt_version        text NOT NULL DEFAULT '',
    usage                 jsonb NOT NULL DEFAULT '{}'::jsonb,
    review_note           text NOT NULL DEFAULT '',
    -- Resumable publish progress: catalog ids already registered / published for this draft.
    publish_state         jsonb NOT NULL DEFAULT '{}'::jsonb,
    published_solution_id text,
    version               integer NOT NULL DEFAULT 1,
    created_by            text NOT NULL,
    updated_by            text NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_solution_draft_status CHECK (status IN (
        'draft', 'generating', 'ready_for_review', 'in_review', 'approved', 'published', 'rejected', 'archived'
    )),
    CONSTRAINT ck_solution_draft_image_recognition CHECK (image_recognition IN ('none', 'vision'))
);

CREATE INDEX IF NOT EXISTS ix_solution_draft_status_updated
    ON solution_draft (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS solution_source_document (
    source_id    uuid PRIMARY KEY,
    draft_id     uuid NOT NULL REFERENCES solution_draft (draft_id) ON DELETE CASCADE,
    -- Per-draft ordinal; chunk ids handed to the agent are derived from it (s1-c1, s2-i3-b1 ...).
    seq          integer NOT NULL,
    file_name    text NOT NULL,
    size_bytes   bigint NOT NULL,
    sha256       text NOT NULL,
    storage_key  text NOT NULL,
    status       text NOT NULL DEFAULT 'uploaded',
    error_code   text,
    chunk_count  integer NOT NULL DEFAULT 0,
    image_count  integer NOT NULL DEFAULT 0,
    warnings     jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_solution_source_document_seq UNIQUE (draft_id, seq),
    CONSTRAINT ck_solution_source_document_status CHECK (status IN ('uploaded', 'parsed', 'failed'))
);

CREATE TABLE IF NOT EXISTS solution_generation_job (
    job_id           uuid PRIMARY KEY,
    draft_id         uuid NOT NULL REFERENCES solution_draft (draft_id) ON DELETE CASCADE,
    status           text NOT NULL DEFAULT 'queued',
    idempotency_key  text,
    attempt          integer NOT NULL DEFAULT 0,
    lease_owner      text,
    lease_expires_at timestamptz,
    -- Stable error code plus a bounded message; never document content or credentials.
    error_code       text,
    error_message    text,
    usage            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by       text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    started_at       timestamptz,
    finished_at      timestamptz,
    CONSTRAINT ck_solution_generation_job_status CHECK (status IN (
        'queued', 'parsing', 'analyzing', 'succeeded', 'failed'
    ))
);

-- At most one unfinished job per draft; a retried request with the same key maps to the same job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_solution_generation_job_active
    ON solution_generation_job (draft_id) WHERE status IN ('queued', 'parsing', 'analyzing');
CREATE UNIQUE INDEX IF NOT EXISTS uq_solution_generation_job_idempotency
    ON solution_generation_job (draft_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_solution_generation_job_claim
    ON solution_generation_job (status, created_at);

CREATE TABLE IF NOT EXISTS solution_sensitive_finding (
    finding_id   uuid PRIMARY KEY,
    draft_id     uuid NOT NULL REFERENCES solution_draft (draft_id) ON DELETE CASCADE,
    kind         text NOT NULL,
    origin       text NOT NULL,
    field_path   text NOT NULL DEFAULT '',
    -- Raw excerpt, kept next to the draft content it was found in; APIs and logs only expose `masked`.
    excerpt      text NOT NULL DEFAULT '',
    masked       text NOT NULL DEFAULT '',
    chunk_id     text NOT NULL DEFAULT '',
    locator      text NOT NULL DEFAULT '',
    note         text NOT NULL DEFAULT '',
    status       text NOT NULL DEFAULT 'open',
    resolved_by  text,
    resolved_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_solution_sensitive_finding_origin CHECK (origin IN ('rule', 'agent', 'system')),
    CONSTRAINT ck_solution_sensitive_finding_status CHECK (status IN (
        'open', 'redacted', 'removed', 'accepted_public', 'acknowledged'
    ))
);

CREATE INDEX IF NOT EXISTS ix_solution_sensitive_finding_draft
    ON solution_sensitive_finding (draft_id, created_at);

-- Append-only audit trail: action, actor and a short summary; never draft or document content.
CREATE TABLE IF NOT EXISTS solution_review_event (
    event_id    uuid PRIMARY KEY,
    draft_id    uuid NOT NULL REFERENCES solution_draft (draft_id),
    action      text NOT NULL,
    actor_id    text NOT NULL,
    summary     text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_solution_review_event_draft
    ON solution_review_event (draft_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON solution_draft TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON solution_source_document TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON solution_generation_job TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON solution_sensitive_finding TO app_rw;
GRANT SELECT, INSERT ON solution_review_event TO app_rw;
