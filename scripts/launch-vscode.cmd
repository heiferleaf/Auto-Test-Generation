@echo off
setlocal EnableDelayedExpansion
REM Launch VS Code (Electron) with a CDP debug port for this platform.
REM ASCII-only on purpose: cmd.exe parses .cmd source as the system ANSI
REM code page (GBK/CP936 on Chinese Windows), not UTF-8. Non-ASCII bytes
REM can swallow CR and turn REM/echo lines into random commands.
REM
REM Usage: double-click, or call scripts\launch-vscode.cmd
REM Verify: open http://localhost:9244/json and look for a target list.
REM
REM Environment:
REM   VSCODE_EXE    override path to Code.exe
REM   CDP_PORT      override port, default 9244 (avoid CodeBuddy 9222 / WorkBuddy 9233)
REM   ATG_NOPAUSE=1 skip pause (for automation). Any script argument also skips pause.

if not defined CDP_PORT set CDP_PORT=9244
set "USER_DATA=%TEMP%\atg-vscode-cdp"
set "EXE="

REM Skip pause for automation: ATG_NOPAUSE=1, or any argument (e.g. nopause).
set "DO_PAUSE=1"
if defined ATG_NOPAUSE if /I not "%ATG_NOPAUSE%"=="0" set "DO_PAUSE="
if not "%~1"=="" set "DO_PAUSE="

if defined VSCODE_EXE (
  set "EXE=%VSCODE_EXE:"=%"
  goto :check_exe
)

if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" (
  set "EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
  goto :check_exe
)
if exist "%ProgramFiles%\Microsoft VS Code\Code.exe" (
  set "EXE=%ProgramFiles%\Microsoft VS Code\Code.exe"
  goto :check_exe
)
if exist "%ProgramFiles(x86)%\Microsoft VS Code\Code.exe" (
  set "EXE=%ProgramFiles(x86)%\Microsoft VS Code\Code.exe"
  goto :check_exe
)
if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe" (
  set "EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe"
  goto :check_exe
)
if exist "%ProgramFiles%\Microsoft VS Code Insiders\Code - Insiders.exe" (
  set "EXE=%ProgramFiles%\Microsoft VS Code Insiders\Code - Insiders.exe"
  goto :check_exe
)
if exist "%USERPROFILE%\scoop\apps\vscode\current\Code.exe" (
  set "EXE=%USERPROFILE%\scoop\apps\vscode\current\Code.exe"
  goto :check_exe
)

for /f "delims=" %%I in ('where code 2^>nul') do (
  set "WHERE_CODE=%%I"
  goto :from_where
)

echo [error] VS Code (Code.exe) was not found.
echo Install VS Code, or set VSCODE_EXE to the Code.exe path.
echo Do not use the Cursor IDE process as the target (the debug port would hit this IDE).
call :maybe_pause
exit /b 1

:from_where
call :resolve_from_where
if defined EXE if exist "!EXE!" goto :check_exe
echo [error] where code returned %WHERE_CODE%, could not resolve Code.exe.
echo Set VSCODE_EXE to the Code.exe path.
call :maybe_pause
exit /b 1

:resolve_from_where
REM Direct exe (Code.exe or Code - Insiders.exe).
if /I "%WHERE_CODE:~-4%"==".exe" (
  if exist "%WHERE_CODE%" set "EXE=%WHERE_CODE%"
  goto :eof
)

for %%P in ("%WHERE_CODE%") do (
  set "WHERE_DIR=%%~dpP"
  set "WHERE_NAME=%%~nP"
)

REM ...\bin\code or ...\bin\code.cmd -> parent of bin\Code.exe
REM where.exe on this machine returns D:\Microsoft VS Code\bin\code (no suffix).
if /I "!WHERE_NAME!"=="code" (
  if exist "!WHERE_DIR!..\Code.exe" (
    for %%P in ("!WHERE_DIR!..\Code.exe") do set "EXE=%%~fP"
    goto :eof
  )
  if exist "!WHERE_DIR!..\Code - Insiders.exe" (
    for %%P in ("!WHERE_DIR!..\Code - Insiders.exe") do set "EXE=%%~fP"
    goto :eof
  )
  if exist "!WHERE_DIR!Code.exe" (
    set "EXE=!WHERE_DIR!Code.exe"
    goto :eof
  )
)

REM Last resort: Code.exe anywhere under the install root (parent of bin\).
for %%P in ("!WHERE_DIR!..") do set "INSTALL_ROOT=%%~fP"
if exist "!INSTALL_ROOT!\Code.exe" (
  set "EXE=!INSTALL_ROOT!\Code.exe"
  goto :eof
)
if exist "!INSTALL_ROOT!" (
  for /r "!INSTALL_ROOT!" %%F in (Code.exe) do (
    set "EXE=%%F"
    goto :eof
  )
)
goto :eof

:check_exe
if not exist "%EXE%" (
  echo [error] VS Code executable not found: %EXE%
  echo Confirm the install path, or set VSCODE_EXE.
  call :maybe_pause
  exit /b 1
)

echo Starting VS Code with --remote-debugging-port=%CDP_PORT% ...
echo Executable: %EXE%
echo Isolated user-data-dir: %USER_DATA%
echo Using a separate user-data-dir so an already-running VS Code does not ignore the debug-port flag.
start "" "%EXE%" --remote-debugging-port=%CDP_PORT% --user-data-dir="%USER_DATA%" --disable-workspace-trust

echo Started. Open http://localhost:%CDP_PORT%/json to verify the debug port.
echo After that: set VSCODE_LIVE=1 ^&^& npm test -- test/integration-vscode.test.ts
echo (integration test not landed yet; confirm /json lists targets first.)
call :maybe_pause
endlocal
goto :eof

:maybe_pause
if defined DO_PAUSE pause
goto :eof
