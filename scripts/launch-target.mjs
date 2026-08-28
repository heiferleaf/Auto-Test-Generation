#!/usr/bin/env node
// 跨平台靶机启动器：拉起 Electron 软件并让它带 CDP 调试端口。
//
// 为什么是 Node 而不是 .cmd / .sh：
//   原来有三份 scripts/launch-*.cmd，Windows 批处理，路径写死在某台机器的个人目录里。
//   macOS / Linux 上根本跑不了，而且同一份逻辑维护两套（.cmd + .sh）必然漂移。
//   Node 自带跨平台，路径探测、幽灵口跳过、等待 /json 就绪都可以只写一遍。
//
// 用法（MCP 内部调用，也可人工跑）：
//   ATG_TARGET_EXE=<可执行文件路径> CDP_PORT=9244 node scripts/launch-target.mjs [--exe <path>] [--port <n>] [--dry-run]
//
// 输出：
//   成功时 stdout 必须含一行 `http://localhost:<port>/json`——MCP 靠正则解析它拿真实端口。
//   诊断信息一律走 stderr，避免污染被解析的 stdout。
//
// 退出码：0 就绪 / 1 失败

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const PLATFORM = platform();

/** 端口探测上限：从首选口往上试这么多个，避开幽灵口。 */
const PORT_TRIES = 12;
const READY_TIMEOUT_MS = 20_000;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const log = (msg) => process.stderr.write(`[launch] ${msg}\n`);

/** 某端口上 DevTools 是否真的在服务（不只是 TCP 在听）。 */
async function isLiveCdpPort(port) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: ac.signal });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data) && data.some((t) => t && typeof t === 'object' && 'webSocketDebuggerUrl' in t);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 端口是否已被占用（macOS/Linux 用 netstat，Windows 也兼容）。 */
async function isPortBusy(port) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal });
    return res.ok || res.status > 0;
  } catch {
    // fetch 失败说明没人听，或者听了但不接受这个请求——后者也算占用。
    return await probeRawPort(port);
  } finally {
    clearTimeout(timer);
  }
}

