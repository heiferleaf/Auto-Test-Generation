// 集成测试（WorkBuddy 真机）：验证方案 C 在第二款 Electron 应用上同样通用。
// 测试先行：本文件与"预期结果说明文件"先于/独立于实现存在。
//
// 运行方式：
//   1) 先启动 WorkBuddy 调试端口：双击 scripts/launch-workbuddy.cmd，
//      浏览器打开 http://localhost:9233/json 看到目标列表即成功。
//   2) 启用真机： set WORKBUDDY_LIVE=1 后 npx vitest run test/integration-workbuddy.test.ts
// 默认（无 WORKBUDDY_LIVE）真机用例自动 skip，但测试结构与预期契约已落地。
//
// 说明：方案 C 的 WebviewCdpTarget 只认 webSocketDebuggerUrl，与具体应用无关，
// 因此 WorkBuddy 无需新增 Target 类，仅需本靶机配置与集成测试即可。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { PlaywrightCdpAdapter } from '../src/cdp/adapter';
import type { CdpAdapter, VisualCapable } from '../src/cdp/adapter';
import { resolveAssetPath } from '../src/util/path';

// 靶机连接同时具备基础 CDP 能力与可视化能力（PlaywrightCdpAdapter 实现两者）。
type Target = CdpAdapter & VisualCapable;

// 将相对路径解析为标准绝对路径（Windows 安全，见 src/util/path.ts）。
function resolvePath(rel: string): string {
  return resolveAssetPath(rel, import.meta.url);
}

const LIVE = process.env.WORKBUDDY_LIVE === '1';
const EXE = 'C:\\Users\\harveyhfye\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe';
const PORT = 9233;

const expectedPath = resolvePath('./fixtures/workbuddy-expected.md');
const expectedDoc = existsSync(expectedPath) ? readFileSync(expectedPath, 'utf-8') : '';

function writeReport(lines: string[]) {
  const dir = resolvePath('./reports/');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = resolvePath(`./reports/workbuddy-run-${ts}.md`);
  const header = `# WorkBuddy 集成测试报告\n\n## 预期结果契约（来自 fixtures/workbuddy-expected.md）\n${expectedDoc}\n\n## 实际结果\n`;
  writeFileSync(file, header + lines.join('\n') + '\n');
  return file;
}

const live = LIVE ? describe : describe.skip;
let adapter: Target;
const report: string[] = [];

// 模块级钩子：受 LIVE 门控。describe.skip 不会拦住顶层 beforeAll，
// 因此这里显式 return，避免无真机时去连 9233 端口而失败。
beforeAll(async () => {
  if (!LIVE) return;
  adapter = new PlaywrightCdpAdapter();
  await adapter.connect({ port: PORT });
}, 30_000);

afterAll(async () => {
  if (!LIVE) return;
  const f = writeReport(report);
  report.push(`\n报告已生成: ${f}`);
  await (adapter as PlaywrightCdpAdapter).disconnect().catch(() => undefined);
});

live('WorkBuddy 真实靶机集成测试（方案 C 通用性验证）', () => {
  it('步骤1：连接成功且枚举多 webview', async () => {
    const targets = adapter.listTargets();
    report.push(`- listTargets 返回 ${targets.length} 个目标`);
    expect(targets.length).toBeGreaterThan(0);
    const pages = targets.filter((t) => t.type === 'page');
    const webviews = targets.filter((t) => t.type === 'webview');
    report.push(`  - page: ${pages.length}, webview: ${webviews.length}`);
    // 预期：至少 1 个 page + 若干 webview（IDE 多面板）
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });

  it('步骤2：截图主窗口非空白且落盘可验证', async () => {
    const savePath = resolvePath('./reports/workbuddy-main.png');
    const buf = await adapter.screenshot({ savePath });
    report.push(`- 主窗口截图字节数: ${buf.length}, 落盘: ${savePath}`);
    expect(buf.length).toBeGreaterThan(0);
    // 验证截图确实写入磁盘，可被人工打开查看
    expect(existsSync(savePath)).toBe(true);
  });

  it('步骤3：webview 内层元素可达（方案 C 跨应用验证）', async () => {
    const targets = adapter.listTargets();
    const webviews = targets.filter((t) => t.type === 'webview');
    expect(webviews.length).toBeGreaterThan(0);
    // 找到真正承载对话输入框的内层 webview
    let dialogWv: string | undefined;
    for (const wv of webviews) {
      adapter.selectTarget(wv.id);
      const hasBox = await adapter
        .eval('!!document.querySelector("[role=textbox]")')
        .then((r) => Boolean(r))
        .catch(() => false);
      if (hasBox) {
        dialogWv = wv.id;
        break;
      }
    }
    report.push(`- 含输入框的 webview: ${dialogWv ?? '(未找到)'}`);
    expect(dialogWv, '未找到含对话输入框的 webview').toBeTruthy();
  });
});

// 纯结构测试：确保"预期结果说明文件"存在且非空（不依赖真机）。
describe('WorkBuddy 集成测试契约自查', () => {
  it('预期结果说明文件已存在且非空', () => {
    expect(expectedDoc.length).toBeGreaterThan(50);
    expect(expectedDoc).toContain('预期');
  });
});
