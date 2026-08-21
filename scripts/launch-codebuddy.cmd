@echo off
REM 以调试端口启动 CodeBuddy CN，开放 CDP 供自动化平台连接。
REM 用法：双击本文件，或命令行 call scripts\launch-codebuddy.cmd
REM 验证：浏览器打开 http://localhost:9222/json 看到目标列表即成功。

set CODEBUDDY_EXE="C:\Users\harveyhfye\AppData\Local\Programs\CodeBuddy CN\CodeBuddy CN.exe"
set CDP_PORT=9222

if not exist %CODEBUDDY_EXE% (
  echo [错误] 未找到 CodeBuddy 可执行文件：%CODEBUDDY_EXE%
  echo 请确认安装路径，或修改本脚本的 CODEBUDDY_EXE。
  pause
  exit /b 1
)

echo 正在以 --remote-debugging-port=%CDP_PORT% 启动 CodeBuddy...
start "" %CODEBUDDY_EXE% --remote-debugging-port=%CDP_PORT%

echo 已启动。请在浏览器打开 http://localhost:%CDP_PORT%/json 验证调试端口是否开放。
echo 验证成功后，即可运行集成测试：npx vitest run test/integration-codebuddy.test.ts
pause
