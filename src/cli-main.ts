// 命令行真实连接入口（M1.5）：解析参数 → 启动 PlaywrightCdpAdapter → runCli。
// 设计依据：docs/设计文档.md §8-5（失败路径输出明确错误）。

import { readFileSync } from 'node:fs';
import { PlaywrightCdpAdapter, CdpError } from './cdp/adapter';
import { runCli } from './cli';
import type { Script } from './types/step';

function parseArgs(argv: string[]): { app?: string; port: number; script?: string } {
  const out: { app?: string; port: number; script?: string } = { port: 9222 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') out.app = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i] ?? 9222);
    else if (a === '--script') out.script = argv[++i];
  }
  if (!out.script) {
    throw new Error('缺少 --script <json 路径> 参数');
  }
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`参数错误: ${(err as Error).message}`);
    return 2;
  }

  let script: Script;
  try {
    script = JSON.parse(readFileSync(args.script!, 'utf-8')) as Script;
  } catch (err) {
    console.error(`读取脚本失败: ${(err as Error).message}`);
    return 2;
  }

  const adapter = new PlaywrightCdpAdapter();
  try {
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
  } catch (err) {
    if (err instanceof CdpError) {
      console.error(`CDP 连接错误 [${err.code}]: ${err.message}`);
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
