// 集成测试（M2 测试先行）：以 CodeBuddy CN 为真实靶机的集成/系统测试。
// 严格遵守：本文件与"预期结果说明文件"先于实现存在（测试先行）。
//
// 运行方式：
//   1) 先验证调试端口：node scripts/launch-target.mjs --name codebuddy --port 9222
//      浏览器打开 http://localhost:9222/json 看到目标列表即成功。
//   2) 启用真机： set CODEBUDDY_LIVE=1 后 npx vitest run test/integration-codebuddy.test.ts
//   默认（无 CODEBUDDY_LIVE）真机用例自动 skip，但测试结构与预期契约已落地。
//
// 预期结果契约见 test/fixtures/codebuddy-expected.md，运行时生成报告对照。

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

const LIVE = process.env.CODEBUDDY_LIVE === '1';
const EXE = 'C:\\Users\\harveyhfye\\AppData\\Local\\Programs\\CodeBuddy CN\\CodeBuddy CN.exe';
const PORT = 9222;

// 读取"预期结果说明文件"（测试先行：预期以文件形式声明）。
const expectedPath = resolvePath('./fixtures/codebuddy-expected.md');
const expectedDoc = existsSync(expectedPath) ? readFileSync(expectedPath, 'utf-8') : '';

function writeReport(lines: string[]) {
  const dir = resolvePath('./reports/');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = resolvePath(`./reports/codebuddy-run-${ts}.md`);
  const header = `# CodeBuddy 集成测试报告\n\n## 预期结果契约（来自 fixtures/codebuddy-expected.md）\n${expectedDoc}\n\n## 实际结果\n`;
  writeFileSync(file, header + lines.join('\n') + '\n');
  return file;
}

const live = LIVE ? describe : describe.skip;

// 模块级共享：两个 live describe 块（靶机 + 可视化）共用同一连接与报告。
let adapter: Target;
const report: string[] = [];

// 模块级 beforeAll/afterAll：整个测试文件只连一次、最后才断，
// 避免靶机块 afterAll 断开后可视化块无连接可用。
// 注意：describe.skip 不会拦住顶层钩子，故显式按 LIVE 守卫，
// 无真机时直接 return，避免去连 9222 端口。
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

live('CodeBuddy 真实靶机集成测试', () => {
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

  it('步骤2：快照主窗口可交互元素非空', async () => {
    const nodes = await adapter.snapshot();
    report.push(`- 主窗口 snapshot 节点数: ${nodes.length}`);
    expect(nodes.length).toBeGreaterThan(0);
  });

  it('步骤6：文本断言 - 标题包含 CodeBuddy', async () => {
    const title = String(await adapter.eval('document.title'));
    report.push(`- document.title = "${title}"`);
    expect(title.toLowerCase()).toContain('codebuddy');
  });
});

// M2 可视化能力（screenshot / locateVisual / 视觉断言）已实现，真机路径启用。
// 同样受 LIVE 控制：无 CODEBUDDY_LIVE 时整体 skip（安全：默认不碰生产包）。
const liveVisual = LIVE ? describe : describe.skip;
liveVisual('CodeBuddy 可视化测试（M2 实现）', () => {
  it('步骤4：截图主窗口非空白且落盘可验证', async () => {
    const savePath = resolvePath('./reports/codebuddy-main.png');
    const buf = await adapter.screenshot({ savePath });
    report.push(`- 主窗口截图字节数: ${buf.length}, 落盘: ${savePath}`);
    expect(buf.length).toBeGreaterThan(0);
    expect(existsSync(savePath)).toBe(true);
  });
  it('步骤5：侧栏可见且在视口内', async () => {
    const box = await adapter.locateVisual({ name: '侧栏' });
    report.push(`- 侧栏视觉位置 visible=${box.visible}, inViewport=${box.inViewport}`);
    expect(box.visible).toBe(true);
    expect(box.inViewport).toBe(true);
  });
});

// 纯结构测试：确保"预期结果说明文件"存在且非空（不依赖真机）。
describe('集成测试契约自查', () => {
  it('预期结果说明文件已存在且非空', () => {
    expect(expectedDoc.length).toBeGreaterThan(50);
    expect(expectedDoc).toContain('预期');
  });
});
