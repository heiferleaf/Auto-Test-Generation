// 命令行真实连接入口（M1.5 / M3）：解析参数 → 启动 PlaywrightCdpAdapter → runCli / record。
// 子命令：
//   replay  --script <json> [--app <exe>] [--port 9222]   回放脚本（M1 既有）
//   record  --out <json> [--port 9222] [--auto] [--wait-ms 3000]
//           record 录制交互并导出脚本；--auto 自动注入受控元素并模拟操作（便于系统测试）。
// 设计依据：docs/design/design.md §8-5（失败路径输出明确错误）。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PlaywrightCdpAdapter, CdpError } from './cdp/adapter';
import { runCli } from './cli';
import { Recorder } from './recorder/recorder';
import type { Script } from './types/step';

type Mode = 'replay' | 'record';

function parseArgs(argv: string[]): {
  mode: Mode;
  app?: string;
  port: number;
  script?: string;
  out?: string;
  auto: boolean;
  waitMs: number;
} {
  const out: {
    mode: Mode;
    app?: string;
    port: number;
    script?: string;
    out?: string;
    auto: boolean;
    waitMs: number;
  } = { mode: 'replay' as Mode, port: 9222, auto: false, waitMs: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'record') out.mode = 'record';
    else if (a === 'replay') out.mode = 'replay';
    else if (a === '--app') out.app = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i] ?? 9222);
    else if (a === '--script') out.script = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--auto') out.auto = true;
    else if (a === '--wait-ms') out.waitMs = Number(argv[++i] ?? 3000);
  }
  return out;
}

/** 在页面注入受控元素（TrustedHTML 兼容：createElement 而非 innerHTML）。 */
async function injectProbe(adapter: PlaywrightCdpAdapter): Promise<void> {
  await adapter.eval(`(() => {
    const d = document.createElement('div');
    const inp = document.createElement('input');
    inp.id = 'rec-test'; inp.setAttribute('aria-label', 'rec-input');
    const btn = document.createElement('button');
    btn.id = 'rec-btn'; btn.setAttribute('aria-label', 'rec-button'); btn.textContent = 'Go';
    d.appendChild(inp); d.appendChild(btn);
    document.body.appendChild(d);
    return true;
  })()`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const adapter = new PlaywrightCdpAdapter();

  try {
    if (args.mode === 'replay') {
      if (!args.script) {
        console.error('缺少 --script <json 路径>');
        return 2;
      }
      let script: Script;
      try {
        script = JSON.parse(readFileSync(args.script, 'utf-8')) as Script;
      } catch (err) {
        console.error(`读取脚本失败: ${(err as Error).message}`);
        return 2;
      }
      const result = await runCli({
        adapter,
        script,
        connectOpts: { port: args.port, appPath: args.app },
      });
      if (result.ok) {
        console.log('✅ 脚本执行成功');
        return 0;
      }
      console.error(`❌ 执行失败，失败步骤: ${result.failedStepId ?? '(未知)'}`);
      return 1;
    }

    // record 模式
    if (!args.out) {
      console.error('缺少 --out <导出 json 路径>');
      return 2;
    }
    await adapter.connect({ port: args.port, appPath: args.app });
    adapter.startRecording();
    if (args.auto) {
      await injectProbe(adapter);
      await adapter.fill({ css: '#rec-test' }, '你好');
      await adapter.click({ css: '#rec-btn' });
    } else {
      console.log(`⏺ 录制中…（${args.waitMs}ms 后自动停止；如需手动操作请在此窗口交互）`);
      await new Promise((r) => setTimeout(r, args.waitMs));
    }
    const events = await adapter.stopRecording();
    const rec = new Recorder();
    events.forEach((e) => rec.record(e));
    const finalScript = rec.buildScript(
      { name: 'CodeBuddy', version: 'recorded' },
      args.auto ? 'auto-recorded' : 'manual-recorded',
    );
    const json = JSON.stringify(finalScript, null, 2);
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, json);
    console.log(`✅ 录制完成，共 ${finalScript.steps.length} 步，已导出: ${args.out}`);
    return 0;
  } catch (err) {
    if (err instanceof CdpError) {
      console.error(`CDP 错误 [${err.code}]: ${err.message}`);
    } else {
      console.error(`运行错误: ${(err as Error).message}`);
    }
    return 1;
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

// 仅在作为入口直接执行时启动（兼容 tsx / node）。
const invokedDirectly = process.argv[1] && /cli-main(?:\.js|\.ts)?$/.test(process.argv[1]);
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
