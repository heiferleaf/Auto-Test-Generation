// 跨平台靶机启动契约：targets.json 按 win/mac/linux 分平台，launch-target 按 process.platform 挑选。
// 测试不拉真机、不启进程——注入 spawnLaunch 与 platform 即可。
//
// 背景：原实现 spawn('cmd.exe', ['/c', 'scripts/launch-*.cmd']) 且 targets.json 写死
// C:\Users\<某人>\...，换机器/macos/linux 必然失败。本文件守住"平台分支被正确挑选"这件事。

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadTargetCatalog,
  resolveTargetSpec,
  resolvePlatformSpec,
  runLaunchTarget,
  PLATFORM_KEYS,
  type TargetSpec,
  type PlatformKey,
} from '../src/mcp/launch-target';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 造一份三平台齐全的目录，避免依赖真实 scripts/targets.json 的内容。 */
function triPlatformCatalog(): TargetSpec[] {
  return [
    {
      name: 'vscode',
      label: 'Visual Studio Code',
      port: 9244,
      platforms: {
        win32: { exe: 'C:\\VSCode\\Code.exe', launchScript: 'scripts/launch-target.mjs' },
        darwin: {
          exe: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
          launchScript: 'scripts/launch-target.mjs',
        },
        linux: { exe: '/usr/bin/code', launchScript: 'scripts/launch-target.mjs' },
      },
    },
  ];
}

describe('targets.json 平台分支', () => {
  it('真实目录每个靶机都有 platforms 且含 win32/darwin/linux', () => {
    for (const spec of loadTargetCatalog(ROOT)) {
      expect(spec.platforms, `${spec.name} 缺 platforms`).toBeTruthy();
      for (const p of PLATFORM_KEYS) {
        expect(spec.platforms?.[p], `${spec.name} 缺 ${p} 分支`).toBeTruthy();
      }
    }
  });

  it('真实目录不再出现写死的个人目录绝对路径', () => {
    for (const spec of loadTargetCatalog(ROOT)) {
      const blob = JSON.stringify(spec);
      // C:\Users\<具体用户名>\ 是"换台机器就废"的标志。
      expect(blob).not.toMatch(/C:\\{1,2}Users\\{1,2}[^\\"]+\\{1,2}/i);
    }
  });

  it('resolvePlatformSpec 按平台挑对 exe 与启动脚本', () => {
    const spec = triPlatformCatalog()[0]!;
    expect(resolvePlatformSpec(spec, 'win32').exe).toBe('C:\\VSCode\\Code.exe');
    expect(resolvePlatformSpec(spec, 'darwin').exe).toBe(
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    );
    expect(resolvePlatformSpec(spec, 'linux').exe).toBe('/usr/bin/code');
  });

  it('未覆盖的平台给明确错误，不静默回落到 win32', () => {
    const spec = triPlatformCatalog()[0]!;
    // 故意传一个不在 PlatformKey 里的值，验证运行时有兜底（TS 层面这类型是非法的）。
    const unsupported = 'freebsd' as PlatformKey;
    // 错误里要点名是哪个平台不支持、已配了哪些，便于用户补 targets.json。
    expect(() => resolvePlatformSpec(spec, unsupported)).toThrow(/不支持平台 freebsd.*已配置/s);
  });

  it('缺 platforms 时给明确错误，而不是 undefined.exe', () => {
    const legacy = { name: 'x', label: 'X', port: 9222 } as unknown as TargetSpec;
    expect(() => resolvePlatformSpec(legacy, 'darwin')).toThrow(/platforms/);
  });
});

describe('launch-target 跨平台拉起', () => {
  it('不再用 cmd.exe /c：任何平台都 spawn node 跑 .mjs 启动脚本', async () => {
    const seen: { scriptPath: string }[] = [];
    await runLaunchTarget({
      root: ROOT,
      name: 'vscode',
      platform: 'darwin',
      catalog: triPlatformCatalog(),
      spawnLaunch: async (scriptPath) => {
        seen.push({ scriptPath });
        return '[ok] CDP is live: http://localhost:9244/json';
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.scriptPath).toMatch(/launch-target\.mjs$/);
  });

  it('把平台 exe 与端口传给启动脚本（经环境或参数）', async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    await runLaunchTarget({
      root: ROOT,
      name: 'vscode',
      platform: 'darwin',
      catalog: triPlatformCatalog(),
      spawnLaunch: async (_p, env) => {
        seenEnv = env;
        return '[ok] CDP is live: http://localhost:9244/json';
      },
    });
    expect(seenEnv?.ATG_TARGET_EXE).toContain('Contents/MacOS');
    expect(seenEnv?.CDP_PORT).toBe('9244');
  });

  it('启动脚本输出里的真实端口优先于目录默认值', async () => {
    const r = await runLaunchTarget({
      root: ROOT,
      name: 'vscode',
      platform: 'linux',
      catalog: triPlatformCatalog(),
      spawnLaunch: async () => '[warn] port occupied, [ok] CDP is live: http://localhost:9247/json',
    });
    expect(r.port).toBe(9247);
    expect(r.port).not.toBe(9244);
  });

  it('解析不到端口时回退到目录默认，绝不回退 9222', async () => {
    const r = await runLaunchTarget({
      root: ROOT,
      name: 'vscode',
      platform: 'linux',
      catalog: triPlatformCatalog(),
      spawnLaunch: async () => 'started, no port printed',
    });
    expect(r.port).toBe(9244);
  });

  it('未知靶机名给明确错误并列出可选项', async () => {
    await expect(
      runLaunchTarget({
        root: ROOT,
        name: 'nope',
        platform: 'linux',
        catalog: triPlatformCatalog(),
        spawnLaunch: async () => '',
      }),
    ).rejects.toThrow(/vscode/);
  });
});

describe('向后兼容', () => {
  it('resolveTargetSpec 仍能按 name 取到目录项（旧调用点不破）', () => {
    const spec = resolveTargetSpec('VSCODE', triPlatformCatalog());
    expect(spec.name).toBe('vscode');
  });

  it('目录项保留 port 字段供无平台分支场景回退', () => {
    expect(triPlatformCatalog()[0]!.port).toBe(9244);
  });
});
