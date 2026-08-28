// macOS .app → 可执行文件的解析。这是 scripts/launch-target.mjs 里最容易在真机上崩的一段：
// Electron 应用的 Contents/MacOS 下除了主程序，还会有 Code Helper / Code Helper (GPU) 等辅助进程，
// 按字典序它们排在主程序前面。挑错了的结果是拉起一个不听 --remote-debugging-port 的 Helper，
// 表现为"干等到超时"，而单测如果只测 launch-target.ts 的纯函数是完全覆盖不到这里的。
//
// 所以用注入的假文件系统把几种真实布局都钉死。

import { describe, it, expect } from 'vitest';
import { resolveMacExe } from '../scripts/launch-target.mjs';

// 实现内部用 path.join 拼路径，Windows 上产出反斜杠；断言前归一到 POSIX 好写也好读。
const posix = (p: string) => p.replace(/\\/g, '/');

/**
 * 造一个内存版 fs。
 * 键统一按 POSIX 斜杠写，但 path.join 在 Windows 上产出反斜杠，
 * 所以入口处一律归一化——否则在 Windows 跑 macOS 布局的用例会全部误判为"路径不存在"。
 */
function fakeFs(files: Record<string, string>) {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/');
  const store = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const dirs = new Set<string>();
  for (const p of store.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const childrenOf = (dir: string) => {
    const d = norm(dir);
    return [...new Set([...store.keys(), ...dirs])]
      .filter((p) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/'))
      .map((p) => p.slice(d.length + 1));
  };

  return {
    existsSync: (p: string) => dirs.has(norm(p)) || store.has(norm(p)),
    readdirSync: (p: string) => childrenOf(p),
    readFileSync: (p: string) => {
      const v = store.get(norm(p));
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
  };
}

/** VS Code 的真实布局：主程序叫 Electron，还有三个 Helper。 */
const VSCODE_LAYOUT = {
  '/Applications/Visual Studio Code.app/Contents/Info.plist':
    '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>Electron</string></dict></plist>',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron': 'binary',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper': 'binary',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper (GPU)': 'binary',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper (Plugin)': 'binary',
};

describe('resolveMacExe', () => {
  it('按 Info.plist 的 CFBundleExecutable 挑主程序，不被 Helper 干扰', () => {
    const io = fakeFs(VSCODE_LAYOUT);
    const r = resolveMacExe('/Applications/Visual Studio Code.app', io);
    expect(posix(r)).toBe('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  });

  it('Helper 与主程序共存，且字典序上排在主程序前面——这正是原实现踩的坑', () => {
    // 守住"这个坑客观存在"的前提：Electron 应用里 Helper 一定在，且 'Code Helper' < 'Electron'。
    // 不断言 readdirSync 的返回顺序（那是文件系统的实现细节），只断言字典序关系。
    expect('Code Helper'.localeCompare('Electron')).toBeLessThan(0);
    expect('Code Helper (GPU)'.localeCompare('Electron')).toBeLessThan(0);
    // 因此"取目录里第一个"必然拿到 Helper，实现必须靠 Info.plist 或显式排除。
    const io = fakeFs(VSCODE_LAYOUT);
    const entries = io.readdirSync('/Applications/Visual Studio Code.app/Contents/MacOS');
    expect(entries.filter((f) => /helper/i.test(f)).length).toBeGreaterThan(0);
    expect(entries).toContain('Electron');
  });

  it('无 Info.plist 时排除 Helper 取剩下的', () => {
    const io = fakeFs({
      '/Applications/MyApp.app/Contents/MacOS/MyApp': 'binary',
      '/Applications/MyApp.app/Contents/MacOS/MyApp Helper': 'binary',
    });
    expect(posix(resolveMacExe('/Applications/MyApp.app', io))).toBe(
      '/Applications/MyApp.app/Contents/MacOS/MyApp',
    );
  });

  it('多个非 Helper 候选取与 .app 同名的', () => {
    const io = fakeFs({
      '/Applications/Foo.app/Contents/MacOS/Foo': 'binary',
      '/Applications/Foo.app/Contents/MacOS/Bar': 'binary',
      '/Applications/Foo.app/Contents/MacOS/Foo Helper': 'binary',
    });
    expect(posix(resolveMacExe('/Applications/Foo.app', io))).toBe(
      '/Applications/Foo.app/Contents/MacOS/Foo',
    );
  });

  it('plist 是二进制格式时仍能捞到 CFBundleExecutable', () => {
    // 二进制 plist 里键名与值通常以明文出现。
    const io = fakeFs({
      '/Applications/Bin.app/Contents/Info.plist': 'bplist00\x00CFBundleExecutable\x00Electron\x00',
      '/Applications/Bin.app/Contents/MacOS/Electron': 'binary',
      '/Applications/Bin.app/Contents/MacOS/Code Helper': 'binary',
    });
    expect(posix(resolveMacExe('/Applications/Bin.app', io))).toBe(
      '/Applications/Bin.app/Contents/MacOS/Electron',
    );
  });

  it('末尾带斜杠的 .app 路径也能解析', () => {
    const io = fakeFs(VSCODE_LAYOUT);
    expect(posix(resolveMacExe('/Applications/Visual Studio Code.app/', io))).toBe(
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    );
  });

  it('已经是可执行文件路径（非 .app）时原样返回', () => {
    const io = fakeFs(VSCODE_LAYOUT);
    const p = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
    expect(resolveMacExe(p, io)).toBe(p);
  });

  it('Contents/MacOS 不存在时原样返回（交给调用方报"路径不存在"）', () => {
    const io = fakeFs({ '/Applications/Empty.app/Contents/Info.plist': 'x' });
    expect(resolveMacExe('/Applications/Empty.app', io)).toBe('/Applications/Empty.app');
  });

  it('Contents/MacOS 为空目录时原样返回', () => {
    const io = fakeFs({ '/Applications/Empty.app/Contents/MacOS/.gitkeep': '' });
    expect(resolveMacExe('/Applications/Empty.app', io)).toBe('/Applications/Empty.app');
  });
});
