#!/usr/bin/env bash
# 本地改动分支覆盖门槛（#234 F2）：跑四包 vitest coverage + 合并 lcov.info + diff-cover ≥90%。
#
# 用法（从 web/ 目录运行）：
#   pnpm coverage:diff
# 或直接：
#   bash scripts/coverage-diff.sh [compare-branch] [fail-under]
#
# 依赖：pnpm、diff-cover（pip install diff-cover）。
set -euo pipefail

BRANCH="${1:-origin/master}"
THRESHOLD="${2:-90}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

cd "$ROOT"

echo "==> Running vitest with coverage (four packages)..."
pnpm --filter @aiteam/shared run build
pnpm -r exec vitest run --coverage

echo "==> Merging lcov.info with git-root-relative paths..."
MERGED="$(mktemp)"
for pkg in shared operation manager agent; do
  f="$pkg/coverage/lcov.info"
  if [ -f "$f" ]; then
    sed "s|^SF:src/|SF:web/$pkg/src/|" "$f" >> "$MERGED"
  fi
done

if [ ! -s "$MERGED" ]; then
  echo "::error::No lcov.info produced. Ensure vitest coverage is configured." >&2
  exit 2
fi

echo "==> diff-cover (compare-branch=$BRANCH, fail-under=$THRESHOLD)..."
diff-cover "$MERGED" --compare-branch="$BRANCH" --fail-under="$THRESHOLD"

rm -f "$MERGED"
echo "OK: 改动分支覆盖 ≥ $THRESHOLD%"
