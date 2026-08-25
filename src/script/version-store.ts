// Git 式版本层：提交树 + 不可变更新（纯数据，无 UI / 无内核依赖）。
//
// 本模块只管"版本库状态"，不碰 DOM 也不依赖执行器/内核；UI 侧 `version-panel`
// 负责把状态画出来并把用户操作回调给这里（保 DIP：UiKernel 不上提版本）。
// 版本节点 = 最外层顺序组（control.kind==='sequence' 且位于 script.steps 顶层）；
// 一个 Script = 一条分支链，整个脚本库 = 一个仓库。7 项操作：commit/branch/
// switch/cherry-pick/history/tag/diff（砍 reset/merge/rebase）。
// 完整设计见 architecture.md §2.2。
//
// 不可变性（防静默改写历史）：
//   所有写操作返回**新** store，入参 `Script` 与原 store 均不被 mutate。
//   版本层若可原地改写，cherry-pick 改参就会污染源分支历史 —— 故强制不可变。
//
// 边界硬失败（CODEBUDDY.md §4.1）：
//   脏数据在"版本库入口"抛 `VersionStoreError`（而非在 UI 渲染层白屏）。
//   这跟 io.ts / 桥边界同族：失败留在数据入口，UI 层只接合法数据。

import type { Script, Step } from '../types/step';

/** 版本库入口的硬失败（与 io.ts 的 ScriptError 同族，但语义限定在版本操作）。 */
export class VersionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionStoreError';
  }
}

// ───────────────────────── 版本节点判定 ─────────────────────────

/**
 * 版本节点 = 最外层顺序组。
 * @param step 候选步
 * @param topIndex 该步在 `script.steps` 中的顶层下标；仅 `0` 视为顶层（多顶层步时
 *   约定第一条 sequence 为版本节点，其余顶层步视为"未纳入版本管理的游离步"——与
 *   "一个 Script = 一条分支链"的模型一致）。调用方负责传入正确下标。
 */
export function isVersionNode(step: Step, topIndex: number): boolean {
  if (topIndex !== 0) return false; // 仅最外层
  return step.control?.kind === 'sequence';
}

// ───────────────────────── 提交树模型 ─────────────────────────

export type Commit = {
  /** 提交哈希（本地单调递增 id，非加密哈希 —— 够版本层用）。 */
  hash: string;
  /** 父提交 hash；首提交为 null。 */
  parent: string | null;
  message: string;
  /** 该提交锁定的脚本快照（深拷贝，不可变）。 */
  script: Script;
  /** 标签（可选，一对多）。 */
  tags: string[];
};

export type Branch = {
  name: string;
  /** 该分支当前所指提交 hash（HEAD）。 */
  head: string;
};

export type VersionStore = {
  branches: Branch[];
  /** hash → 提交（扁平表，便于 O(1) 查父链）。 */
  commits: Record<string, Commit>;
  /** 当前所在分支名。 */
  currentBranch: string;
  /** 提交计数，用于生成 hash。 */
  seq: number;
};

// ───────────────────────── 不可变辅助 ─────────────────────────

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function newHash(seq: number): string {
  return `c${seq.toString(36)}`;
}

// ───────────────────────── 构造 / 查询 ─────────────────────────

/**
 * 建仓：以初始脚本在 `main` 分支提交第 0 次提交。
 * @param script 初始脚本（会被深拷贝，入参不被 mutate）
 * @param message 首次提交信息
 */
export function createStore(script: Script, message: string): VersionStore {
  if (!script || typeof script !== 'object') {
    throw new VersionStoreError('createStore: script 必须是合法 Script 对象');
  }
  const s = clone(script);
  const hash = newHash(0);
  const commit: Commit = { hash, parent: null, message, script: s, tags: [] };
  return {
    branches: [{ name: 'main', head: hash }],
    commits: { [hash]: commit },
    currentBranch: 'main',
    seq: 1,
  };
}

/** 当前分支 HEAD 所指脚本（深拷贝返回，调用方拿到的是独立副本）。 */
export function getCurrentScript(store: VersionStore): Script {
  const head = currentBranchHead(store);
  return clone(store.commits[head].script);
}

function currentBranchHead(store: VersionStore): string {
  const b = store.branches.find((x) => x.name === store.currentBranch);
  if (!b) throw new VersionStoreError(`当前分支 ${store.currentBranch} 不存在`);
  return b.head;
}

/** 历史（按时间倒序，最新在前）。 */
export function getHistory(store: VersionStore): Commit[] {
  const head = currentBranchHead(store);
  const out: Commit[] = [];
  let cur: string | null = head;
  while (cur) {
    const c: Commit | undefined = store.commits[cur];
    if (!c) break;
    out.push(c);
    cur = c.parent;
  }
  return out;
}

export function getBranches(store: VersionStore): string[] {
  return store.branches.map((b) => b.name);
}

export function getTags(store: VersionStore): string[] {
  const tags: string[] = [];
  for (const c of Object.values(store.commits)) tags.push(...c.tags);
  return tags;
}

// ───────────────────────── 写操作（均返回新 store）─────────────────────────

/**
 * 在当前分支提交新脚本。
 * @param store 原 store（不被 mutate）
 * @param message 提交信息
 * @param script 新脚本（会被深拷贝）
 */
