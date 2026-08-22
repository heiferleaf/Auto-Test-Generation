# WorkBuddy 集成测试预期结果

> 本文件声明针对 WorkBuddy 真机的"预期结果"，集成测试运行时生成报告对照。

## 预期

1. 连接 `http://localhost:9233`（WorkBuddy 调试端口）成功，且能枚举目标。
2. 目标中至少包含 1 个 `page` 类型与若干 `webview` 类型（IDE 多面板结构）。
3. 主窗口截图字节数 > 0（非空白窗口）。
4. 存在至少一个 webview 的内层 execution context 中含 `[role=textbox]` 输入框，
   证明方案 C 在第二款 Electron 应用上同样可达沙箱 UI（通用性验证）。

## 非预期（应判失败）

- 连接失败（端口未开 / 应用未以 `--remote-debugging-port=9233` 启动）。
- 枚举不到任何 webview。
- 所有 webview 内层均无 `[role=textbox]`（说明内层 context 切换失效）。
