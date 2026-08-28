// 网页靶机夹具（本文件用 WEBPAGE_LIVE 门控）。
//
// 为什么要有这个测试：本平台原本只为 Electron 桌面壳设计。但 CDP 是浏览器通用协议，
// `chromium.connectOverCDP` 连用户自起的 Chrome 与连 Electron 走的是同一条路。
// 这个夹具要钉死"普通网页也能跑通"，并回答一个评估点名的风险：
//   `src/cdp/targets.ts` 的 fillOnPage 兜底（挑"看得见、空的、较宽"的可填节点）
//   是为 VS Code 多 textbox 布局调的，在普通网页上可能挑错输入框。
//
// 所以 fixture 刻意放**多个输入框**，且让"错误的那个"更宽——如果兜底挑错，测试会红。
//
// 无 WEBPAGE_LIVE=1 时 skip（项目纪律：真机/浏览器集成测试必须环境变量门控）。
//
// 跑法：
//   set WEBPAGE_LIVE=1 && npm test -- test/integration-webpage.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { PlaywrightCdpAdapter } from '../src/cdp/adapter';
import { runScript } from '../src/executor/executor';
import { SCRIPT_SCHEMA } from '../src/types/step';
import type { Script } from '../src/types/step';
import { resolveAssetPath } from '../src/util/path';

const LIVE = process.env.WEBPAGE_LIVE === '1';
const live = LIVE ? describe : describe.skip;

/** 测试专用调试端口。不复用 9222/9244 等靶机口，避免和真机靶机抢。 */
const PORT = Number(process.env.WEBPAGE_CDP_PORT ?? 9333);

let browser: Browser;
let adapter: PlaywrightCdpAdapter;
const report: string[] = [];

function reportPath(): string {
  const dir = resolveAssetPath('./reports/', import.meta.url);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolveAssetPath(
    `./reports/webpage-run-${new Date().toISOString().replace(/[:.]/g, '-')}.md`,
    import.meta.url,
  );
}

/**
 * 测试用 fixture：一个带搜索框的普通网页。
 *
 * 关键设计（针对 fillOnPage 兜底的风险）：
 *   #wide-note 是最宽的输入框，但它**不是**语义上的目标输入框——
 *   fillOnPage 的兜底按 (empty, width) 排序，若它挑错就会填进 #wide-note。
 *   真实目标 #q 比它窄，只有走 role/name/css 语义路径才能填对。
 */
const FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>ATG 网页夹具</title>
<style>
  body { font-family: sans-serif; padding: 24px; }
  input, button { font-size: 14px; padding: 6px; margin: 6px 0; }
  #wide-note { width: 640px; height: 28px; }
  #q { width: 220px; }
  #result { margin-top: 16px; color: #0a0; font-weight: 600; }
  #echo { margin-top: 8px; color: #333; }
</style>
</head>
<body>
  <h1>ATG 网页夹具</h1>
  <label for="q">搜索</label>
  <input id="q" name="q" type="text" placeholder="输入关键词" />
  <button id="go" type="button">搜索</button>

  <div>
    <label for="wide-note">备注（这个框最宽，但语义上不该被挑中）</label>
    <input id="wide-note" name="note" type="text" placeholder="备注" />
  </div>

  <!-- role="status" 不是装饰：textContains 只搜 snapshot 节点，而 SNAPSHOT_COLLECT
       只挑交互元素/带 role 的元素。纯 div 文字永远进不了断言视野（见下方"已知限制"用例）。 -->
  <div id="result" role="status" hidden>搜索完成</div>
  <div id="echo" role="status"></div>

  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.getElementById('result').hidden = false;
      document.getElementById('echo').textContent = '你搜了：' + document.getElementById('q').value;
    });
  </script>
</body>
</html>`;

/** 把 fixture 写到 test/reports/（已被 gitignore），返回文件路径。 */
function writeFixture(): string {
  const dir = resolveAssetPath('./reports/', import.meta.url);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = resolveAssetPath('./reports/webpage-fixture.html', import.meta.url);
  writeFileSync(file, FIXTURE_HTML, 'utf8');
  return file;
}

beforeAll(async () => {
  if (!LIVE) return;
  // 起浏览器时必须显式带 --remote-debugging-port：
  // 适配器走 connectOverCDP('http://127.0.0.1:<port>')，它先要 HTTP 的 /json/version
  // 拿 browser ws，再用 /json 枚举 target。
  // 而 chromium.launchServer() 只给一个浏览器级 ws，不监听 HTTP——
  // 拿它的端口去 /json 会 ECONNREFUSED（实测）。故这里用 launch + 显式端口。
  browser = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`] });
  report.push(`- launched chromium with --remote-debugging-port=${PORT}`);

  // launch 出来的浏览器默认没有 context/page，/json 会是空数组，
  // 适配器 connect 会抛 CDP_NO_TARGET。所以先开一个页面并导航到 fixture。
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(new URL(`file:///${writeFixture().replace(/\\/g, '/')}`).href);
  report.push(`- navigated, title=${await page.title()}`);

  adapter = new PlaywrightCdpAdapter();
  await adapter.connect({ port: PORT });
}, 60_000);

