import { describe, it, expect } from 'vitest';
import { resolveAssetPath } from '../src/util/path';
import { dirname, basename } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';

// 回归护栏：捕获 Windows 下 "new URL(...).pathname" 产出 /D:/... 伪 POSIX 路径，
// 与 cwd 拼接导致 "D:\D:\..." 双重盘符 ENOENT 的 bug（原 integration 真机才暴露）。
// 本测试默认即可运行（不依赖靶机），确保路径解析在所有平台正确。
describe('resolveAssetPath (Windows 路径归一化回归)', () => {
  it('产出标准绝对路径，不含伪 POSIX 盘符', () => {
    const p = resolveAssetPath('./reports/x.png', import.meta.url);
    expect(p).toBeTruthy();
    // 绝对路径：以盘符（Windows）或 /（POSIX）开头
    expect(p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)).toBe(true);
    // 不应出现 "/D:" 这类前导斜杠 + 盘符的伪 POSIX 形态
    expect(p).not.toMatch(/\/[A-Za-z]:/);
    // 不应包含双重盘符
    expect(p).not.toMatch(/[A-Za-z]:\\.*[A-Za-z]:/);
  });

  it('dirname 后可直接 mkdirSync + writeFileSync 不报 ENOENT', () => {
    const p = resolveAssetPath('./reports/__path_probe__/probe.txt', import.meta.url);
    const dir = dirname(p);
    expect(() => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, 'ok');
    }).not.toThrow();
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('ok');
    // 清理
    rmSync(dirname(p), { recursive: true, force: true });
  });

  it('basename 正确反映文件名', () => {
    const p = resolveAssetPath('./fixtures/codebuddy-expected.md', import.meta.url);
    expect(basename(p)).toBe('codebuddy-expected.md');
  });
});
