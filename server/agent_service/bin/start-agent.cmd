@echo off
setlocal
set "ROOT=%~dp0.."
"%ROOT%\runtime\node.exe" --import "%ROOT%\node_modules\tsx\dist\esm\index.mjs" "%ROOT%\bin\start-agent.mjs" %*
exit /b %ERRORLEVEL%
