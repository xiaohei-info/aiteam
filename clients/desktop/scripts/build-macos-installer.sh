#!/bin/bash
# Build the Tauri app, then place installation helpers at the DMG root.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ "$(uname -s)" != Darwin ]; then
  printf '此命令仅支持 macOS。\n' >&2
  exit 1
fi

PROFILE=release
BUILD_ARGS=()
for ARG in "$@"; do
  case "$ARG" in
    --debug) PROFILE=debug; BUILD_ARGS=(--debug) ;;
    *) printf '不支持的参数：%s\n用法：pnpm tauri:build:mac:installer [--debug]\n' "$ARG" >&2; exit 1 ;;
  esac
done

# Avoid stale absolute paths in the old target directory after a project move.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target-fresh}"
case "$CARGO_TARGET_DIR" in
  /*) ;;
  *) export CARGO_TARGET_DIR="$ROOT/$CARGO_TARGET_DIR" ;;
esac
# A cross target would change Cargo output paths and the embedded Agent must match.
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  printf '此命令仅支持本机架构，请先取消 CARGO_BUILD_TARGET。\n' >&2
  exit 1
fi

PRODUCT=$(node -p "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')).productName")
VERSION=$(node -p "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')).version")
case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x64 ;;
  *) printf '不支持的主机架构。\n' >&2; exit 1 ;;
esac

# A customer DMG cannot rely on the per-user agent.env: the packaged sidecar must
# carry a complete enterprise config, or the Agent refuses to start on their Mac.
pnpm check:agent-package

pnpm tauri build --bundles app ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
APP="$CARGO_TARGET_DIR/$PROFILE/bundle/macos/$PRODUCT.app"
if [ ! -d "$APP" ]; then
  printf '未找到构建产物：%s\n请检查 Cargo 是否配置了其他 target。\n' "$APP" >&2
  exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/aifred-installer.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/staging"
# ditto preserves the app structure; never modify files inside the signed app.
/usr/bin/ditto "$APP" "$WORK/staging/$PRODUCT.app"
ln -s /Applications "$WORK/staging/Applications"
cp "$ROOT/installer/macos/修复应用无法打开.command" "$WORK/staging/修复应用无法打开.command"
cp "$ROOT/installer/macos/安装说明.txt" "$WORK/staging/安装说明.txt"
chmod 755 "$WORK/staging/修复应用无法打开.command"

OUTPUT_DIR="$CARGO_TARGET_DIR/$PROFILE/bundle/dmg"
mkdir -p "$OUTPUT_DIR"
OUTPUT="$OUTPUT_DIR/${PRODUCT}_${VERSION}_${ARCH}_${PROFILE}_with-helper.dmg"
/usr/bin/hdiutil create -volname "$PRODUCT Installer" \
  -srcfolder "$WORK/staging" -format UDZO -fs HFS+ "$WORK/installer.dmg"
/usr/bin/hdiutil verify "$WORK/installer.dmg"
# Replace the previous custom installer only after creation and verification succeed.
mv -f "$WORK/installer.dmg" "$OUTPUT"
printf '\n安装包已生成（含临时放行脚本与说明）：\n%s\n' "$OUTPUT"
printf '此 DMG 未额外签名或公证，脚本不是正式签名方案。\n'
