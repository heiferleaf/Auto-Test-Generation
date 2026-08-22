@echo off
REM 以调试端口启动 WorkBuddy，开放 CDP 供自动化平台连接。
REM 用法：双击本文件，或命令行 call scripts\launch-workbuddy.cmd
REM 验证：浏览器打开 http://localhost:9233/json 看到目标列表即成功。
set WORKBUDDY_EXE="C:\Users\harveyhfye\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe"
set CDP_PORT=9233

if not exist %WORKBUDDY_EXE% (
  echo [错误] 未找到 WorkBuddy 可执行文件：%WORKBUDDY_EXE%
  echo 请确认安装路径，或修改本脚本的 WORKBUDDY_EXE。
  pause
  exit /b 1
)

echo 正在以 --remote-debugging-port=%CDP_PORT% 启动 WorkBuddy...
start "" %WORKBUDDY_EXE% --remote-debugging-port=%CDP_PORT%

echo 已启动。请在浏览器打开 http://localhost:%CDP_PORT%/json 验证调试端口是否开放。
echo 验证成功后，即可运行集成测试：npx vitest run test/integration-workbuddy.test.ts
pause
