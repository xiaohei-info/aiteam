#!/bin/bash
# macOS 测试版修复工具：清除下载隔离属性并重新进行本地临时签名。
# 不会修复损坏文件、完成 Apple 公证或关闭 Gatekeeper。

export PATH=/usr/bin:/bin:/usr/sbin:/sbin

finish() {
  printf '\n按回车键关闭此窗口……'
  IFS= read -r _
  exit "$1"
}

printf '\n=== macOS 测试版应用临时放行 ===\n\n'
printf '本工具移除下载隔离标记，并以本地临时签名替换所选应用的现有签名。\n'
printf '它不会修复损坏文件，也不代表完成 Apple 公证。\n'
printf '请只选择开发者直接提供、来源可信的应用。\n'
printf '如系统提示应用包含恶意软件，请取消，不要绕过。\n\n'

if [ "$(/usr/bin/uname -s)" != "Darwin" ]; then
  printf '此脚本仅适用于 macOS。\n'
  finish 1
fi

APP_PATH=$(/usr/bin/osascript <<'APPLESCRIPT'
set selectedApp to choose file with prompt "请选择已复制到“应用程序”文件夹中的可信测试应用" of type {"com.apple.application-bundle"} default location (path to applications folder)
return POSIX path of selectedApp
APPLESCRIPT
)
if [ "$?" -ne 0 ] || [ -z "$APP_PATH" ]; then
  printf '\n已取消选择，未进行修改。\n'
  finish 0
fi

APP_PATH=${APP_PATH%/}
case "$APP_PATH" in
  *.app) ;;
  *) printf '选择的目标不是 .app 应用，已停止。\n'; finish 1 ;;
esac
if [ ! -d "$APP_PATH" ] || [ -L "$APP_PATH" ]; then
  printf '目标不存在或为符号链接，请选择实际的应用。\n'
  finish 1
fi
case "$APP_PATH" in
  /Volumes/*)
    printf '请先将应用从 DMG 或外置卷复制到“应用程序”文件夹，再运行本工具。\n'
    finish 1 ;;
  /System/*)
    printf '不允许对系统目录中的应用执行此操作。\n'
    finish 1 ;;
esac

printf '\n所选应用：%s\n' "$APP_PATH"
printf '请先退出该应用。确认信任它、移除下载隔离标记并替换为本地临时签名？[y/N] '
IFS= read -r CONFIRM
case "$CONFIRM" in
  y|Y) ;;
  *) printf '已取消，未进行修改。\n'; finish 0 ;;
esac

if ! /usr/bin/xattr -dr com.apple.quarantine "$APP_PATH"; then
  printf '\n普通权限操作未能全部完成；部分文件可能已处理。\n'
  printf '如果上方报错是权限不足，可以授权管理员权限重试。\n'
  printf '如果是只读文件系统或文件不存在，请取消并重新复制应用。\n'
  printf '是否使用管理员权限重试同一个应用？[y/N] '
  IFS= read -r ADMIN_CONFIRM
  case "$ADMIN_CONFIRM" in
    y|Y)
      printf '\n请输入这台 Mac 的管理员密码（输入时不会显示字符）。\n'
      if ! /usr/bin/sudo /usr/bin/xattr -dr com.apple.quarantine "$APP_PATH"; then
        printf '\n操作未完成。请将上方报错截图发给开发者，不要关闭系统防护。\n'
        finish 1
      fi
      ;;
    *) printf '已停止，未执行管理员权限重试。\n'; finish 1 ;;
  esac
fi

printf '\n隔离标记清除命令已执行完成，正在重新进行本地临时签名……\n'
if ! /usr/bin/codesign --force --deep --sign - "$APP_PATH"; then
  printf '\n临时签名未完成；部分文件的签名可能已修改。\n'
  printf '仅当上方报错为权限不足时，可使用管理员权限重试。\n'
  printf '是否使用管理员权限重新签名同一个应用？[y/N] '
  IFS= read -r SIGN_ADMIN_CONFIRM
  case "$SIGN_ADMIN_CONFIRM" in
    y|Y)
      printf '\n请输入这台 Mac 的管理员密码（输入时不会显示字符）。\n'
      if ! /usr/bin/sudo /usr/bin/codesign --force --deep --sign - "$APP_PATH"; then
        printf '\n临时签名失败。请将上方报错发给开发者，必要时重新复制应用。\n'
        finish 1
      fi
      ;;
    *) printf '已停止，临时签名未完成。请将上方报错发给开发者。\n'; finish 1 ;;
  esac
fi

printf '\n正在检查签名完整性：\n\n'
if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1; then
  printf '\n签名检查未通过，请将上方结果发给开发者，暂不要打开应用。\n'
  finish 1
fi
printf '\n本地临时签名完整性检查通过，请手动打开应用。\n'
printf '这不等同于 Developer ID 签名、Apple 公证或安全认证。\n'
finish 0
