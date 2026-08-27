// 生产会话：持有 PlaywrightCdpAdapter、工作台子进程、上次 launch 端口。
// 测试不走这里，而是直接注入 McpDeps。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PlaywrightCdpAdapter } from '../cdp/adapter';
import type { InteractionEvent } from '../recorder/recorder';
import type { Script } from '../types/step';
import { runLaunchTarget } from './launch-target';
import { startWorkbench, stopWorkbench, findExistingWorkbench, type WorkbenchHandle } from './workbench';
import { rpcLoadScript } from './bridge-rpc';
import type { McpDeps } from './dispatch';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(here, '..', '..');

/** 从 netstat 文本取出正在 LISTEN 该 TCP 端口的 PID。 */
export function pidsListeningOnPort(netstatOut: string, port: number): number[] {
  const pids: number[] = [];
  const needle = `:${port}`;
  for (const line of (netstatOut ?? '').split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    // 要求 `:port` 后是空白，避免 9222 误伤 19222。
    const idx = line.indexOf(needle);
    if (idx < 0) continue;
    const after = line[idx + needle.length];
    if (after && after !== ' ' && after !== '\t') continue;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(pid) && pid > 0) pids.push(pid);
  }
  return [...new Set(pids)];
}

async function killPort(port: number): Promise<number[]> {
  const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true }).catch(() => ({ stdout: '' }));
  const pids = pidsListeningOnPort(String(stdout), port).filter((p) => p !== process.pid);
  for (const pid of pids) {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined);
  }
  return pids;
}

export function createLiveSession(root = PROJECT_ROOT): McpDeps & { dispose: () => Promise<void> } {
  const inner = new PlaywrightCdpAdapter();
  let lastPort: number | undefined;
  let workbench: WorkbenchHandle | undefined;
  const recorded: InteractionEvent[] = [];

  const origConnect = inner.connect.bind(inner);
  // 实例上覆盖：Agent 可先 launch-target 再 app.connect 不带 port。
  (inner as unknown as { connect: typeof origConnect }).connect = async (opts) => {
    const o = opts ?? {};
    return origConnect({ ...o, port: o.port ?? lastPort });
  };

  const deps: McpDeps & { dispose: () => Promise<void> } = {
    adapter: inner,
    recorded,
    async launchTarget(opts) {
      const result = await runLaunchTarget({ root, name: opts.name, port: opts.port });
      lastPort = result.port;
      return result;
    },
    async stopTarget(opts) {
      const port = opts?.port ?? lastPort;
      if (!port) return { stopped: false };
      const pids = await killPort(port);
      await inner.disconnect().catch(() => undefined);
      if (lastPort === port) lastPort = undefined;
      return { stopped: pids.length > 0, port };
    },
    async startWorkbench(opts) {
      if (workbench?.url && workbench.child && workbench.child.exitCode === null) {
        return { url: workbench.url, reused: false };
      }
      workbench = await startWorkbench({
        root,
        port: opts?.port,
        cdpPort: opts?.cdpPort ?? lastPort,
      });
      return { url: workbench.url, reused: workbench.reused };
    },
    async stopWorkbench() {
      const result = stopWorkbench(workbench);
      if (result.stopped) workbench = undefined;
      return result;
    },
    async loadScript(raw: unknown): Promise<Script> {
      let url = workbench?.url;
      if (!url) url = await findExistingWorkbench();
      if (!url) {
        throw new Error('工作台未启动，请先调用 workbench.start（或本机先 npm run ui）');
      }
      if (!workbench) workbench = { url, reused: true };
      return rpcLoadScript({ workbenchUrl: url, raw });
    },
    async dispose() {
      await inner.disconnect().catch(() => undefined);
      stopWorkbench(workbench);
    },
  };
  return deps;
}
