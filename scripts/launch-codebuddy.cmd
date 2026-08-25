@echo off
REM Launch CodeBuddy CN with a CDP debug port for the automation platform.
REM ASCII-only on purpose: cmd.exe parses .cmd source as the system ANSI
REM code page (GBK/CP936 on Chinese Windows), not UTF-8.
REM Usage: double-click this file, or call scripts\launch-codebuddy.cmd
REM Verify: open http://localhost:9222/json and look for a target list.

set CODEBUDDY_EXE="C:\Users\harveyhfye\AppData\Local\Programs\CodeBuddy CN\CodeBuddy CN.exe"
set CDP_PORT=9222

if not exist %CODEBUDDY_EXE% (
  echo [error] CodeBuddy executable not found: %CODEBUDDY_EXE%
  echo Confirm the install path, or edit CODEBUDDY_EXE in this script.
  pause
  exit /b 1
)

echo Starting CodeBuddy with --remote-debugging-port=%CDP_PORT% ...
start "" %CODEBUDDY_EXE% --remote-debugging-port=%CDP_PORT%

echo Started. Open http://localhost:%CDP_PORT%/json to verify the debug port.
echo After that, run integration tests: npx vitest run test/integration-codebuddy.test.ts
pause
