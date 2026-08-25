// 本地宿主 server（M3.3）：托管可视化蒙版面板页面（index.html + 转译后的 app.js），
// 并挂载真机桥（/kernel-ws），让浏览器页面经 WebSocket 驱动真实 Electron 应用（CODEBUDDY）。
//
// 运行：`npm run ui`（见 package.json scripts）。访问 http://localhost:5173/ 为演示模式（DemoKernel），
// 访问 http://localhost:5173/?live=1 即真机模式（WsKernel ↔ bridge-server ↔ PlaywrightCdpAdapter）。
//
// 设计：Node 原生 http + esbuild 即时转译 app.ts（浏览器 ESM）。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import * as esbuild from 'esbuild';
import { attachKernelBridge } from './bridge-server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = __dirname; // 本文件位于 src/ui/，index.html 与 app.ts 同目录
const PORT = Number(process.env.UI_PORT ?? 5173);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);

async function transformApp(): Promise<string> {
  // bundle：把 app.ts 及其依赖（shell.ts 等）打包成单一 ESM，浏览器无需逐个请求 .ts。
  // platform=browser 让 esbuild 解析浏览器可用的模块（shell.ts 已不再依赖 cli/executor/playwright）。
  const result = await esbuild.build({
    entryPoints: [join(UI_DIR, 'app.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    sourcemap: false,
  });
  return result.outputFiles[0].text;
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  try {
    if (url === '/' || url === '/index.html') {
      const html = await readFile(join(UI_DIR, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url === '/app.js') {
      const js = await transformApp();
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(js);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Server Error: ${(err as Error).message}`);
  }
});

// 挂载真机桥：在 /kernel-ws 上升级 WebSocket，由 Node 侧持有 PlaywrightCdpAdapter 驱动真机。
const bridge = attachKernelBridge(server, CDP_PORT);

// listen 失败（端口被占用、权限不足等）会以 error 事件抛出而非走回调；
// 不接住会直接变成未捕获异常令进程崩溃（见 CODEBUDDY.md §4.1 真实路径盲区）。
// 这里对 EADDRINUSE 自动递增端口重试，让用户「再开一个实例」时仍可正常起服务。
let actualPort = PORT;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && actualPort < PORT + 10) {
    actualPort += 1;
    server.listen(actualPort);
    return;
  }
  throw err;
});

server.listen(actualPort, () => {
  // eslint-disable-next-line no-console
  if (actualPort !== PORT) {
    console.warn(`端口 ${PORT} 被占用，已自动改用 ${actualPort}`);
  }
  console.log(`可视化蒙版面板已启动: http://localhost:${actualPort}  (Ctrl+C 退出)`);
  console.log(`真机桥已挂载: ws://localhost:${actualPort}/kernel-ws  (CODEBUDDY 调试端口 ${CDP_PORT})`);
});

process.on('SIGINT', () => {
  bridge.close().finally(() => process.exit(0));
});
