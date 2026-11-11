@echo off
setlocal
set "ROOT=%~dp0.."
rem Node on Windows only accepts file:// URLs for --import, not drive-letter paths.
set "TSX_URL=file:///%ROOT:\=/%/node_modules/tsx/dist/esm/index.mjs"
"%ROOT%\runtime\node.exe" --import "%TSX_URL%" "%ROOT%\bin\start-agent.mjs" %*
exit /b %ERRORLEVEL%
