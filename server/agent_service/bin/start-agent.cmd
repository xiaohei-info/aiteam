@echo off
setlocal
rem Node on Windows accepts only file:// URLs or relative specifiers for --import; a
rem drive-letter path is parsed as a URL scheme and rejected. Run from the package root
rem and pass a relative specifier: it resolves against the working directory and needs no
rem percent-encoding, so '#', '%', spaces and non-ASCII in the install directory all work.
rem A hand-built file:// URL has to encode '#' (otherwise it starts a fragment) and '%'
rem (otherwise it is URL-decoded), which cmd cannot express reliably.
rem The desktop host already launches the Agent with the package root as its working
rem directory, so this keeps both entry points consistent.
cd /d "%~dp0.."
"%~dp0..\runtime\node.exe" --import "./node_modules/tsx/dist/esm/index.mjs" "%~dp0..\bin\start-agent.mjs" %*
exit /b %ERRORLEVEL%
