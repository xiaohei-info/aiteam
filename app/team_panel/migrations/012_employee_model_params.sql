-- Employee model-level parameters: temperature and max_tokens (§4.5 model block).
-- Defaults align with PRD: temperature 0.7, max_tokens 2048.

ALTER TABLE employee ADD COLUMN IF NOT EXISTS temperature FLOAT NOT NULL DEFAULT 0.7;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS max_tokens INTEGER NOT NULL DEFAULT 2048;
