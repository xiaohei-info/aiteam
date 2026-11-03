"""Authentication policy shared by every JWT issuer."""

# One long-lived access-token TTL across Manager, Operation and Agent-facing
# clients. Revocation is handled by the service-side auth_session authority.
AUTH_SESSION_TTL_SECONDS = 2_592_000  # 30 days
