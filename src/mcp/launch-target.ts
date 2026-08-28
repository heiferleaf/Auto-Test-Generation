// 跨平台靶机启动：读 scripts/targets.json 的平台分支，用 Node 跑 scripts/launch-target.mjs。
// 不在 MCP 里重写 CDP 启动逻辑，也不把 9222 当唯一端口。
//
// 为什么换成 Node 脚本：原实现 spawn('cmd.exe', ['/c', 'scripts/launch-*.cmd'])，
// 而那些 .cmd 里的 exe 路径写死在某台 Windows 机器的个人目录下，macOS / Linux 上必然失败。
// 启动逻辑收敛到一份 scripts/launch-target.mjs，由它自己按 process.platform 找路径。

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCdpPortFromLaunchOutput } from './parse-output';
import { asOptionalNumber, asOptionalString } from './json-args';

/** Node 的 process.platform 取值，targets.json 用同样的键。 */
export type PlatformKey = 'win32' | 'darwin' | 'linux';

export const PLATFORM_KEYS: readonly PlatformKey[] = ['win32', 'darwin', 'linux'] as const;

export type PlatformSpec = {
  /** 可执行文件完整路径；'auto-detect' 表示交给启动脚本按平台默认位置找。 */
  exe: string;
  launchScript: string;
};

export type TargetSpec = {
  name: string;
  label: string;
  /** 无平台分支时的兜底端口；平台分支本身不带端口。 */
  port: number;
  platforms?: Partial<Record<PlatformKey, PlatformSpec>>;
  liveEnv?: string;
};

export type LaunchResult = {
  name: string;
  port: number;
  jsonUrl: string;
  label?: string;
  platform: PlatformKey;
  exe?: string;
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

/**
 * 按平台取分支。缺分支/平台不支持都抛错——静默回落到 win32 会拿一个 macOS 上
 * 根本不存在的路径去拉起，错误信息会比现在这句难懂得多。
 */
export function resolvePlatformSpec(spec: TargetSpec, platform: PlatformKey): PlatformSpec {
  const branch = spec.platforms?.[platform];
  if (branch) return branch;
  if (!spec.platforms) {
    throw new Error(`靶机 ${spec.name} 缺少 platforms 字段（需含 ${PLATFORM_KEYS.join(' / ')}）`);
  }
  throw new Error(
    `靶机 ${spec.name} 不支持平台 ${platform}；已配置: ${Object.keys(spec.platforms).join(' / ')}`,
  );
}

export type SpawnLaunch = (scriptPath: string, env: NodeJS.ProcessEnv) => Promise<string>;

/**
 * 用 Node 跑启动脚本，不再经过 cmd.exe。
 * 这样 Windows / macOS / Linux 走的是同一条代码路径，平台差异收敛在 .mjs 里。
 */
const defaultSpawn: SpawnLaunch = (scriptPath, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [scriptPath, 'nopause'], {
    env,
    windowsHide: true,
  });
  let out = '';
  // stdout 只收启动脚本打印的端口行；诊断在 stderr，也收进来便于失败时定位。
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
 * 跑 scripts/launch-target.mjs。优先用 stdout 里打印的端口（脚本可能因幽灵口 +1）。
 * 解析不到才用目录默认 / 调用方覆盖，绝不回退成写死的 9222。
 */
export async function runLaunchTarget(opts: {
  root: string;
  name?: unknown;
  port?: unknown;
  /** 注入以便测试替身；生产用 process.platform。 */
  platform?: PlatformKey;
  catalog?: TargetSpec[];
  spawnLaunch?: SpawnLaunch;
}): Promise<LaunchResult> {
  const o = opts ?? {};
  const catalog = o.catalog ?? loadTargetCatalog(o.root);
  const spec = resolveTargetSpec(o.name, catalog);
  const platform = o.platform ?? (process.platform as PlatformKey);
  const branch = resolvePlatformSpec(spec, platform);
  const override = asOptionalNumber(o.port);
  const intended = override ?? spec.port;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATG_NOPAUSE: '1',
    CDP_PORT: String(intended),
    ATG_TARGET_NAME: spec.name,
    // auto-detect 表示目录里没有写死路径，交给启动脚本按平台默认位置找。
    ...(branch.exe && branch.exe !== 'auto-detect' ? { ATG_TARGET_EXE: branch.exe } : {}),
  };
  const scriptPath = join(o.root, branch.launchScript);
  const spawnLaunch = o.spawnLaunch ?? defaultSpawn;
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
    platform,
    ...(branch.exe && branch.exe !== 'auto-detect' ? { exe: branch.exe } : {}),
  };
}
