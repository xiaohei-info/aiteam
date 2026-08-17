-- Enterprise settings no longer select an execution engine; Pi owns session execution.
ALTER TABLE enterprise_settings DROP COLUMN IF EXISTS default_runtime;
