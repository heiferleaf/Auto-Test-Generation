@echo off
REM Launch WorkBuddy with a CDP debug port for the automation platform.
REM ASCII-only on purpose: cmd.exe parses .cmd source as the system ANSI
REM code page (GBK/CP936 on Chinese Windows), not UTF-8.
REM Usage: double-click this file, or call scripts\launch-workbuddy.cmd
REM Verify: open http://localhost:9233/json and look for a target list.
set WORKBUDDY_EXE="C:\Users\harveyhfye\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe"
set CDP_PORT=9233

if not exist %WORKBUDDY_EXE% (
  echo [error] WorkBuddy executable not found: %WORKBUDDY_EXE%
  echo Confirm the install path, or edit WORKBUDDY_EXE in this script.
  pause
  exit /b 1
)

echo Starting WorkBuddy with --remote-debugging-port=%CDP_PORT% ...
start "" %WORKBUDDY_EXE% --remote-debugging-port=%CDP_PORT%

echo Started. Open http://localhost:%CDP_PORT%/json to verify the debug port.
echo After that, run integration tests: npx vitest run test/integration-workbuddy.test.ts
pause
