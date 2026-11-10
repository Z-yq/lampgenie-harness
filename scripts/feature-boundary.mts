#!/usr/bin/env node
/**
 * 语义功能影响边界 CLI(语义边界 2026-10):采集一份影响边界简报 / 落盘语义采纳 / 输出文本或 JSON 报告。
 * 纯表面层:所有采集与判定逻辑在
 *   packages/harness-runtime/src/agent/feature-boundary.ts(buildImpactBrief / canWriteE2E / FB_CODES)
 *   apps/gateway/src/feature-boundary-store.ts(.genie/rsi/boundaries 落盘 / 输入形状容错 / drift 聚合 / 报告文本)
 * 本文件只做 argv 解析、输出与退出码映射。
 * 用法:node --experimental-strip-types scripts/feature-boundary.mts \
 *        --root <dir> --feature <json> --surfaces <json> --code <json> [--accept-by <who>] [--json] [--out <file>]
 * 退出码:0 成功且 E2E 允许(--help 也 0)/ 1 参数错误 / 2 E2E 阻塞或输入缺失(collectBrief.ok=false)。
 */
import fs from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import { canWriteE2E } from "../packages/harness-runtime/src/agent/feature-boundary.ts";
import {
  acceptSemantics,
  collectBrief,
  report,
  type CollectBriefOpts,
} from "../apps/gateway/src/feature-boundary-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_BLOCKED = 2;

const VALUE_FLAGS = new Set(["root", "feature", "surfaces", "code", "accept-by", "out"]);
const BOOL_FLAGS = new Set(["json", "help"]);

type Parsed = { values: Map<string, string>; flags: Set<string>; unknown: string[] };

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      unknown.push(raw);
      continue;
    }
    const name = raw.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        values.set(name, "");
        continue;
      }
      values.set(name, next);
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    unknown.push(raw);
  }
  return { values, flags, unknown };
}

function helpText(): string {
  return [
    "用法:node --experimental-strip-types scripts/feature-boundary.mts --root <dir> --feature <json> --surfaces <json> --code <json>",
    "        [--accept-by <who>] [--json] [--out <file>] [--help]",
    "  --root <dir>         仓库根(缺省 process.cwd());state 落在 <root>/.genie/rsi/boundaries/",
    "  --feature <json>     语义功能 JSON(SemanticFeature 或 {feature} / {features:[...]})",
    "  --surfaces <json>    UI 表面 JSON(UISurface[] 或 {surfaces:[...]})",
    "  --code <json>        代码引用 JSON(CodeRef[] 或 {codeRefs:[...]} / {code:[...]})",
    "  --accept-by <who>    落盘语义采纳(再采集一次,把 accepted 读回来)",
    "  --json               结构化输出(ok/featureId/items/driftCandidates/unresolvedOwners/depth3Required/...)",
    "  --out <file>         把输出写到文件(目录不存在则创建)",
    "  --help               本帮助",
    "退出码:0 成功且 E2E 允许 / 1 参数错误 / 2 E2E 阻塞或输入缺失",
  ].join("\n");
}

function writeOut(out: string | undefined, body: string): void {
  if (out === undefined || out === "") return;
  fs.mkdirSync(dirname(resolvePath(out)), { recursive: true });
  fs.writeFileSync(out, body, "utf-8");
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = parsed.flags.has("json");
  const get = (name: string): string | undefined => {
    const value = parsed.values.get(name);
    return value === undefined || value === "" ? undefined : value;
  };

  if (parsed.flags.has("help")) {
    process.stdout.write(`${helpText()}\n`);
    return EXIT_OK;
  }
  if (parsed.flags.size === 0 && parsed.values.size === 0) {
    process.stderr.write(`${helpText()}\n`);
    return EXIT_USAGE;
  }
  if (parsed.unknown.length > 0) {
    process.stderr.write(`未知参数:${parsed.unknown.join(" ")}\n${helpText()}\n`);
    return EXIT_USAGE;
  }

  const featureFile = get("feature");
  const surfacesFile = get("surfaces");
  const codeFile = get("code");
  const missing = [
    featureFile === undefined ? "--feature" : "",
    surfacesFile === undefined ? "--surfaces" : "",
    codeFile === undefined ? "--code" : "",
  ].filter((item) => item !== "");
  if (missing.length > 0) {
    process.stderr.write(`缺少必填参数:${missing.join(" ")}\n${helpText()}\n`);
    return EXIT_USAGE;
  }

  const root = resolvePath(get("root") ?? process.cwd());
  const opts: CollectBriefOpts = { featureFile: featureFile!, surfacesFile: surfacesFile!, codeFile: codeFile! };

  let collected = collectBrief(root, opts);
  if (!collected.ok || collected.brief === undefined) {
    const codes = collected.codes;
    const body = json
      ? `${JSON.stringify({ ok: false, codes, exitCode: EXIT_BLOCKED }, null, 2)}\n`
      : report(root, opts).text;
    process.stdout.write(body);
    writeOut(get("out"), body);
    return EXIT_BLOCKED;
  }

  const acceptBy = get("accept-by");
  if (acceptBy !== undefined) {
    const accepted = acceptSemantics(root, collected.brief.featureId, { by: acceptBy, brief: collected.brief });
    if (!accepted.ok) {
      const body = json
        ? `${JSON.stringify({ ok: false, codes: accepted.codes, exitCode: EXIT_USAGE }, null, 2)}\n`
        : `语义采纳失败:${accepted.codes.join(", ")}\n`;
      process.stdout.write(body);
      writeOut(get("out"), body);
      return EXIT_USAGE;
    }
    const recollected = collectBrief(root, opts);
    if (!recollected.ok || recollected.brief === undefined) {
      const body = json
        ? `${JSON.stringify({ ok: false, codes: recollected.codes, exitCode: EXIT_BLOCKED }, null, 2)}\n`
        : `采集失败:${recollected.codes.join(", ")}\n`;
      process.stdout.write(body);
      writeOut(get("out"), body);
      return EXIT_BLOCKED;
    }
    collected = recollected;
  }

  const brief = collected.brief;
  const body = json
    ? `${JSON.stringify(
        {
          ok: true,
          featureId: brief.featureId,
          items: brief.items,
          driftCandidates: brief.driftCandidates,
          unresolvedOwners: brief.unresolvedOwners,
          depth3Required: brief.depth3Required,
          semanticsAccepted: brief.semanticsAccepted ?? null,
          canWriteE2E: canWriteE2E(brief),
          codes: brief.codes,
        },
        null,
        2)}\n`
    : report(root, opts).text;
  process.stdout.write(body);
  writeOut(get("out"), body);
  return canWriteE2E(brief) ? EXIT_OK : EXIT_BLOCKED;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`错误:${message}\n`);
    process.exit(EXIT_USAGE);
  },
);
