#!/usr/bin/env bash
# Reproducible Agent sandbox gate. It never changes a taiyi service or contacts Manager.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
REQUIRE_NATIVE=1
LINUX_MATRIX=0

usage() {
  cat <<'EOF'
Usage: scripts/check-agent-sandbox.sh [--dry-run] [--linux-matrix] [--allow-unsupported]

The normal gate runs real Agent sandbox tests and fails when this host has no
functional native runner. Use --dry-run for CI/release planning without a
native spawn. --linux-matrix additionally executes both bwrap and Landlock on
Linux (the taiyi acceptance command). --allow-unsupported is for a developer
host only and lets the portable tests report a skip; it must not be used as a
production readiness signal.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --allow-unsupported) REQUIRE_NATIVE=0; shift ;;
    --linux-matrix) LINUX_MATRIX=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[agent-sandbox][ERR] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cmd=(pnpm --dir "${ROOT}/server/agent_service" exec tsx --test \
  src/launch-guards.test.ts src/pi/sandbox.test.ts src/pi/sandbox-platform.test.ts)
if (( DRY_RUN )); then
  if (( LINUX_MATRIX )); then
    printf '%s\n' "[agent-sandbox][dry-run] AITEAM_SANDBOX_REQUIRE_NATIVE=true AITEAM_SANDBOX_MATRIX=true ${cmd[*]}"
  else
    printf '%s\n' "[agent-sandbox][dry-run] AITEAM_SANDBOX_REQUIRE_NATIVE=true ${cmd[*]}"
  fi
  printf '%s\n' '[agent-sandbox][dry-run] native bwrap/Landlock/Seatbelt execution is deferred to the target host'
  exit 0
fi

if (( LINUX_MATRIX )) && [[ "$(uname -s)" != "Linux" ]]; then
  echo '[agent-sandbox][ERR] --linux-matrix requires a Linux host; unsupported platforms are not ready' >&2
  exit 1
fi

command -v pnpm >/dev/null 2>&1 || { echo '[agent-sandbox][ERR] pnpm is required' >&2; exit 127; }
if (( REQUIRE_NATIVE )); then
  if (( LINUX_MATRIX )); then
    AITEAM_SANDBOX_REQUIRE_NATIVE=true AITEAM_SANDBOX_MATRIX=true "${cmd[@]}"
  else
    AITEAM_SANDBOX_REQUIRE_NATIVE=true "${cmd[@]}"
  fi
else
  AITEAM_SANDBOX_REQUIRE_NATIVE=false "${cmd[@]}"
  printf '%s\n' '[agent-sandbox] portable contract passed; native readiness was not asserted'
  exit 0
fi
printf '%s\n' '[agent-sandbox] native sandbox gate passed'
