// 网页级验收：Playwright 点 5173 的 [data-action]，对 9246 上的独立 VS Code 做真实输入。
// 不把 adapter.click 当成「运行全部」成功。

import { chromium } from 'playwright';

const UI = process.env.UI_URL ?? 'http://127.0.0.1:5173/?live=1&cdp=9246';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9246';

function log(...a) { console.log(...a); }

async function cfgSteps(wb) {
  return wb.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-cfg-node]')];
    return nodes.map((n) => ({
      id: n.getAttribute('data-cfg-node'),
      text: (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    }));
  });
}

async function countNihao(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="listitem"]')];
    return items.filter((e) => ((e.getAttribute('aria-label') || e.textContent || '').trim().startsWith('你好'))).length;
  });
}

async function clickNamed(page, pattern) {
  const hit = await page.evaluate((pat) => {
    const re = new RegExp(pat);
    const els = [...document.querySelectorAll('a, button, [role="button"], [role="tab"]')];
    for (const e of els) {
      const name = (e.getAttribute('aria-label') || e.textContent || '').trim();
      const r = e.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (re.test(name)) {
        e.click();
        return { name: name.slice(0, 60), x: r.left, y: r.top };
      }
    }
    return null;
  }, pattern);
  if (!hit) throw new Error('未找到控件: ' + pattern);
  log('  click', hit.name);
  await page.waitForTimeout(400);
  return hit;
}

async function clickChatInput(page) {
  const box = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[role="textbox"], textarea')];
    const vis = nodes.map((e) => {
      const r = e.getBoundingClientRect();
      return {
        tag: e.tagName,
        role: e.getAttribute('role'),
        name: (e.getAttribute('aria-label') || '').slice(0, 40),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        w: r.width,
        h: r.height,
      };
    }).filter((x) => x.w > 80 && x.h > 12 && x.x > 500);
    vis.sort((a, b) => b.w - a.w);
    return vis[0] || null;
  });
  if (!box) throw new Error('未找到聊天输入框');
  log('  chat input', JSON.stringify(box));
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(200);
}

async function main() {
  const report = { stepsBefore: [], stepsAfter: [], runAll: 'unknown', nihaoAfter: 0, locators: [] };
  const vs = await chromium.connectOverCDP(CDP);
  const vpage = vs.contexts()[0]?.pages()[0];
  if (!vpage) throw new Error('VS Code 无 page');
  log('[0] VS Code title', await vpage.title());

  const uiBrowser = await chromium.launch({ headless: true });
  const wb = await uiBrowser.newPage();
  await wb.goto(UI, { waitUntil: 'domcontentloaded' });
  await wb.waitForTimeout(1500);
  const connected = await wb.getByText('已连接').first().isVisible().catch(() => false);
  log('[1] workbench connected', connected);
  if (!connected) {
    const reconnect = wb.locator('[data-action="connect"], [data-action="reconnect"]');
    if (await reconnect.count()) await reconnect.first().click();
    await wb.waitForTimeout(2000);
  }

  log('[2] 新建聊天（录制前清场）');
  await clickNamed(vpage, '新建聊天').catch(() => clickNamed(vpage, '切换聊天'));
  await vpage.waitForTimeout(800);

  log('[3] 工作台开始录制');
  await wb.locator('[data-action="toggle-record"]').click();
  await wb.waitForTimeout(800);
  const rec = await wb.locator('[data-recording="true"]').count();
  log('  recording attr', rec);

  log('[4] VS Code：点输入框、打 你好、点发送');
  await clickChatInput(vpage);
  await vpage.keyboard.type('你好', { delay: 40 });
  await vpage.waitForTimeout(300);
  await clickNamed(vpage, '^发送');
  await vpage.waitForTimeout(1200);

  log('[5] 工作台停止录制');
  await wb.locator('[data-action="toggle-record"]').click();
  await wb.waitForTimeout(1200);
  report.stepsAfter = await cfgSteps(wb);
  log('  CFG steps:');
  for (const s of report.stepsAfter) log('   -', s.text);
  const locDump = [];
  for (const s of report.stepsAfter) {
    await wb.locator(`[data-cfg-node="${s.id}"]`).click();
    await wb.waitForTimeout(200);
    const fields = await wb.evaluate(() => {
      const out = {};
      document.querySelectorAll('[data-edit-field]').forEach((el) => {
        out[el.getAttribute('data-edit-field')] = el.value || el.textContent;
      });
      return out;
    });
    locDump.push({ id: s.id, text: s.text, fields });
    log('   loc', s.id, JSON.stringify(fields));
  }
  report.locators = locDump;
  const blob = report.stepsAfter.map((s) => s.text).join('\n');
  const emptyFill = report.stepsAfter.filter((s) => /填充/.test(s.text) && /=\s*$/.test(s.text));
  const pres = report.stepsAfter.filter((s) => /<presentation>/.test(s.text));
  const cssDump = report.stepsAfter.filter((s) => /\.reveal|display:\s*none/.test(s.text));
  const overlayName = /无法访问编辑器|屏幕阅读器|Shift\+Alt\+F1/.test(blob);
  report.okRecord = emptyFill.length === 0 && pres.length === 0 && cssDump.length === 0 && !overlayName
    && report.stepsAfter.some((s) => /你好/.test(s.text))
    && report.stepsAfter.some((s) => /发送|button/.test(s.text));
  log('  emptyFill', emptyFill.length, 'presentation', pres.length, 'cssDump', cssDump.length, 'overlayName', overlayName, 'okRecord', report.okRecord);

  log('[6] 再建新聊天，使回放可观察');
  await clickNamed(vpage, '新建聊天').catch(() => undefined);
  await vpage.waitForTimeout(1500);
  const beforeRun = await countNihao(vpage);
  log('  nihao bubbles before run-all', beforeRun);

  log('[7] 工作台点击 运行全部');
  await wb.locator('[data-action="run-all"]').click();
  const deadline = Date.now() + 45000;
  let notice = '';
  while (Date.now() < deadline) {
    notice = (await wb.locator('[data-run-notice]').textContent().catch(() => '')) || '';
    const fail = await wb.locator('[data-cfg-status="fail"]').count();
    const running = await wb.locator('[data-cfg-status="running"]').count();
    if (fail > 0 || /中断|失败/.test(notice)) {
      report.runAll = 'fail';
      break;
    }
    if (running === 0 && Date.now() > deadline - 40000) {
      const any = await wb.locator('[data-cfg-status="pass"]').count();
      if (any > 0) { report.runAll = 'pass'; break; }
    }
    await wb.waitForTimeout(500);
  }
  if (report.runAll === 'unknown') {
    const fail = await wb.locator('[data-cfg-status="fail"]').count();
    const pass = await wb.locator('[data-cfg-status="pass"]').count();
    report.runAll = fail ? 'fail' : (pass ? 'pass' : 'timeout');
  }
  notice = (await wb.locator('[data-run-notice]').textContent().catch(() => '')) || notice;
  log('  run-all', report.runAll, 'notice', notice.slice(0, 200));

  await vpage.waitForTimeout(1500);
  report.nihaoAfter = await countNihao(vpage);
  log('  nihao bubbles after run-all', report.nihaoAfter, 'delta', report.nihaoAfter - beforeRun);

  await uiBrowser.close();
  // 不断开 VS Code，只松 Playwright 客户端
  vs.close().catch(() => undefined);

  const replayed = report.nihaoAfter > beforeRun;
  log('\n=== REPORT ===');
  log(JSON.stringify({ ...report, replayed }, null, 2));
  if (!report.okRecord || report.runAll !== 'pass' || !replayed) {
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
