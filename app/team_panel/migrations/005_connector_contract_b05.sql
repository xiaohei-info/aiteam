ALTER TABLE enterprise_connector
    ADD COLUMN IF NOT EXISTS definition_id TEXT REFERENCES connector_definition(id),
    ADD COLUMN IF NOT EXISTS credential_mask TEXT NOT NULL DEFAULT '未配置',
    ADD COLUMN IF NOT EXISTS credential_state TEXT NOT NULL DEFAULT 'missing'
        CHECK (credential_state IN ('missing','configured','rotated','invalid','revoked')),
    ADD COLUMN IF NOT EXISTS scopes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS last_test_result_json JSONB NOT NULL DEFAULT '{"result": "never_tested", "checked_at": null, "checked_by": "", "error_code": "", "message": "尚未测试", "log_ref": ""}'::jsonb;

UPDATE enterprise_connector
SET credential_mask = CASE
        WHEN credential_ref IS NULL OR credential_ref = '' THEN '未配置'
        ELSE '已配置'
    END,
    credential_state = CASE
        WHEN credential_ref IS NULL OR credential_ref = '' THEN 'missing'
        ELSE 'configured'
    END,
    scopes_json = COALESCE(scopes_json, '[]'::jsonb),
    last_test_result_json = COALESCE(
        last_test_result_json,
        jsonb_build_object(
            'result', CASE WHEN last_validated_at IS NULL THEN 'never_tested' ELSE 'passed' END,
            'checked_at', last_validated_at,
            'checked_by', COALESCE(updated_by, created_by, ''),
            'error_code', '',
            'message', CASE WHEN last_validated_at IS NULL THEN '尚未测试' ELSE '最近一次连接测试通过' END,
            'log_ref', ''
        )
    )
WHERE TRUE;