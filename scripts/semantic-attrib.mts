#!/usr/bin/env -S node --experimental-strip-types
/**
 * 语义归因 CLI(RSI 13th 机制写通道。
 * 用法:node --experimental-strip-types scripts/semantic-attrib.mts --root <dir> --chain <id> --class <c> --verdict <v> --confidence <n> --reason <text> --model <m>
 * 写一条 enrichment 行到 rework-chains.jsonl(append-only,不改原始 detect 行)。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

function arg(name: string): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === name) return argv[i + 1];
  return undefined;
}

const root = arg("--root");
const chainId = arg("--chain");
const defectClass = arg("--class");
const verdict = arg("--verdict");
const confidence = Number(arg("--confidence"));
const reason = arg("--reason") ?? "";
const model = arg("--model") ?? "unknown";
const at = Date.now();

const VALID_CLASSES = ["contract","boundary","concurrency","resource","protocol","logic","regression"];
const VALID_VERDICTS = ["preventable","drift","unknown"];

if (!root || !chainId || !defectClass || !verdict || !Number.isFinite(confidence)) {
  console.error("缺少参数:需要 --root --chain --class --verdict --confidence");
  process.exit(2);
}
if (!VALID_CLASSES.includes(defectClass)) { console.error(`非法 class:${defectClass}`); process.exit(2); }
if (!VALID_VERDICTS.includes(verdict)) { console.error(`非法 verdict:${verdict}`); process.exit(2); }
if (confidence < 0 || confidence > 1) { console.error("confidence 须 0-1"); process.exit(2); }

const ledger = join(root, ".genie", "rsi", "rework-chains.jsonl");
mkdirSync(dirname(ledger), { recursive: true });
const line = JSON.stringify({
  v: 1, type: "enrichment", at, chainId,
  result: { chainId, defectClass, verdict, confidence, reason, model, version: 1, at },
});
appendFileSync(ledger, line + "\n", "utf8");
console.log(JSON.stringify({ ok: true, chainId, defectClass, verdict, confidence }));
