// scripts/launch-target.mjs 的类型声明。
// 测试要 import 它的 resolveMacExe 做单测，而 tsconfig 不开 allowJs（开了会把 .mjs 一起编进 dist）。
// 只声明被测函数，不重复描述模块内部实现。

export type FakeIo = {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  readFileSync: (p: string, enc?: string) => string;
};

/**
 * 把 macOS 的 .app 目录解析成 Contents/MacOS 下的主可执行文件。
 * 非 .app 路径原样返回。io 参数供测试注入假文件系统。
 */
export function resolveMacExe(exe: string, io?: Partial<FakeIo>): string;
