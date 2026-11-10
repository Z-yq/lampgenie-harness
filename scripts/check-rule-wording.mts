#!/usr/bin/env tsx
/**
 * 规则旧措辞门禁 CLI(M9):扫 docs/**\/*.md 与根 AGENTS.md 里的「旧说法」。
 *
 * 用法:tsx scripts/check-rule-wording.mts [--json] [--root <dir>]
 * 退出码:0 = 干净(无命中/无表);2 = 有命中(旧说法待同步);1 = 表坏/读取错误。
 */
import { loadWordingTable, scanRuleWording } from "../apps/gateway/src/startup-freshness.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? String(args[rootIdx + 1] ?? process.cwd()) : process.cwd();

const table = loadWordingTable(root);
if (!table.ok) {
  if (json) console.log(JSON.stringify({ ok: false, hints: [], error: table.error }));
  else console.error(`[旧措辞门禁] ${table.error}`);
  process.exit(1);
}

const res = scanRuleWording({ repoRoot: root, rules: table.rules });

if (json) console.log(JSON.stringify({ ok: res.ok, hints: res.hints, ...(res.error ? { error: res.error } : {}) }, null, 2));
else if (res.hints.length === 0) console.log(`[旧措辞门禁] 干净:${root} 无旧说法残留(规则 ${table.rules.length} 条)`);
else {
  console.log(`[旧措辞门禁] 命中 ${res.hints.length} 处旧说法(改成现行规则):`);
  for (const h of res.hints) console.log(`  ${h.file}:${h.line} 旧「${h.old}」→ 现行「${h.new}」`);
}

process.exit(res.hints.length > 0 ? 2 : 0);
