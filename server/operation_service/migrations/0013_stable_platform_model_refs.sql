-- Provider/model references crossing the Operator boundary use stable
-- identities. Release versions remain Operator-owned catalog metadata.

UPDATE enterprise_account AS account
SET allowed_model_refs = (
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'provider_id', ref->>'provider_id',
                'model_id', ref->>'model_id'
            )
        ),
        '[]'::jsonb
    )
    FROM jsonb_array_elements(account.allowed_model_refs) AS ref
    WHERE jsonb_typeof(ref) = 'object'
      AND ref ? 'provider_id'
      AND ref ? 'model_id'
)
WHERE jsonb_typeof(account.allowed_model_refs) = 'array';

UPDATE catalog_template AS template
SET payload = jsonb_set(
    template.payload,
    '{platform_model_ref}',
    jsonb_build_object(
        'provider_id', template.payload->'platform_model_ref'->>'provider_id',
        'model_id', template.payload->'platform_model_ref'->>'model_id'
    ),
    false
)
WHERE jsonb_typeof(template.payload->'platform_model_ref') = 'object'
  AND template.payload->'platform_model_ref' ? 'provider_id'
  AND template.payload->'platform_model_ref' ? 'model_id';
