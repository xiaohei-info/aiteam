-- Where a custom platform skill came from (design 2026-11-20「技能MCP命名空间出处与更新提示」§4.1):
-- {kind, label, url, version, edited}. NULL for skills the platform wrote itself; ClawHub rows derive it from owner/slug.
ALTER TABLE platform_skill ADD COLUMN IF NOT EXISTS provenance jsonb;
