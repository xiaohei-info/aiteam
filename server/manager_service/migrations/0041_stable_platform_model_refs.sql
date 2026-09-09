-- Employee references use stable Provider/model identities.
-- Operator owns release history; legacy version keys must not block execution.

UPDATE employee
SET platform_model_ref = jsonb_build_object(
    'provider_id', platform_model_ref->>'provider_id',
    'model_id', platform_model_ref->>'model_id'
)
WHERE jsonb_typeof(platform_model_ref) = 'object'
  AND platform_model_ref ? 'provider_id'
  AND platform_model_ref ? 'model_id';
