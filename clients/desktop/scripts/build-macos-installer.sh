#!/bin/bash
# Build the Tauri app, code sign it with a Developer ID identity, notarize it with
# Apple, then place installation helpers at the DMG root.
#
# 签名身份解析顺序：APPLE_SIGNING_IDENTITY → 钥匙串里第一个 Developer ID Application。
# 公证凭据来自 notarytool 钥匙串条目（默认 AIFred-notary，可用 APPLE_NOTARY_PROFILE 覆盖）。
# 找不到签名身份时降级为未签名构建，并在 DMG 里附带临时放行脚本。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ "$(uname -s)" != Darwin ]; then
  printf '此命令仅支持 macOS。\n' >&2
  exit 1
fi

PROFILE=release
BUILD_ARGS=()
NOTARIZE=1
for ARG in "$@"; do
  case "$ARG" in
    --debug) PROFILE=debug; BUILD_ARGS=(--debug) ;;
    --skip-notarize) NOTARIZE=0 ;;
    *)
      printf '不支持的参数：%s\n用法：pnpm tauri:build:mac:installer [--debug] [--skip-notarize]\n' "$ARG" >&2
      exit 1
      ;;
  esac
done

# Notarization is only meaningful for release installers; debug builds are dev-only.
if [ "$PROFILE" != release ]; then
  NOTARIZE=0
fi

NOTARY_PROFILE="${APPLE_NOTARY_PROFILE:-AIFred-notary}"
ENTITLEMENTS_APP="$ROOT/src-tauri/Entitlements.plist"
ENTITLEMENTS_AGENT="$ROOT/src-tauri/Entitlements.agent.plist"

# Avoid stale absolute paths in the old target directory after a project move.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target-fresh.noindex}"
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

# ---------- 签名身份 ----------

SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [ -z "$SIGN_IDENTITY" ]; then
  SIGN_IDENTITY=$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null \
    | /usr/bin/sed -n 's/.*"\(Developer ID Application: [^"]*\)"/\1/p' | head -1)
fi

if [ -n "$SIGN_IDENTITY" ]; then
  # Tauri 在打包阶段用它给主程序与内嵌框架签名。
  export APPLE_SIGNING_IDENTITY="$SIGN_IDENTITY"
  printf '签名身份：%s\n' "$SIGN_IDENTITY"
else
  printf '未找到 Developer ID Application 身份，本次构建不签名、不公证。\n' >&2
  NOTARIZE=0
fi

# A customer DMG cannot rely on the per-user agent.env: the packaged sidecar must
# carry a complete enterprise config, or the Agent refuses to start on their Mac.
pnpm check:agent-package

pnpm tauri build --bundles app ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
APP="$CARGO_TARGET_DIR/$PROFILE/bundle/macos/$PRODUCT.app"
if [ ! -d "$APP" ]; then
  printf '未找到构建产物：%s\n请检查 Cargo 是否配置了其他 target。\n' "$APP" >&2
  exit 1
fi

# ---------- 内嵌代码签名（由内向外） ----------

sign_nested_code() {
  local app="$1"
  local file
  local count=0
  while IFS= read -r -d '' file; do
    # Only Mach-O files need a signature; shell scripts and docs in the bundle do not.
    if ! /usr/bin/file -b "$file" | /usr/bin/grep -q 'Mach-O'; then
      continue
    fi
    if [ "$file" = "$app/Contents/Resources/agent/runtime/node" ]; then
      /usr/bin/codesign --force --options runtime --timestamp \
        --entitlements "$ENTITLEMENTS_AGENT" --sign "$SIGN_IDENTITY" "$file"
    else
      /usr/bin/codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$file"
    fi
    count=$((count + 1))
  done < <(/usr/bin/find "$app/Contents" -type f \
    \( -name '*.node' -o -name '*.dylib' -o -name '*.so' -o -name 'node' -o -perm -u+x \) -print0 2>/dev/null)
  printf '已签名内嵌可执行文件：%s 个\n' "$count"

  # Re-sign the bundle last so its resource seal matches the freshly signed files.
  /usr/bin/codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS_APP" --sign "$SIGN_IDENTITY" "$app"
}

verify_app() {
  local app="$1"
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
  /usr/bin/codesign --display --verbose=4 "$app" 2>&1 \
    | /usr/bin/grep -E '^(Authority|TeamIdentifier|Timestamp)=' || true
}