export function commit(store: VersionStore, message: string, script: Script): VersionStore {
  if (!script || typeof script !== 'object') {
    throw new VersionStoreError('commit: script 必须是合法 Script 对象');
  }
  const parent = currentBranchHead(store);
  const hash = newHash(store.seq);
  const newCommit: Commit = { hash, parent, message, script: clone(script), tags: [] };
  const commits = { ...store.commits, [hash]: newCommit };
  const branches = store.branches.map((b) =>
    b.name === store.currentBranch ? { ...b, head: hash } : b,
  );
  return { ...store, commits, branches, seq: store.seq + 1 };
}

/** 从当前 HEAD 派生新分支（当前分支不变）。 */
export function branch(store: VersionStore, name: string): VersionStore {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new VersionStoreError('branch: 分支名不能为空');
  }
  if (store.branches.some((b) => b.name === name)) {
    throw new VersionStoreError(`branch: 分支 ${name} 已存在`);
  }
  const head = currentBranchHead(store);
  const branches = [...store.branches, { name, head }];
  return { ...store, branches };
}

/** 切换当前分支。 */
export function switchTo(store: VersionStore, name: string): VersionStore {
  if (!store.branches.some((b) => b.name === name)) {
    throw new VersionStoreError(`switchTo: 分支 ${name} 不存在`);
  }
  return { ...store, currentBranch: name };
}

/**
 * 把某个提交（sourceCommitHash）里的版本节点 cherry-pick 到**当前分支**，形成新提交。
 *
 * 为何以"提交 hash"而非"源分支名 + 节点 id"定位：版本面板展示的是当前分支的
 * 整条历史（含祖先提交），而祖先提交不一定在当前分支 HEAD 上。若按"源分支 HEAD
 * 找节点"实现，点历史里的非 HEAD 提交就会因节点不在 HEAD 而抛错——这正是初版
 * 在 shell 接线里踩的坑（code-review 指出）。以"提交 hash"直接定位该提交锁定的
 * 脚本快照，才是真正的 Git cherry-pick 语义（"把某次提交的内容摘到当前 HEAD"），
 * 且跨分支天然成立（任意分支的任意提交都可摘）。
 *
 * @param store 当前 store（新提交落到 store.currentBranch）
 * @param sourceCommitHash 要摘取的提交 hash
 * @param patch 可选：对新提交脚本做变换（如改 id 避免冲突），落入新提交而非改写源
 */
export function cherryPick(
  store: VersionStore,
  sourceCommitHash: string,
  patch?: (node: Step) => Step,
): VersionStore {
  const srcCommit = store.commits[sourceCommitHash];
  if (!srcCommit) {
    throw new VersionStoreError(`cherryPick: 提交 ${sourceCommitHash} 不存在`);
  }
  const versionNode = srcCommit.script.steps.find(
    (s, i) => isVersionNode(s, i),
  );
  if (!versionNode) {
    throw new VersionStoreError(`cherryPick: 提交 ${sourceCommitHash} 无版本节点（顶层须为 sequence 组）`);
  }
  // 不可变：源提交不动；当前分支以"源节点克隆 + 可选 patch"作为新顶层步提交。
  const picked = patch ? patch(clone(versionNode)) : clone(versionNode);
  const newScript: Script = {
    ...clone(store.commits[currentBranchHead(store)].script),
    steps: [picked],
  };
  return commit(store, `cherry-pick ${sourceCommitHash}`, newScript);
}

/** 给当前 HEAD 打标签。 */
export function tag(store: VersionStore, name: string): VersionStore {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new VersionStoreError('tag: 标签名不能为空');
  }
  const head = currentBranchHead(store);
  const existing = store.commits[head];
  if (existing.tags.includes(name)) {
    throw new VersionStoreError(`tag: 标签 ${name} 已存在`);
  }
  const commits = {
    ...store.commits,
    [head]: { ...existing, tags: [...existing.tags, name] },
  };
  return { ...store, commits };
}

// ───────────────────────── diff ─────────────────────────

export type ScriptDiff = {
  added: string[];
  removed: string[];
  modified: string[];
};

/**
 * 结构化比较两个脚本（按 step id 对齐，**递归**收集所有层级的步）。
 * 返回新增/删除/修改的步骤 id 列表。
 * 不抛错：相同脚本返回空差异；空脚本也不崩。
 *
 * 为何递归而非仅顶层：版本节点是 sequence 组，其 children 含嵌套步；
 * 改一个嵌套步的字段（如 R6 版本更新修复参数）必须被 diff 捕获，
 * 否则 diff 只能看到"顶层 g1 变了"而定位不到真正改动的子步。
 */
export function diffScripts(a: Script, b: Script): ScriptDiff {
  const aById = flatten(a);
  const bById = flatten(b);

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [id, bs] of bById) {
    if (!aById.has(id)) added.push(id);
    else if (!stepEqual(aById.get(id)!, bs)) modified.push(id);
  }
  for (const id of aById.keys()) {
    if (!bById.has(id)) removed.push(id);
  }
  return { added, removed, modified };
}

/** 递归展平：所有层级的步按 id 收集（含嵌套 children）。 */
function flatten(script: Script): Map<string, Step> {
  const map = new Map<string, Step>();
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      map.set(s.id, s);
      if (s.children?.length) walk(s.children);
    }
  };
  walk(script.steps);
  return map;
}

function stepEqual(a: Step, b: Step): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
