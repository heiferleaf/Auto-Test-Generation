import { fileURLToPath } from 'node:url';

/**
 * 将相对路径基于调用方的 import.meta.url 解析为标准绝对路径。
 *
 * 平台适配关键点（Windows）：
 *   new URL('./x', import.meta.url).pathname 在 Windows 上产出
 *   "/D:/project/...", 这种带前导斜杠的伪 POSIX 路径若再与 process.cwd()
 *   拼接（如 fs.mkdirSync(dirname(savePath))）会出现双重盘符
 *   "D:\D:\project\..." 而 ENOENT。必须用 fileURLToPath 规整为
 *   "D:\project\..." 标准路径。
 *
 * 抽到此处的目的：路径解析属"适配操作系统差异"的脏活，集中一处复用，
 * 避免散落各文件（DIP）；并便于单测护住 Windows 拼接回归（test/path.test.ts）。
 */
export function resolveAssetPath(rel: string, metaUrl: string): string {
  return fileURLToPath(new URL(rel, metaUrl));
}
