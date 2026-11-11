#!/usr/bin/env bash
# Install apt packages while tolerating GitHub runner mirror outages.
#
# GitHub-hosted Ubuntu runners occasionally cannot resolve the default Ubuntu mirrors
# (azure.archive.ubuntu.com / archive.ubuntu.com / security.ubuntu.com). apt then waits
# through very long DNS timeouts, so a step that should fail within seconds can hang for
# the better part of an hour and stall the whole workflow. This script bounds each attempt,
# retries, and finally rewrites the apt sources to a public mirror before giving up.
#
# Usage:
#   apt-with-fallback.sh --refresh-only        # make `apt-get update` work, install nothing
#   apt-with-fallback.sh <package> [<package> …] # refresh, then install the packages
#
# The rewritten sources persist for the rest of the job, so later apt runs (for example
# Playwright's `--with-deps`) pick up the working mirror automatically.
set -uo pipefail

# Public mirrors to try when the runner's defaults are unreachable. Order matters: these
# are globally reachable and mirror the full archive, including the security pocket.
FALLBACK_MIRRORS=(
  "mirrors.aliyun.com"
  "mirrors.cloud.tencent.com"
  "mirrors.tuna.tsinghua.edu.cn"
)

# Keep each network attempt short so an unreachable mirror fails fast instead of hanging.
APT_OPTIONS="-o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20"

refresh() {
  sudo apt-get ${APT_OPTIONS} update
}

install() {
  sudo apt-get install --no-install-recommends -y "$@"
}

# Point every apt source at the given mirror. Ubuntu keeps sources in
# /etc/apt/sources.list (one-line format) and /etc/apt/sources.list.d/ubuntu.sources
# (deb822 format); rewriting both keeps the change complete.
use_mirror() {
  local mirror="$1"
  sudo find /etc/apt/sources.list /etc/apt/sources.list.d -type f \
    -exec sed -i \
      -e "s|azure\.archive\.ubuntu\.com|${mirror}|g" \
      -e "s|archive\.ubuntu\.com|${mirror}|g" \
      -e "s|security\.ubuntu\.com|${mirror}|g" {} +
}

try_refresh() {
  if refresh; then
    return 0
  fi
  for mirror in "${FALLBACK_MIRRORS[@]}"; do
    echo "Default Ubuntu mirrors unreachable; retrying via ${mirror}"
    use_mirror "${mirror}"
    if refresh; then
      echo "apt is reachable via ${mirror}"
      return 0
    fi
    echo "::warning::apt is still unreachable via ${mirror}"
  done
  return 1
}

if [ "${1:-}" = "--refresh-only" ]; then
  if ! try_refresh; then
    echo "::error::apt-get update failed with the default mirrors and every fallback mirror"
    exit 1
  fi
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "usage: apt-with-fallback.sh [--refresh-only] [<package> …]" >&2
  exit 2
fi

if ! try_refresh; then
  echo "::error::apt-get update failed with the default mirrors and every fallback mirror"
  exit 1
fi

if ! install "$@"; then
  echo "::error::apt-get install failed for: $*"
  exit 1
fi
