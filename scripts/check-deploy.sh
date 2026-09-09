#!/usr/bin/env bash
# Deployment/release quality gate used locally and in CI. It never mutates a
# database, pulls an image, starts a service, or contacts taiyi.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

shell_files=()
while IFS= read -r file; do shell_files+=("${file}"); done < <(find deploy scripts -type f -name '*.sh' -print | sort)
(( ${#shell_files[@]} )) || { echo '[deploy-check][ERR] no deployment shell files found' >&2; exit 1; }
for file in "${shell_files[@]}"; do
  bash -n "${file}"
done
echo "[deploy-check] bash syntax OK (${#shell_files[@]} files)"

COMPOSE_FILE=deploy/docker/docker-compose.yml
# Compose now requires an explicit environment marker; the static gate itself
# runs against a non-production test profile unless the caller supplied one.
export AITEAM_ENV="${AITEAM_ENV:-test}"
docker compose -f "${COMPOSE_FILE}" config --quiet
AITEAM_ENV=production docker compose -f "${COMPOSE_FILE}" -f deploy/docker/docker-compose.maintenance.yml --profile lightrag --profile newapi config --quiet
maintenance_services="$(AITEAM_ENV=production docker compose -f "${COMPOSE_FILE}" -f deploy/docker/docker-compose.maintenance.yml --profile lightrag --profile newapi config --services)"
grep -qx postgres <<<"${maintenance_services}" || { echo '[deploy-check][ERR] production maintenance graph must retain PostgreSQL dependency' >&2; exit 1; }
for service in aiteam-compose-guard operation manager agent; do
  if grep -qx "${service}" <<<"${maintenance_services}"; then
    echo "[deploy-check][ERR] production maintenance graph must not include ${service}" >&2
    exit 1
  fi
done
echo '[deploy-check] docker compose config OK (default + production maintenance profiles)'

default_services="$(docker compose -f "${COMPOSE_FILE}" config --services)"
lightrag_services="$(docker compose -f "${COMPOSE_FILE}" --profile lightrag config --services)"
newapi_services="$(docker compose -f "${COMPOSE_FILE}" --profile newapi config --services)"
for service in postgres operation manager agent; do
  grep -qx "${service}" <<<"${default_services}" || { echo "[deploy-check][ERR] default Compose profile missing ${service}" >&2; exit 1; }
done
if grep -Eq '^(lightrag|lightrag-postgres|newapi|newapi-postgres|newapi-redis)$' <<<"${default_services}"; then
  echo '[deploy-check][ERR] external components must not start in the default Compose profile' >&2
  exit 1
fi
for service in lightrag-postgres lightrag; do
  grep -qx "${service}" <<<"${lightrag_services}" || { echo "[deploy-check][ERR] lightrag profile missing ${service}" >&2; exit 1; }
done
for service in newapi-postgres newapi-redis newapi; do
  grep -qx "${service}" <<<"${newapi_services}" || { echo "[deploy-check][ERR] newapi profile missing ${service}" >&2; exit 1; }
done
echo '[deploy-check] Compose profile boundaries OK (LightRAG/NewAPI explicit)'

# Production must not inherit the old known database/service credentials from
# the checked-in Compose graph; ctl validates the injected values before start.
grep -Eq '^      POSTGRES_PASSWORD: \$\{POSTGRES_SUPER_PASSWORD:-' "${COMPOSE_FILE}"
grep -Eq '^      ADMIN_DB_URL: postgresql://\$\{POSTGRES_SUPER_USER:-' "${COMPOSE_FILE}"
grep -Eq '^      DB_URL: postgresql://app_rw:\$\{APP_RW_PASSWORD:-' "${COMPOSE_FILE}"
grep -Eq '^      OPERATION_DB_URL: postgresql://app_rw:' "${COMPOSE_FILE}"
grep -Eq '^      OPERATION_ADMIN_DB_URL: postgresql://' "${COMPOSE_FILE}"
grep -Eq '^      SERVICE_TOKEN: \$\{SERVICE_TOKEN:-' "${COMPOSE_FILE}"
grep -Eq '^      OPERATION_SYSTEM_USERNAME: \$\{OPERATION_SYSTEM_USERNAME:-' "${COMPOSE_FILE}"
grep -Eq '^      OPERATION_SYSTEM_PASSWORD: \$\{OPERATION_SYSTEM_PASSWORD:-' "${COMPOSE_FILE}"
grep -Eq '^      EXPOSE_PUBLIC_DOCS: \$\{EXPOSE_PUBLIC_DOCS:-' "${COMPOSE_FILE}"
grep -Eq 'AITEAM_JWT_ISSUER: \$\{AITEAM_JWT_ISSUER:-' "${COMPOSE_FILE}"
grep -Eq 'AITEAM_JWT_AUDIENCE: \$\{AITEAM_JWT_AUDIENCE:-' "${COMPOSE_FILE}"
grep -Eq 'MANAGER_CREDENTIAL_KEY' scripts/ctl.sh
grep -Eq '^      - "127\.0\.0\.1:\$\{POSTGRES_PORT:-' "${COMPOSE_FILE}"
grep -q '127.0.0.1:8001:8000' "${COMPOSE_FILE}"
grep -q '127.0.0.1:8002:8000' "${COMPOSE_FILE}"
grep -q 'aiteam-compose-guard' "${COMPOSE_FILE}"
grep -q 'init-postgres-databases.sh' "${COMPOSE_FILE}"
grep -q 'AITEAM_COMPOSE_MODE' "server/shared/app_factory.py"
grep -q 'scrub_agent_environment' scripts/ctl.sh
test -f deploy/docker/docker-compose.maintenance.yml
grep -q 'docker-compose.maintenance.yml' scripts/ctl.sh
grep -q 'OPERATOR_URL' scripts/ctl.sh
echo '[deploy-check] control-plane Compose secrets are parameterized and PostgreSQL is loopback-bound'

# Every image in the release Compose graph must have an immutable-looking
# version reference. Environment overrides are checked too, so CI catches a
# caller supplying :latest even when the checked-in fallback is safe.
images=()
while IFS= read -r image; do [[ -n "${image}" ]] && images+=("${image}"); done < <(docker compose -f "${COMPOSE_FILE}" --profile lightrag --profile newapi config --images)
(( ${#images[@]} )) || { echo '[deploy-check][ERR] Compose returned no images' >&2; exit 1; }
for image in "${images[@]}"; do
  if [[ "${image}" == *@sha256:* ]]; then
    [[ "${image}" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "[deploy-check][ERR] invalid image digest: ${image}" >&2; exit 1; }
    continue
  fi
  [[ "${image}" == *:* ]] || { echo "[deploy-check][ERR] unpinned image reference: ${image}" >&2; exit 1; }
  tag="${image##*:}"
  case "${tag}" in
    ""|latest|dev|test|edge)
      echo "[deploy-check][ERR] mutable/unpinned image reference: ${image}" >&2
      exit 1
      ;;
  esac
done
echo "[deploy-check] fixed image references OK (${#images[@]} images)"

# The LightRAG database operation is part of the release gate, but CI only runs
# its non-mutating bootstrap contract.
bash deploy/lightrag/init-db.sh --dry-run >/tmp/aiteam-lightrag-init-db.out
grep -q 'extension vector' /tmp/aiteam-lightrag-init-db.out
echo '[deploy-check] LightRAG PG bootstrap dry-run OK'
bash scripts/validate-lightrag-env.sh >/tmp/aiteam-lightrag-env.out
grep -q 'OK (non-mutating' /tmp/aiteam-lightrag-env.out
# Explicit local profile validation must not accept missing runtime DB fields;
# pool-only and disabled modes remain valid without local-profile settings.
if LIGHTRAG_IMAGE=ghcr.io/hkuds/lightrag:1.5.6 LIGHTRAG_URL=https://example.com LIGHTRAG_API_KEY=probe-probe-probe-probe LIGHTRAG_AUTH_ACCOUNTS='admin:{bcrypt}probe-probe-probe-probe' LIGHTRAG_TOKEN_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx LIGHTRAG_DB_HOST= LIGHTRAG_DB_PORT= LIGHTRAG_DB_NAME= LIGHTRAG_DB_USER= LIGHTRAG_DB_PASSWORD= scripts/validate-lightrag-env.sh --production >/tmp/aiteam-lightrag-local-missing-db.out 2>&1; then
  echo '[deploy-check][ERR] local LightRAG profile accepted missing runtime DB fields' >&2
  exit 1
fi
grep -q 'LIGHTRAG_DB_HOST is required' /tmp/aiteam-lightrag-local-missing-db.out
env -u LIGHTRAG_IMAGE -u LIGHTRAG_AUTH_ACCOUNTS -u LIGHTRAG_TOKEN_SECRET LIGHTRAG_URL=https://example.com LIGHTRAG_API_KEY=probe scripts/validate-lightrag-env.sh --production >/tmp/aiteam-lightrag-legacy.out
grep -q 'OK (non-mutating' /tmp/aiteam-lightrag-legacy.out
env -u LIGHTRAG_IMAGE -u LIGHTRAG_URL -u LIGHTRAG_API_KEY -u LIGHTRAG_AUTH_ACCOUNTS -u LIGHTRAG_TOKEN_SECRET LIGHTRAG_INSTANCES='[{"instance_id":"probe","url":"https://example.com","api_key":"probe"}]' scripts/validate-lightrag-env.sh --production >/tmp/aiteam-lightrag-pool.out
grep -q 'OK (non-mutating' /tmp/aiteam-lightrag-pool.out
env -u LIGHTRAG_IMAGE -u LIGHTRAG_URL -u LIGHTRAG_API_KEY -u LIGHTRAG_AUTH_ACCOUNTS -u LIGHTRAG_TOKEN_SECRET LIGHTRAG_INSTANCES= scripts/validate-lightrag-env.sh --production >/tmp/aiteam-lightrag-disabled.out
if LIGHTRAG_IMAGE=ghcr.io/hkuds/lightrag:1.5.6 LIGHTRAG_URL=https://example.com LIGHTRAG_API_KEY=probe-probe-probe-probe LIGHTRAG_AUTH_ACCOUNTS='admin:{bcrypt}CHANGE_ME_CHANGE_ME_CHANGE_ME' LIGHTRAG_TOKEN_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx LIGHTRAG_DB_HOST=127.0.0.1 LIGHTRAG_DB_PORT=5432 LIGHTRAG_DB_NAME=lightrag LIGHTRAG_DB_USER=lightrag LIGHTRAG_DB_PASSWORD=change_me_change_me_change_me scripts/validate-lightrag-env.sh --production >/tmp/aiteam-lightrag-placeholder.out 2>&1; then
  echo '[deploy-check][ERR] LightRAG placeholder credentials were accepted' >&2
  exit 1
fi
if AITEAM_ENV=production LIGHTRAG_DB_NAME=lightrag LIGHTRAG_DB_USER=lightrag LIGHTRAG_DB_ADMIN_USER=lightrag_admin LIGHTRAG_DB_PASSWORD=CHANGE_ME_CHANGE_ME_CHANGE_ME LIGHTRAG_DB_ADMIN_PASSWORD=CHANGE_ME_CHANGE_ME_CHANGE_ME deploy/lightrag/init-db.sh >/tmp/aiteam-lightrag-db-placeholder.out 2>&1; then
  echo '[deploy-check][ERR] LightRAG DB placeholder credentials were accepted' >&2
  exit 1
fi
grep -q 'OK (non-mutating' /tmp/aiteam-lightrag-disabled.out
bash scripts/lightrag-ops.sh --dry-run backup >/tmp/aiteam-lightrag-backup.out
bash scripts/lightrag-ops.sh --dry-run upgrade --image ghcr.io/hkuds/lightrag:1.5.6 >/tmp/aiteam-lightrag-upgrade.out
bash scripts/lightrag-ops.sh --dry-run rollback --image ghcr.io/hkuds/lightrag:1.5.6 >/tmp/aiteam-lightrag-rollback.out
echo '[deploy-check] LightRAG validate/backup/upgrade/rollback dry-runs OK'
bash scripts/newapi-ops.sh --dry-run backup >/tmp/aiteam-newapi-backup.out
bash scripts/newapi-ops.sh --dry-run restore --input /tmp/example-newapi.dump --yes >/tmp/aiteam-newapi-restore.out
bash scripts/newapi-ops.sh --dry-run upgrade --image calciumion/new-api:v1.0.0-rc.25@sha256:54a0b10924aa75fa5b5947208b820ced66b6ef4b445b35f122b31d80676aba2b --yes >/tmp/aiteam-newapi-upgrade.out
bash scripts/newapi-ops.sh --dry-run rollback --image calciumion/new-api:v1.0.0-rc.25@sha256:54a0b10924aa75fa5b5947208b820ced66b6ef4b445b35f122b31d80676aba2b --yes >/tmp/aiteam-newapi-rollback.out
! grep -Eq 'docker exec -[^\n]*-e[[:space:]]+"?PGPASSWORD=' scripts/newapi-ops.sh scripts/lightrag-ops.sh
 grep -q "read -r PGPASSWORD" scripts/newapi-ops.sh
 grep -q "read -r PGPASSWORD" scripts/lightrag-ops.sh
 echo '[deploy-check] NewAPI backup/restore/upgrade/rollback dry-runs OK'

# Reject credentials accidentally committed to deployment material while allowing
# variable references, generated-secret instructions, and explicit placeholders.
python3 - <<'PY'
import pathlib
import re
import sys

roots = [pathlib.Path(root) for root in ("deploy", "scripts", "docs/部署运维", ".github/workflows")]
files = sorted({path for root in roots if root.exists() for path in root.rglob("*") if path.is_file()})
private_key = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")
token_prefix = re.compile(r"(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{16,}")
secret_assignment = re.compile(
    r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:API_?KEY(?:_[A-Z0-9]+)*|ACCESS_?KEY(?:_[A-Z0-9]+)*|"
    r"PRIVATE_?KEY|CREDENTIALS?(?:_KEY)?|PASSWORD|PASSWD|SECRET(?:_[A-Z0-9]+)*|"
    r"TOKEN(?:_[A-Z0-9]+)*)\b\s*[:=]\s*(?P<value>[^#\s]+)",
    re.I,
)
safe_exact = {"postgres", "apprwpass", "aiteam_test", "aiteam_v1", "wrong-token", "your-strong-token", "***"}
safe_prefixes = (
    "dev-", "test-", "example-", "placeholder-", "changeme", "change-me",
    "<", "...", "your-", "wrong-",
)

def is_placeholder(value: str) -> bool:
    value = value.strip().strip("'\\\"").lower()
    return not value or value in safe_exact or value.startswith(safe_prefixes) or value.startswith("$")

violations = []
for path in files:
    name = path.as_posix()
    if name == "scripts/check-deploy.sh":
        continue
    for number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
        if private_key.search(line):
            violations.append(f"{name}:{number}")
            continue
        scan_line = re.sub(r"\$\{[^}]*\}", "", line)
        if token_prefix.search(scan_line):
            violations.append(f"{name}:{number}")
            continue
        for found in secret_assignment.finditer(scan_line):
            if not is_placeholder(found.group("value")):
                violations.append(f"{name}:{number}")
                break
if violations:
    print("[deploy-check][ERR] possible committed secret:", *violations, sep="\n", file=sys.stderr)
    sys.exit(1)
print("[deploy-check] static secret scan OK")
PY
if grep -Eq 'NEWAPI_BOOTSTRAP_(PASSWORD|TOKEN)=|python3 - .*\$value|python3 - .*\$NEWAPI_ADMIN' scripts/bootstrap-console-credentials.sh; then
  echo '[deploy-check][ERR] console bootstrap passes a secret through child argv/environment' >&2
  exit 1
fi
! grep -q 'SERVICE_TOKEN: dev-service-token-placeholder$' "${COMPOSE_FILE}"
echo '[deploy-check] console bootstrap and Compose service-token boundaries OK'

python3 - <<'PY'
from pathlib import Path
import re

compose = Path("deploy/docker/docker-compose.yml").read_text()
agent = re.search(r"(?ms)^  agent:\n.*?(?=^volumes:)", compose)
if not agent:
    raise SystemExit("[deploy-check][ERR] Agent service block is missing")
private_agent_keys = []
for line in agent.group(0).splitlines():
    if line.lstrip().startswith("#"):
        continue
    match = re.match(r"^\s+([A-Z][A-Z0-9_]*)\s*:", line)
    if match and (
        match.group(1).startswith("LIGHTRAG_")
        or match.group(1).startswith("HINDSIGHT_")
        or match.group(1).startswith("AITEAM_HINDSIGHT_")
        or "PRIVATE_KEY" in match.group(1)
    ):
        private_agent_keys.append(match.group(1))
if private_agent_keys:
    raise SystemExit("[deploy-check][ERR] Agent Compose environment contains Manager-only keys: " + ", ".join(private_agent_keys))
print("[deploy-check] Agent Compose credential boundary OK")
PY

grep -q -- '-u LIGHTRAG_DB_PASSWORD' scripts/ctl.sh
for key in SERVICE_TOKEN SERVICE_SECRET SERVICE_API_KEY SERVICE_APIKEY; do
  grep -q -- "-u ${key}" scripts/ctl.sh
done
grep -q -- '-u HINDSIGHT_SERVICE_TOKEN' scripts/ctl.sh
for key in HINDSIGHT_BASE_URL HINDSIGHT_FACADE_URL HINDSIGHT_LEASE_TTL_SECONDS; do
  grep -q -- "-u ${key}" scripts/ctl.sh
done
grep -q -- '-u AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY' scripts/ctl.sh
echo '[deploy-check] Agent local credential inheritance guards present'
python3 - <<'PY'
from pathlib import Path
import re

ctl = Path("scripts/ctl.sh").read_text()
blocks = {}
for service, next_service in (("manager", "operation"), ("operation", "agent"), ("agent", "")):
    start = f"\n    {service})\n      echo \"[ctl] Starting"
    if next_service:
        end = f"\n    {next_service})\n      echo \"[ctl] Starting"
        block = ctl.split(start, 1)[1].split(end, 1)[0]
    else:
        block = ctl.split(start, 1)[1].split("\n  esac", 1)[0]
    blocks[service] = block
required = (
    "HINDSIGHT_BASE_URL",
    "SERVICE_SECRET", "SERVICE_API_KEY", "SERVICE_APIKEY",
    "PROVIDER_URL", "PROVIDER_URI", "PROVIDER_API_KEY", "PROVIDER_TOKEN", "PROVIDER_SECRET",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "COHERE_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "PERPLEXITY_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "FIREWORKS_API_KEY", "HF_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
    "NEWAPI_BASE_URL", "NEWAPI_API_KEY", "NEWAPI_TOKEN",
    "DSN", "SQL_DSN", "CONNECTION_STRING", "REDIS_CONN_STRING", "API_KEY",
    "PASSWORD", "PASSWD", "DB_PASSWORD", "DATABASE_PASSWORD", "REDIS_PASSWORD", "MYSQL_PASSWORD", "MONGO_PASSWORD", "NEWAPI_PASSWORD", "SERVICE_PASSWORD", "PROVIDER_PASSWORD", "HINDSIGHT_PASSWORD", "LIGHTRAG_PASSWORD",
    "POSTGRES_PASSWORD", "POSTGRES_SUPER_PASSWORD",
)
missing = [f"{service}:{name}" for service, block in blocks.items() for name in required if f"-u {name}" not in block]
missing += [f"{service}:{name}" for service in ("operation", "agent") for name in ("HINDSIGHT_FACADE_URL", "HINDSIGHT_LEASE_TTL_SECONDS") if f"-u {name}" not in blocks[service]]
missing += [f"{service}:OPERATION_SYSTEM_USERNAME" for service in ("manager", "agent") if "-u OPERATION_SYSTEM_USERNAME" not in blocks[service]]
missing += [f"{service}:{name}" for service in ("operation", "agent") for name in ("OAUTH_GOOGLE_CLIENT_SECRET", "OAUTH_GITHUB_CLIENT_SECRET", "LOGIN_AUDIT_PEPPER") if f"-u {name}" not in blocks[service]]
if "export HINDSIGHT_FACADE_URL=" not in blocks["manager"] or "export HINDSIGHT_LEASE_TTL_SECONDS=" not in blocks["manager"]:
    missing.append("manager:HINDSIGHT facade/TTL export")
if missing:
    raise SystemExit("[deploy-check][ERR] tier environment scrub mismatch: " + ", ".join(missing))
print("[deploy-check] Manager/Operation/Agent scrub parity OK")
PY

# Keep stale Agent process groups from surviving a PID-file rotation. These are
# static assertions only; this gate never stops a live process.
grep -q 'setsid env' scripts/ctl.sh
grep -q 'process_group_alive' scripts/ctl.sh
grep -q 'kill -KILL -- "-${pid}"' scripts/ctl.sh
grep -q 'AITEAM_AGENT_SANDBOX_READY' scripts/ctl.sh
echo '[deploy-check] stale Agent PID/process-group and production launch guards present'

bash scripts/check-agent-sandbox.sh --dry-run >/tmp/aiteam-agent-sandbox-dry-run.out
grep -q 'native bwrap/Landlock/Seatbelt execution is deferred' /tmp/aiteam-agent-sandbox-dry-run.out
echo '[deploy-check] Agent sandbox dry-run entrypoint OK'