if [ -n "$SIGN_IDENTITY" ]; then
  sign_nested_code "$APP"
  verify_app "$APP"
fi

# ---------- 公证 ----------

# The notary service occasionally drops a multipart upload on slow links; a fresh
# submission is the documented recovery, so retry instead of failing the build.
notarize_target() {
  local target="$1"
  local attempt=1
  while [ "$attempt" -le 3 ]; do
    if /usr/bin/xcrun notarytool submit "$target" \
      --keychain-profile "$NOTARY_PROFILE" --wait; then
      return 0
    fi
    printf '第 %s 次公证提交失败，重新提交……\n' "$attempt" >&2
    attempt=$((attempt + 1))
    sleep 30
  done
  printf '公证连续 3 次提交失败，请检查网络后重跑。\n' >&2
  return 1
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/aifred-installer.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

if [ "$NOTARIZE" = 1 ]; then
  # Also notarize and staple the .app itself: the DMG ticket does not travel with a
  # copied-out app, so an app without its own ticket needs a network round trip on
  # its first launch. Two submissions per release is the price of offline-safe installs.
  /usr/bin/ditto -c -k --keepParent "$APP" "$WORK/app.zip"
  notarize_target "$WORK/app.zip"
  /usr/bin/xcrun stapler staple "$APP"
  /usr/bin/xcrun stapler validate "$APP"
fi

# ---------- 组装 DMG ----------

mkdir "$WORK/staging"
# ditto preserves the app structure; never modify files inside the signed app.
/usr/bin/ditto "$APP" "$WORK/staging/$PRODUCT.app"
ln -s /Applications "$WORK/staging/Applications"
if [ -n "$SIGN_IDENTITY" ]; then
  cp "$ROOT/installer/macos/安装说明-已签名.txt" "$WORK/staging/安装说明.txt"
else
  cp "$ROOT/installer/macos/修复应用无法打开.command" "$WORK/staging/修复应用无法打开.command"
  cp "$ROOT/installer/macos/安装说明.txt" "$WORK/staging/安装说明.txt"
  chmod 755 "$WORK/staging/修复应用无法打开.command"
fi

OUTPUT_DIR="$CARGO_TARGET_DIR/$PROFILE/bundle/dmg"
mkdir -p "$OUTPUT_DIR"
SUFFIX=""
if [ -z "$SIGN_IDENTITY" ]; then
  SUFFIX="_with-helper"
fi
OUTPUT="$OUTPUT_DIR/${PRODUCT}_${VERSION}_${ARCH}_${PROFILE}${SUFFIX}.dmg"
/usr/bin/hdiutil create -volname "$PRODUCT Installer" \
  -srcfolder "$WORK/staging" -format UDZO -fs HFS+ "$WORK/installer.dmg"
/usr/bin/hdiutil verify "$WORK/installer.dmg"
# Sign the disk image itself so `spctl -t open` has a primary signature to check;
# this must happen before notarization because the ticket binds to the file hash.
if [ -n "$SIGN_IDENTITY" ]; then
  /usr/bin/codesign --force --timestamp --sign "$SIGN_IDENTITY" "$WORK/installer.dmg"
fi
# Replace the previous custom installer only after creation and verification succeed.
mv -f "$WORK/installer.dmg" "$OUTPUT"

if [ "$NOTARIZE" = 1 ]; then
  # 公证 DMG 本体就够了：Apple 的票据覆盖盘内的 AIFred.app，stapling 后离线也能校验。
  notarize_target "$OUTPUT"
  /usr/bin/xcrun stapler staple "$OUTPUT"
  /usr/bin/xcrun stapler validate "$OUTPUT"
  /usr/sbin/spctl -a -vvv -t open --context context:primary-signature "$OUTPUT"
fi

printf '\n安装包已生成：\n%s\n' "$OUTPUT"
if [ -n "$SIGN_IDENTITY" ]; then
  if [ "$NOTARIZE" = 1 ]; then
    printf '已使用 Developer ID 签名并通过 Apple 公证，用户下载后可双击直接打开。\n'
  else
    printf '已使用 Developer ID 签名，但未公证（用户首次打开需右键 → 打开）。\n'
  fi
else
  printf '此 DMG 未签名也未公证，附带临时放行脚本，不是正式签名方案。\n'
fi
