#!/usr/bin/env tsx
/**
 * 基线新鲜度 CLI():量当前仓(cwd 仓根)相对上游的 behind/ahead 并打印。
 * 用法:tsx scripts/freshness.mts [--json] [--fetch] [--base <ref>] [--upstream <ref>] [--max-ahead <n>]
 * --json 机器可读(缺省就是 JSON 输出,本开关为显式兼容保留)
 * --fetch 先 git fetch <remote> 再计数(联网;失败 → state=unknown 不抛)
 * 退出码:0 = 量到结果(含 behind/diverged/unknown);2 = 参数错误。
 */
import { readBaselineStatus, resolveUpstream, type GitRun } from "../apps/gateway/src/startup-freshness.ts";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const asJson = true; // 缺省即输出 JSON(--json 为显式同义开关)
const fetch = args.includes("--fetch");
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = flag("--base");
const upstream = flag("--upstream");
const maxAheadRaw = flag("--max-ahead");
if (maxAheadRaw !== undefined && !Number.isFinite(Number(maxAheadRaw))) {
  console.error(`--max-ahead 需要数字,收到 ${maxAheadRaw}`);
  process.exit(2);
}
const run: GitRun = (a, o) => String(execFileSync("git", a, {
  cwd: o?.cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  ...(o?.timeoutMs ? { timeout: o.timeoutMs } : {}),
}));

const repoRoot = process.cwd();
const status = readBaselineStatus({
  repoRoot,
  ...(base ? { baseRef: base } : {}),
  ...(upstream ? { upstreamRef: upstream } : {}),
  ...(maxAheadRaw !== undefined ? { maxAhead: Number(maxAheadRaw) } : {}),
  fetch,
  run,
});

if (asJson) {
  console.log(JSON.stringify({ repoRoot, resolvedUpstream: resolveUpstream(repoRoot, run, upstream), ...status }, null, 2));
} else {
  console.log(`state=${status.state} behind=${status.behind} ahead=${status.ahead} upstream=${status.upstreamRef ?? "none"} (${status.durationMs}ms)`);
}
