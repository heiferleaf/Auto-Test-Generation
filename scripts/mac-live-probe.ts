// 真机探针：连上 mac 上跑着的 CodeBuddy，走一遍"列层 → 逐层快照"。
// 这不是单测，是人工验证脚本：Mac 上没有 GUI 自动化，只能靠它确认 CDP 链路真的通。
//
// 用法：CDP_PORT=9222 npx tsx scripts/mac-live-probe.ts
//
// 注意：CdpAdapter.snapshot() 不接受参数，它只拍"当前选中层"。
// 所以逐层快照的正确姿势是 selectTarget(id) → snapshot()，不能指望传参。

import { PlaywrightCdpAdapter } from '../src/cdp/adapter';

const port = Number(process.env.CDP_PORT ?? 9222);

/** 取快照的指纹：节点数 + 前几个节点的文本拼接，用来判断两层是否真的不同。 */
function fingerprint(nodes: { text?: string; name?: string }[]): string {
  const head = nodes
    .slice(0, 6)
    .map((n) => (n.text ?? n.name ?? '').slice(0, 20).replace(/\n/g, ' '))
    .join(' | ');
  return `${nodes.length} 个节点 :: ${head}`;
}

async function main() {
  const adapter = new PlaywrightCdpAdapter();
  console.log(`[probe] 连接 127.0.0.1:${port} ...`);
  await adapter.connect({ port });
  console.log('[probe] 已连接');

  const targets = await adapter.refreshTargets();
  console.log(`[probe] 页面层 ${targets.length} 个：`);
  for (const t of targets) {
    console.log(`  - ${t.id.slice(0, 8)}  type=${t.type}  main=${!!t.isMain}`);
  }

  const seen = new Map<string, string>();
  for (const t of targets) {
    try {
      adapter.selectTarget(t.id);
      const nodes = await adapter.snapshot();
      const fp = fingerprint(nodes);
      seen.set(t.id, fp);
      console.log(`\n[probe] ${t.id.slice(0, 8)} (${t.type}) → ${fp}`);
      for (const n of nodes.slice(0, 5)) {
        console.log(`   role=${n.role ?? '-'} name=${JSON.stringify((n.name ?? '').slice(0, 24))} text=${JSON.stringify((n.text ?? '').slice(0, 24))}`);
      }
    } catch (e) {
      console.log(`\n[probe] ${t.id.slice(0, 8)} (${t.type}) 快照失败: ${e?.message ?? e}`);
    }
  }

  // 关键判定：各层快照是否真的不同。全同说明 target 切换没生效。
  const unique = new Set(seen.values());
  console.log(`\n[probe] 判定：${seen.size} 层，${unique.size} 种不同快照 → ${unique.size === seen.size ? '各层独立 ✅' : '有层返回相同快照 ❌'}`);

  await adapter.disconnect();
  console.log('[probe] 断开，完成');
}

main().catch((e) => {
  console.error('[probe] 失败:', e?.message ?? e);
  process.exit(1);
});
