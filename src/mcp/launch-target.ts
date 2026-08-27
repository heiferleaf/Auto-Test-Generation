// 包装 scripts/launch-*.cmd：读 targets.json，spawn 现有脚本，从 stdout 解析真实端口。
// 不在 MCP 里重写 CDP 启动逻辑，也不把 9222 当唯一端口。

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCdpPortFromLaunchOutput } from './parse-output';
import { asOptionalNumber, asOptionalString } from './json-args';

export type TargetSpec = {
  name: string;
  label: string;
  exe: string;
  port: number;
  launchScript: string;
};

export type LaunchResult = {
  name: string;
  port: number;
  jsonUrl: string;
  label?: string;
};

export function loadTargetCatalog(root: string): TargetSpec[] {
  const raw = JSON.parse(readFileSync(join(root, 'scripts', 'targets.json'), 'utf8')) as {
    targets?: TargetSpec[];
  };
  const list = raw.targets ?? [];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('scripts/targets.json 没有 targets 数组');
  }
  return list;
}

export function resolveTargetSpec(name: unknown, catalog: TargetSpec[]): TargetSpec {
  const key = asOptionalString(name)?.toLowerCase();
  if (!key) {
    throw new Error(`launch-target 需要 name（${catalog.map((t) => t.name).join(' / ')}）`);
  }
  const found = catalog.find((t) => t.name.toLowerCase() === key);
  if (!found) {
    throw new Error(`未知靶机 ${key}；可选: ${catalog.map((t) => t.name).join(' / ')}`);
  }
  return found;
}

export type SpawnLaunch = (scriptPath: string, env: NodeJS.ProcessEnv) => Promise<string>;

const defaultSpawn: SpawnLaunch = (scriptPath, env) => new Promise((resolve, reject) => {
  const child = spawn('cmd.exe', ['/c', scriptPath, 'nopause'], {
    env,
    windowsHide: true,
  });
  let out = '';
  child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
  child.stderr?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code && code !== 0) {
      reject(new Error(`启动脚本退出码 ${code}: ${out.slice(-800)}`));
      return;
    }
    resolve(out);
  });
});

/**
 * 跑现有 launch-*.cmd。优先用 stdout 里打印的端口（脚本可能因幽灵口 +1）。
 * 解析不到才用目录默认 / 调用方覆盖，绝不回退成写死的 9222。
 */
export async function runLaunchTarget(opts: {
  root: string;
  name?: unknown;
  port?: unknown;
  spawnLaunch?: SpawnLaunch;
}): Promise<LaunchResult> {
  const catalog = loadTargetCatalog(opts.root);
  const spec = resolveTargetSpec(opts.name, catalog);
  const override = asOptionalNumber(opts.port);
  const intended = override ?? spec.port;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATG_NOPAUSE: '1',
    CDP_PORT: String(intended),
  };
  const scriptPath = join(opts.root, spec.launchScript);
  const spawnLaunch = opts.spawnLaunch ?? defaultSpawn;
  const output = await spawnLaunch(scriptPath, env);
  const parsed = parseCdpPortFromLaunchOutput(output);
  const port = parsed ?? intended;
  if (!port) {
    throw new Error(`启动脚本未打印调试端口，且未提供 port（靶机 ${spec.name}）`);
  }
  return {
    name: spec.name,
    label: spec.label,
    port,
    jsonUrl: `http://localhost:${port}/json`,
  };
}