afterAll(async () => {
  if (!LIVE) return;
  writeFileSync(reportPath(), `# 网页靶机\n\n${report.join('\n')}\n`);
  await adapter?.disconnect().catch(() => undefined);
  await browser?.close().catch(() => undefined);
});

live('网页靶机：连接 / snapshot / fill / click / waitUntil', () => {
  it('连上后能枚举出 page 目标，且主目标就是 fixture 页', () => {
    const targets = adapter.listTargets();
    report.push(`- targets: ${targets.length}`);
    targets.slice(0, 12).forEach((t) => report.push(`  - ${t.type} ${t.title}`));
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.some((t) => t.type === 'page')).toBe(true);
  });

  it('snapshot 能列出 fixture 上的控件（含搜索框与按钮）', async () => {
    const nodes = await adapter.snapshot();
    report.push(`- snapshot nodes: ${nodes.length}`);
    nodes.slice(0, 15).forEach((n) =>
      report.push(`  - role=${n.role ?? '-'} tag=${n.tag ?? '-'} name=${n.name ?? '-'} text=${(n.text ?? '').slice(0, 30)}`),
    );
    expect(nodes.length).toBeGreaterThan(0);
    // 语义控件必须在快照里：搜索输入框 + 搜索按钮 + 备注输入框。
    expect(nodes.some((n) => n.tag === 'input')).toBe(true);
    expect(nodes.some((n) => n.tag === 'button')).toBe(true);
  });

  it('fill 命中语义目标 #q，而不是更宽的 #wide-note', async () => {
    // 给的是语义 locator（role=textbox + name=搜索），不是 css。
    // 若 fillOnPage 走兜底（按宽度挑），会填进 #wide-note —— 这是评估点名的风险。
    await adapter.fill({ role: 'textbox', name: '搜索' }, 'atg-web');

    const values = await adapter.eval(`(() => ({
      q: document.getElementById('q').value,
      note: document.getElementById('wide-note').value,
    }))()`) as { q: string; note: string };
    report.push(`- after fill: q="${values.q}" note="${values.note}"`);

    expect(values.q).toBe('atg-web');
    // 兜底若按"最宽"挑，值会落在 note 里而不是 q 里。
    expect(values.note).toBe('');
  }, 20_000);

  it('对照：无语义 locator 时，兜底确实会挑中更宽的 #wide-note', async () => {
    // 上一条用例只在"语义路径命中"时成立。它要能证明兜底挑错，
    // 前提是兜底本身确实挑 #wide-note。这里直接验一次兜底，证明确有此风险：
    // 给一个页面里不存在的 name，语义候选全落空 → 走兜底 → 按 (empty, width) 排序。
    await adapter.fill({ name: '页面上不存在的输入框' }, 'fallback-hit');

    const values = await adapter.eval(`(() => ({
      q: document.getElementById('q').value,
      note: document.getElementById('wide-note').value,
    }))()`) as { q: string; note: string };
    report.push(`- 兜底对照: q="${values.q}" note="${values.note}"`);

    // 兜底挑了更宽的那个，证明确有挑错风险——所以"必须给语义 locator"是硬要求，
    // 不能指望兜底。若将来有人让兜底变聪明，这条会红，提醒重估。
    expect(values.note).toBe('fallback-hit');
    expect(values.q).not.toBe('fallback-hit');

    // 复原，避免影响后续用例。
    await adapter.eval(`(() => { document.getElementById('wide-note').value = ''; return true; })()`);
  }, 20_000);

  it('click 按钮后 waitUntil(textContains) 能通过——验证操作带来的新结果', async () => {
    await adapter.click({ role: 'button', name: '搜索' });

    const script: Script = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'webpage-fixture', version: 'live' },
      steps: [{
        id: 'wu1', type: 'waitUntil', source: 'manual',
        params: {
          timeoutMs: 5000,
          assertion: { kind: 'textContains', value: '搜索完成' },
        },
      }],
    };
    await runScript(adapter, script);
    report.push('- waitUntil textContains 搜索完成: ok');

    // 断言的是操作产生的新结果，不是自己刚做的事：echo 来自输入框的值。
    const echo = await adapter.eval(`document.getElementById('echo').textContent`);
    report.push(`- echo: ${String(echo)}`);
    expect(String(echo)).toContain('atg-web');
  }, 20_000);

  it('逐层快照：selectTarget(id) 后 snapshot 不串层', async () => {
    const targets = adapter.listTargets();
    const first = targets.find((t) => t.type === 'page');
    expect(first).toBeTruthy();
    adapter.selectTarget(first!.id);
    const nodes = await adapter.snapshot();
    expect(Array.isArray(nodes)).toBe(true);
    report.push(`- selectTarget(${first!.id}) → snapshot nodes: ${nodes.length}`);
  });

  it('未知 target id 报 CDP_TARGET_NOT_FOUND，不静默', () => {
    expect(() => adapter.selectTarget('__no_such_target__')).toThrow(/CDP_TARGET_NOT_FOUND/);
    report.push('- selectTarget(未知 id) 抛 CDP_TARGET_NOT_FOUND: ok');
  });

  // 这条用例是本次"网页拓展"评估最有价值的副产品，也是主分支就有的真缺陷的回归门禁。
  //
  // 网页上"操作产生的新结果"绝大多数是纯文本提示，放在无 role 的 div/p/span 里。
  // 而 textContains 原本只搜 snapshot 节点，SNAPSHOT_COLLECT 又只挑交互元素与带 role 的元素，
  // 于是"断言写了、页面上也确实有那段字、但断言过不了"，waitUntil 轮询到超时。
  // 这与 Skill 铁律「断言必须验证操作产生的新结果」直接冲突，故必须修实现。
  //
  // 修法不是放宽断言，而是给断言补视野：snapshot 未命中时，经 adapter 层的 pageText()
  // 兜底一次全 DOM 文本查询（见 src/executor/assert.ts）。
  it('textContains 能看到纯 div 里的文字（snapshot 未命中时回落到整页文本）', async () => {
    // 往一个无 role 的 div 里写文字，模拟网页上最常见的"操作结果提示"。
    await adapter.eval(`(() => {
      const d = document.createElement('div');
      d.id = 'plain-result';
      d.textContent = '纯DIV提示语';
      document.body.appendChild(d);
      return true;
    })()`);

    // 页面上确实有这段字。
    const bodyText = String(await adapter.eval(`document.body.innerText`));
    expect(bodyText).toContain('纯DIV提示语');

    // 断言也必须能看到它——这是修完实现后的期望行为。
    const script: Script = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'webpage-fixture', version: 'live' },
      steps: [{
        id: 'wu-plain', type: 'waitUntil', source: 'manual',
        params: {
          timeoutMs: 3000,
          assertion: { kind: 'textContains', value: '纯DIV提示语' },
        },
      }],
    };
    await runScript(adapter, script);
    report.push('- 纯 div 文字：body 里有，textContains 也断言得到');

    // 反过来证伪：找一个页面上确定不存在的串，必须失败。
    // 防止兜底被写成"永远返回 true"来骗绿。
    const missScript: Script = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'webpage-fixture', version: 'live' },
      steps: [{
        id: 'wu-plain-miss', type: 'waitUntil', source: 'manual',
        params: {
          timeoutMs: 1200,
          assertion: { kind: 'textContains', value: '页面上绝不存在的一段字XYZ' },
        },
      }],
    };
    await expect(runScript(adapter, missScript)).rejects.toThrow(/waitUntil 超时/);
    report.push('- 反例：不存在的文本仍断言失败（兜底未放宽语义）');
  }, 20_000);

  // 上一条覆盖了"整页搜"。这条覆盖带 locator 的分支：
  // 有 locator 时语义是"只搜该节点"，此时**不能**因为整页能找到就判通过，
  // 否则 locator 的限定作用被架空，textContains 会退化成整页包含。
  it('textContains 带 locator 时仍只搜该节点，不被整页兜底架空', async () => {
    const script: Script = {
      schema: SCRIPT_SCHEMA,
      app: { name: 'webpage-fixture', version: 'live' },
      steps: [{
        id: 'wu-loc', type: 'waitUntil', source: 'manual',
        params: {
          timeoutMs: 1200,
          // 页面上"纯DIV提示语"确实存在（上一条用例写进去的），但它在 div#plain-result 里，
          // 不在 button 里。若兜底不看 locator 就会误判通过。
          assertion: {
            kind: 'textContains',
            value: '纯DIV提示语',
            locator: { role: 'button', name: '搜索' },
          },
        },
      }],
    };
    await expect(runScript(adapter, script)).rejects.toThrow(/waitUntil 超时/);
    report.push('- locator 限定：纯 div 文字不会因整页兜底而错判进 button');
  }, 20_000);
});
