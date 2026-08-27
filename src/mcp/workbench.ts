// 拉起 / 停止测试步骤中台（npm run ui → src/ui/serve.ts）。
// 子进程 stdout 必须 pipe：MCP 自己的 stdout 专给 JSON-RPC，不能被工作台日志污染。

import { spawn, type ChildProcess } from 'node:child_process';
import { parseWorkbenchUrl } from './parse-output';
import { asOptionalNumber } from './json-args';

export type WorkbenchHandle = {
  url: string;
  child?: ChildProcess;
  reused?: boolean;
};

export type StartWorkbenchOpts = {
  root: string;
  port?: unknown;
  cdpPort?: unknown;
  /** 探测已在听的工作台；测试可注入。 */
  probe?: (port: number) => Promise<boolean>;
  spawnUi?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  waitMs?: number;
};

async function defaultProbe(port: number): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 400);
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export async function findExistingWorkbench(
  probe: (port: number) => Promise<boolean> = defaultProbe,
  from = 5173,
  to = 5183,
): Promise<string | undefined> {
  for (let p = from; p <= to; p++) {
    if (await probe(p)) return `http://localhost:${p}/`;
  }
  return undefined;
}

function collectText(child: ChildProcess): { get: () => string } {
  let out = '';
  child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
  child.stderr?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
  return { get: () => out };
}

export async function startWorkbench(opts: StartWorkbenchOpts): Promise<WorkbenchHandle> {
  const probe = opts.probe ?? defaultProbe;
  const existing = await findExistingWorkbench(probe);
  if (existing) {
    return { url: existing, reused: true };
  }

  const uiPort = asOptionalNumber(opts.port);
  const cdpPort = asOptionalNumber(opts.cdpPort);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (uiPort) env.UI_PORT = String(uiPort);
  if (cdpPort) env.CDP_PORT = String(cdpPort);

  const spawnUi = opts.spawnUi ?? ((cmd, args, e) => spawn(cmd, args, {
    cwd: opts.root,
    env: e,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
  }));

  const child = spawnUi('npm', ['run', 'ui'], env);
  const buf = collectText(child);
  const deadline = Date.now() + (opts.waitMs ?? 20_000);

  while (Date.now() < deadline) {
    const url = parseWorkbenchUrl(buf.get());
    if (url) return { url: url.endsWith('/') ? url : `${url}/`, child, reused: false };
    if (child.exitCode !== null) {
      throw new Error(`工作台进程已退出（${child.exitCode}）: ${buf.get().slice(-800)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error(`工作台未在超时内打印 URL。输出: ${buf.get().slice(-800)}`);
}

export function stopWorkbench(handle: WorkbenchHandle | undefined): { stopped: boolean; url?: string; reused?: boolean } {
  if (!handle) return { stopped: false };
  if (handle.reused || !handle.child) {
    return { stopped: false, url: handle.url, reused: true };
  }
  try {
    handle.child.kill();
  } catch {
    /* 已退出 */
  }
  return { stopped: true, url: handle.url };
}