function probeRawPort(port) {
  return new Promise((resolve) => {
    // Node 的 net 比 shell 出去 grep 可靠，且跨平台一致。
    // 顶层 import 即可；这里保留 try/catch 是因为模块解析失败会让 Promise 永久 pending，
    // 进而把整个端口探测卡死。
    try {
      const sock = net.connect({ host: '127.0.0.1', port });
      const done = (busy) => {
        sock.destroy();
        resolve(busy);
      };
      sock.setTimeout(400);
      sock.on('connect', () => done(true));
      sock.on('timeout', () => done(false));
      sock.on('error', () => done(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * 从首选口开始找可用端口：
 * /json 已经在服务 → 直接用（说明软件已经开着且带调试端口）；
 * 被占但不服务 /json → 幽灵口，+1 再试。
 */
async function pickLivePort(preferred) {
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = preferred + i;
    if (await isLiveCdpPort(port)) return { port, alreadyLive: true };
    if (await isPortBusy(port)) {
      log(`port ${port} 被占用但 /json 无响应（幽灵口），试下一个`);
      continue;
    }
    return { port, alreadyLive: false };
  }
  return undefined;
}

/** 等 /json 就绪。软件冷启动到 DevTools 起 HttpServer 需要几秒。 */
async function waitForCdp(port, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLiveCdpPort(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 从 .app 的 Info.plist 读出 CFBundleExecutable——这是"这个 bundle 的主可执行文件名"的权威来源。
 * Electron 应用一定有这个键，且它不会指向 Helper。
 * 读不到（plist 是 XML 或缺失）就返回 undefined，交给调用方退化处理。
 */
function readBundleExecutable(appRoot, readFile) {
  const plistPath = join(appRoot, 'Contents', 'Info.plist');
  try {
    const text = readFile(plistPath, 'utf8');
    // 二进制 plist 里这个键值通常以明文出现，XML plist 里是 <key>/<string> 配对。
    const xml = text.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
    if (xml) return xml[1].trim();
    const loose = text.match(/CFBundleExecutable[^A-Za-z0-9]{0,8}([^\s<>;"]{1,64})/);
    if (loose) return loose[1].trim();
  } catch {
    /* 读不到就退化 */
  }
  return undefined;
}

/**
 * macOS：用户可能只给了 .app 目录，补成 Contents/MacOS 下的真实二进制。
 *
 * 为什么不能简单取目录里第一个文件：Electron 应用的 Contents/MacOS 下除了主程序还会有
 * `Code Helper` / `Code Helper (GPU)` 等辅助进程，按字典序它们排在 `Electron` 前面。
 * 拉起 Helper 不会监听 --remote-debugging-port，表现为干等到超时。
 *
 * 选取顺序：Info.plist 的 CFBundleExecutable → 名字像主程序的（排除 Helper）→ 唯一一个。
 *
 * io 参数用于测试注入，生产走 node:fs。
 */
export function resolveMacExe(exe, io = { existsSync, readdirSync, readFileSync }) {
  if (!exe.endsWith('.app') && !exe.endsWith('.app/')) return exe;
  const appRoot = exe.replace(/\/$/, '');
  const macosDir = join(appRoot, 'Contents', 'MacOS');
  if (!io.existsSync(macosDir)) return exe;

  const entries = io.readdirSync(macosDir).filter((f) => !f.startsWith('.'));
  if (entries.length === 0) return exe;

  const pick = (name) =>
    (name && entries.includes(name) ? name : undefined) ??
    entries.find((f) => f.toLowerCase() === String(name ?? '').toLowerCase());

  // 1) Info.plist 是权威来源
  const fromPlist = pick(readBundleExecutable(appRoot, io.readFileSync));
  if (fromPlist) return join(macosDir, fromPlist);

  // 2) 排除 Helper 之类的辅助进程
  const nonHelper = entries.filter((f) => !/helper|crashpad|framework/i.test(f));
  if (nonHelper.length === 1) return join(macosDir, nonHelper[0]);
  if (nonHelper.length > 1) {
    // 3) 多个候选取与 .app 同名的
    const appName = appRoot.split('/').pop().replace(/\.app$/, '');
    const sameName = nonHelper.find((f) => f.toLowerCase() === appName.toLowerCase());
    if (sameName) return join(macosDir, sameName);
    return join(macosDir, nonHelper[0]);
  }
  // 全是 Helper（异常 bundle），退回第一个总比报错好
  return join(macosDir, entries[0]);
}

/** Windows 常见安装位置兜底（用户没给路径时用，按靶机名猜）。 */
function windowsCandidates(name) {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const map = {
    vscode: [
      join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      join(pf, 'Microsoft VS Code', 'Code.exe'),
    ],
    codebuddy: [join(local, 'Programs', 'CodeBuddy CN', 'CodeBuddy CN.exe')],
    workbuddy: [join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')],
  };
  return map[name] ?? [];
}

function macCandidates(name) {
  const map = {
    vscode: [
      '/Applications/Visual Studio Code.app',
      join(homedir(), 'Applications', 'Visual Studio Code.app'),
    ],
    codebuddy: ['/Applications/CodeBuddy CN.app', join(homedir(), 'Applications', 'CodeBuddy CN.app')],
    workbuddy: ['/Applications/WorkBuddy.app', join(homedir(), 'Applications', 'WorkBuddy.app')],
  };
  return map[name] ?? [];
}

function linuxCandidates(name) {
  const map = {
    vscode: ['/usr/bin/code', '/usr/share/code/code', '/snap/bin/code'],
    codebuddy: ['/usr/bin/codebuddy', '/opt/CodeBuddy CN/codebuddy'],
    workbuddy: ['/usr/bin/workbuddy', '/opt/WorkBuddy/workbuddy'],
  };
  return map[name] ?? [];
}

/**
 * 按平台给出该靶机的候选路径（都失败才报错）。
 * 未识别的平台直接抛错——静默回落到 linux 候选会在 macOS 之外的系统上
 * 拿一堆不存在的路径去试，错误信息比显式失败难懂得多。
 */
function candidatesFor(name) {
  if (PLATFORM === 'win32') return windowsCandidates(name);
  if (PLATFORM === 'darwin') return macCandidates(name);
  if (PLATFORM === 'linux') return linuxCandidates(name);
  throw new Error(`不支持的平台 ${PLATFORM}（仅支持 win32 / darwin / linux）`);
}

/** 选出第一个真实存在的文件。 */
function firstExisting(paths) {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** 用户可以只给 .app 目录，这里统一解成可 spawn 的可执行文件。 */
function normalizeExe(exe) {
  if (PLATFORM === 'darwin') return resolveMacExe(exe);
  return exe;
}

async function main() {
  const exeArg = process.env.ATG_TARGET_EXE ?? argValue('--exe');
  const name = process.env.ATG_TARGET_NAME ?? argValue('--name');
  const portArg = Number(process.env.CDP_PORT ?? argValue('--port'));
  const dryRun = process.argv.includes('--dry-run');

  if (!Number.isFinite(portArg) || portArg <= 0) {
    log('缺少端口：传 --port 或设 CDP_PORT');
    process.exit(1);
  }

  // 用户显式给的路径优先；没给才按靶机名到平台默认位置找。
  let exe = exeArg;
  if (!exe) {
    if (!name) {
      log('需要 --exe（可执行文件完整路径）或 --name（靶机名，到默认安装位置找）');
      process.exit(1);
    }
    exe = firstExisting(candidatesFor(name)) ?? firstExisting(candidatesFor(name).map(normalizeExe));
    if (!exe) {
      log(`未找到 ${name} 的可执行文件。请用 --exe 直接给出完整路径。`);
      log(`  本平台（${PLATFORM}）已试过：${candidatesFor(name).join(', ') || '（该靶机无默认位置）'}`);
      process.exit(1);
    }
  }

  exe = normalizeExe(exe);

  if (!existsSync(exe)) {
    log(`可执行文件不存在：${exe}`);
    if (PLATFORM === 'darwin' && exe.endsWith('.app')) {
      log('macOS 上 .app 是目录，需要的是 Contents/MacOS 下的二进制文件。');
    }
    process.exit(1);
  }

  const picked = await pickLivePort(portArg);
  if (!picked) {
    log(`在 ${portArg}-${portArg + PORT_TRIES - 1} 内找不到可用端口`);
    process.exit(1);
  }
  const { port, alreadyLive } = picked;

  if (alreadyLive) {
    // 已经有带调试端口的实例在跑，再开一个会被转给旧实例（新进程会忽略 --remote-debugging-port）。
    log(`端口 ${port} 上已有 DevTools 在服务，不重复拉起`);
    process.stdout.write(`[ok] CDP is live: http://localhost:${port}/json\n`);
    return;
  }

  if (dryRun) {
    log(`dry-run：将拉起 ${exe} --remote-debugging-port=${port}`);
    process.stdout.write(`[ok] CDP is live: http://localhost:${port}/json\n`);
    return;
  }

  log(`拉起 ${exe} --remote-debugging-port=${port}`);

  // 隔离 user-data-dir：不隔离的话，已运行的实例会接管新进程，调试端口就不生效了。
  const args = [`--remote-debugging-port=${port}`];
  if (name === 'vscode') args.push('--disable-workspace-trust');
  const userData = join(
    process.env.TEMP ?? process.env.TMPDIR ?? '/tmp',
    `atg-${name ?? 'app'}-cdp-${port}`,
  );
  args.push(`--user-data-dir=${userData}`);

  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => {
    log(`拉起失败：${err.message}`);
    process.exit(1);
  });
  // 解绑父子关系：父进程（MCP / 终端）退出不应带走被测软件。
  child.unref();

  if (!(await waitForCdp(port))) {
    log(`软件可能已启动，但 DevTools 未在 ${port} 上就绪（超时 ${READY_TIMEOUT_MS}ms）`);
    log('若软件原本就在运行，它不会接受新的调试端口参数——请先完全退出再试。');
    process.exit(1);
  }

  // 这一行是契约：MCP 的 parseCdpPortFromLaunchOutput 靠它拿真实端口。
  process.stdout.write(`[ok] CDP is live: http://localhost:${port}/json\n`);
}

// 只在被直接执行时跑 main()。被 import（例如单测导 resolveMacExe）时不能顺带拉起进程，
// 也不能因为参数缺失而 process.exit。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log(`未捕获异常：${err?.stack ?? err}`);
    process.exit(1);
  });
}
