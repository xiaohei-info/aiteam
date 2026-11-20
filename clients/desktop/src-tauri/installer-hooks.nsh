; Installer-time preparation of the built-in Git Bash.
;
; The Agent resolves its shell through `where bash.exe` on Windows; without Git for Windows it never
; reaches /readyz and the desktop reports BACKEND_HEALTH_TIMEOUT. The installer therefore fetches
; MinGit into <install>\gitbash (see resources\installer\fetch-gitbash.ps1) and the host prepends
; <install>\gitbash\usr\bin to the Agent PATH. Users must not have to install Git themselves.

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\gitbash\usr\bin\bash.exe" aiteam_gitbash_done
  DetailPrint "正在准备内置 Git Bash（约 40 MB，仅首次安装）..."
  IfFileExists "$INSTDIR\installer\fetch-gitbash.ps1" aiteam_gitbash_fetch
  DetailPrint "安装包缺少 installer\fetch-gitbash.ps1，跳过内置 bash"
  Goto aiteam_gitbash_done
  aiteam_gitbash_fetch:
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\installer\fetch-gitbash.ps1" -Destination "$INSTDIR\gitbash"'
  Pop $0
  StrCmp $0 "0" aiteam_gitbash_done
  IfSilent aiteam_gitbash_done
  MessageBox MB_ICONEXCLAMATION|MB_OK "内置 Git Bash 准备失败（错误码 $0）。$\r$\n应用仍会完成安装；若本机没有 Git for Windows，Agent 将无法就绪。$\r$\n可重新运行安装程序重试。"
  aiteam_gitbash_done:
!macroend

; The bundled tree is not part of the regular file list, so the uninstaller must remove it.
!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$INSTDIR\gitbash"
  RMDir /r "$INSTDIR\installer"
!macroend
