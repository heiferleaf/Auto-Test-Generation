// M3-R5 Git 式版本面板（SRP 渲染组件）。
//
// 职责边界（与 CfgView 同族）：本组件只负责"把 VersionStore 状态画出来" +
// "把用户操作经回调上报"，不决定版本操作的具体语义（由 UiShell 编排，
// 或后续直接调 version-store 的纯函数）。**不 import UiKernel / 执行器 / playwright**
// （DIP）：版本状态在 UI 侧/本地，UiKernel 不上提版本（架构文档 §2.2）。
//
// 设计取舍（复用 CfgView 已验证的模式）：
//   - mount 级单一点击委托 + `closest('[data-branch]')`：真实用户点的是 chip 内部文字，
//     e.target≠chip 本身，逐节点 `target===currentTarget` 会掩盖点击（R4 踩过的坑）。
//   - update 幂等：先清再画，重复 update 不产生重复节点。
//   - 渲染层只消费"已通过 version-store 入口校验"的合法 store；脏数据应在
//     version-store 入口抛 VersionStoreError（§4.1），不在此白屏。

import type { VersionStore, Commit } from '../script/version-store';
import { getHistory, getTags, getBranches } from '../script/version-store';

export type VersionPanelOptions = {
  mount: HTMLElement;
  store: VersionStore;
  /** 点分支 chip：请求切换分支。 */
  onSwitch?: (branchName: string) => void;
  /** 点历史条的 cherry-pick：请求摘取该提交。 */
  onCherryPick?: (commitHash: string) => void;
  /** 是否允许 cherry-pick（如当前已在源分支则不允许）；默认允许。 */
  canCherryPick?: (commit: Commit) => boolean;
};

export class VersionPanel {
  private mount: HTMLElement;
  private onSwitch?: (branchName: string) => void;
  private onCherryPick?: (commitHash: string) => void;
  private canCherryPick: (commit: Commit) => boolean;
  /** 已绑定委托的挂载元素（避免重复绑定造成一次点击多次上报）。 */
  private delegatedMounts = new WeakSet<HTMLElement>();

  constructor(opts: VersionPanelOptions) {
    this.mount = opts.mount;
    this.onSwitch = opts.onSwitch;
    this.onCherryPick = opts.onCherryPick;
    this.canCherryPick = opts.canCherryPick ?? (() => true);
    this.bindDelegation(this.mount);
    this.update(opts.store);
  }

  private bindDelegation(mount: HTMLElement): void {
    if (this.delegatedMounts.has(mount)) return; // 幂等
    this.delegatedMounts.add(mount);
    mount.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      // 分支切换
      const branchHit = target?.closest('[data-branch]') as HTMLElement | null;
      if (branchHit && mount.contains(branchHit)) {
        const name = branchHit.getAttribute('data-branch');
        if (name && !branchHit.classList.contains('is-current')) {
          this.onSwitch?.(name);
          return;
        }
      }
      // cherry-pick 按钮（在 history 条内）
      const cpHit = target?.closest('[data-action="cherry-pick"]') as HTMLElement | null;
      if (cpHit && mount.contains(cpHit)) {
        const hash = cpHit.getAttribute('data-cp-commit');
        if (hash) this.onCherryPick?.(hash);
      }
    });
  }

  /** 重新绑定挂载区（render 全量 innerHTML='' 后旧 mount 脱离文档）。 */
  rebindMount(mount: HTMLElement): void {
    this.mount = mount;
    this.bindDelegation(mount);
  }

  /** 从 store 重绘（幂等）。 */
  update(store: VersionStore): void {
    this.mount.innerHTML = '';
    this.renderBranches(store);
    this.renderTags(store);
    this.renderHistory(store);
  }

  private renderBranches(store: VersionStore): void {
    const wrap = document.createElement('div');
    wrap.className = 'ui-shell-ver-branches';
    wrap.setAttribute('data-ver-branches', 'true');
    const title = document.createElement('div');
    title.className = 'ui-shell-ver-title';
    title.textContent = '分支';
    wrap.appendChild(title);

    for (const name of getBranches(store)) {
      const chip = document.createElement('button');
      chip.className = 'ui-shell-ver-branch';
      chip.setAttribute('data-branch', name);
      const isCurrent = name === store.currentBranch;
      if (isCurrent) chip.classList.add('is-current');
      // 内部文字节点（真实用户点击落点），closest 仍能命中 chip。
      const label = document.createElement('span');
      label.className = 'ui-shell-ver-branch-label';
      label.setAttribute('data-branch-label', 'true');
      label.textContent = name + (isCurrent ? ' ●' : '');
      chip.appendChild(label);
      wrap.appendChild(chip);
    }
    this.mount.appendChild(wrap);
  }

  private renderTags(store: VersionStore): void {
    const tags = getTags(store);
    if (tags.length === 0) return;
    const wrap = document.createElement('div');
    wrap.className = 'ui-shell-ver-tags';
    wrap.setAttribute('data-ver-tags', 'true');
    const title = document.createElement('div');
    title.className = 'ui-shell-ver-title';
    title.textContent = '标签';
    wrap.appendChild(title);
    for (const t of tags) {
      const el = document.createElement('span');
      el.className = 'ui-shell-ver-tag';
      el.setAttribute('data-tag', t);
      el.textContent = t;
      wrap.appendChild(el);
    }
    this.mount.appendChild(wrap);
  }

  private renderHistory(store: VersionStore): void {
    const hist = getHistory(store);
    const wrap = document.createElement('div');
    wrap.className = 'ui-shell-ver-history';
    wrap.setAttribute('data-ver-history', 'true');
    const title = document.createElement('div');
    title.className = 'ui-shell-ver-title';
    title.textContent = '历史';
    wrap.appendChild(title);

    for (const c of hist) {
      const row = document.createElement('div');
      row.className = 'ui-shell-ver-commit';
      row.setAttribute('data-commit', c.hash);
      const msg = document.createElement('span');
      msg.className = 'ui-shell-ver-commit-msg';
      msg.textContent = `${c.hash} ${c.message}`;
      row.appendChild(msg);
      if (this.canCherryPick(c)) {
        const cp = document.createElement('button');
        cp.className = 'ui-shell-ver-cp';
        cp.setAttribute('data-action', 'cherry-pick');
        // 用独立属性承载 hash，避免与行节点的 data-commit 冲突（行已置 data-commit）。
        cp.setAttribute('data-cp-commit', c.hash);
        cp.textContent = '摘取';
        row.appendChild(cp);
      }
      wrap.appendChild(row);
    }
    this.mount.appendChild(wrap);
  }
}
