-- 0008: Operator 平台技能市场（ClawHub -> 内部固定版本包）。
-- 仅保存纯文本技能：SKILL.md 与 references/*.md；不执行外部下载内容。

CREATE TABLE IF NOT EXISTS platform_skill (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source                 text NOT NULL DEFAULT 'clawhub',
    external_owner         text NOT NULL,
    external_slug          text NOT NULL,
    display_name           text NOT NULL DEFAULT '',
    summary                text NOT NULL DEFAULT '',
    latest_external_version text,
    latest_internal_version text,
    published_version      text,
    status                 text NOT NULL DEFAULT 'draft',
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_platform_skill_source_ref UNIQUE (source, external_owner, external_slug),
    CONSTRAINT chk_platform_skill_source CHECK (source = 'clawhub'),
    CONSTRAINT chk_platform_skill_status CHECK (status IN ('draft', 'published', 'unpublished', 'blocked'))
);

ALTER TABLE platform_skill ADD COLUMN IF NOT EXISTS published_version text;

CREATE TABLE IF NOT EXISTS platform_skill_version (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform_skill_id uuid NOT NULL REFERENCES platform_skill(id) ON DELETE CASCADE,
    version         text NOT NULL,
    content_hash    text NOT NULL,
    files           jsonb NOT NULL DEFAULT '[]'::jsonb,
    security        jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_url      text NOT NULL DEFAULT '',
    status          text NOT NULL DEFAULT 'draft',
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_platform_skill_version UNIQUE (platform_skill_id, version),
    CONSTRAINT chk_platform_skill_version_status CHECK (status IN ('draft', 'published'))
);

ALTER TABLE platform_skill_version ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_platform_skill_version_status'
    ) THEN
        ALTER TABLE platform_skill_version
            ADD CONSTRAINT chk_platform_skill_version_status CHECK (status IN ('draft', 'published'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS platform_skill_setting (
    id                  boolean PRIMARY KEY DEFAULT true,
    auto_publish_downloads boolean NOT NULL DEFAULT true,
    updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_skill_setting (id, auto_publish_downloads)
VALUES (true, true)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION platform_skill_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_platform_skill_touch ON platform_skill;
CREATE TRIGGER trg_platform_skill_touch BEFORE UPDATE ON platform_skill
FOR EACH ROW EXECUTE FUNCTION platform_skill_touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_skill, platform_skill_version, platform_skill_setting TO app_rw;
