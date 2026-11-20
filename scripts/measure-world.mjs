#!/usr/bin/env node
/**
 * measure-world.mjs — codesense CLI 冷启动经验证(可复现)。
 * 用法:
 * node scripts/measure-world.mjs --runs 5 --label before roots project modules "entrypoints --limit 20"
 * node scripts/measure-world.mjs --runs 5 --label after world "roots"
 * 口径:每条命令独立起进程(与 agent 调 CLI 的方式一致),用 hrtime 量墙钟,
 * 输出中位数/最小/最大/全部样本 + stdout 字节数。耗时不含本脚本自身。
 * 单条命令参数含空格时用引号整体传入(脚本按空白切分,不做 shell 展开)。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages/code-sense-cli/dist/cli.js");
const NODE = process.execPath;

const argv = process.argv.slice(2);
let runs = 5;
let label = "run";
const commands = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--runs") runs = Number(argv[++i]);
  else if (a === "--label") label = argv[++i];
  else commands.push(a);
}
if (commands.length === 0) commands.push("roots");
if (!existsSync(CLI)) {
  console.error(`[measure] 缺 CLI 产物: ${CLI}(先 pnpm --filter @lampgenie/code-sense-cli build)`);
  process.exit(2);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s[Math.floor(s.length / 2)];
  return s.length % 2 === 0 ? (s[s.length / 2 - 1] + m) / 2 : m;
};

console.log(`# label=${label} runs=${runs} node=${process.version} cli=${CLI}`);
console.log(`# 机器: ${process.platform} ${process.arch} · cwd=${ROOT}`);
console.log("");
console.log("| 命令 | 中位(ms) | 最小 | 最大 | 输出字节 | 样本 |");
console.log("|---|---|---|---|---|---|");

for (const raw of commands) {
  const args = raw.split(/\s+/).filter(Boolean);
  const samples = [];
  let bytes = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(NODE, [CLI, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    if (r.status !== 0) {
      console.error(`[measure] \`${raw}\` 失败(status=${r.status}): ${(r.stderr || "").slice(0, 400)}`);
      process.exit(1);
    }
    samples.push(Math.round(dt));
    bytes = (r.stdout || "").length;
  }
  console.log(`| \`${raw}\` | ${Math.round(median(samples))} | ${Math.min(...samples)} | ${Math.max(...samples)} | ${bytes} | ${samples.join(", ")} |`);
}
