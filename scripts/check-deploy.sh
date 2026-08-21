#!/usr/bin/env bash
# Fast deployment-only quality gate used locally and in CI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

mapfile -t shell_files < <(find deploy scripts -type f -name '*.sh' -print | sort)
(( ${#shell_files[@]} )) || { echo '[deploy-check][ERR] no deployment shell files found' >&2; exit 1; }
for file in "${shell_files[@]}"; do
  bash -n "${file}"
done
echo "[deploy-check] bash syntax OK (${#shell_files[@]} files)"

docker compose -f deploy/docker/docker-compose.yml config --quiet
echo '[deploy-check] docker compose config OK (default profile; LightRAG is opt-in)'

# Reject credentials accidentally committed to deploy material while allowing
# variable references, generated-secret instructions, and explicit placeholders.
python3 - <<'PY'
import pathlib, re, subprocess, sys

files = subprocess.check_output(
    ["git", "ls-files", "deploy", "scripts", "docs/部署运维", ".github/workflows"],
    text=True,
).splitlines()
patterns = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{16,}"),
    re.compile(r"LIGHTRAG_(?:API_KEY|DB_(?:PASSWORD|ADMIN_PASSWORD))\s*[:=]\s*(?!\$\{|['\"<]|$)[^#\s]+"),
]
violations = []
for name in files:
    path = pathlib.Path(name)
    if not path.is_file():
        continue
    for number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
        # Compose/shell variable references are safe placeholders; remove them
        # before looking for a literal value (including nested `${...}` names).
        scan_line = re.sub(r"\$\{[^}]*\}", "", line)
        if any(pattern.search(scan_line) for pattern in patterns):
            violations.append(f"{name}:{number}")
if violations:
    print("[deploy-check][ERR] possible committed secret:", *violations, sep="\n", file=sys.stderr)
    sys.exit(1)
print("[deploy-check] static secret scan OK")
PY
