#!/usr/bin/env -S node --experimental-strip-types
/**
 * 轨迹病理形态 CLI(RSI 第 40 轮 #214,2026-11-09):detect / catalog / register / route / report。
 *
 * 纯表面层:原语检测、形态目录、组合匹配、tip 门与干预路由在
 * packages/harness-runtime/src/agent/trajectory-pathology.ts(纯逻辑零 IO);
 * 落盘与投影在 apps/gateway/src/pathology-store.ts(`<root>/.genie/rsi/pathology.jsonl`,append-only)。
 * 本文件只做 argv 解析、退出码映射与人类可读输出。
 *
 * 用法:node --experimental-strip-types scripts/pathology.mts --root <dir> <子命令> [--json]
 *   --detect <trace.json|-> [--request-tip] [--json]   归一化轨迹 → 六原语 → 形态匹配/候选
 *   --catalog [--json]                                 内建 8 形态 + 已注册形态
 *   --register <form.json>                             登记新组合(同签名幂等,不新增检测器)
 *   --route <formId> [--request-tip] [--json]          按形态路由干预载体
 *   --report [--json]                                  台账报表(byFamily/byCarrier/matches/candidates/坏行)
 *   --help                                             本帮助
 *
 * 退出码:0 成功;1 参数错误(缺 root / 未知 flag / 文件读不到 / JSON 坏);
 *         2 注册重复(PATHOLOGY_FORM_DUPLICATE)或请求 tip 被拒(PATHOLOGY_TIP_FORBIDDEN,非执行缺陷族)。
 * 落盘位置:`<root>/.genie/rsi/pathology.jsonl`(真实运行请只给 /tmp 下的 root)。
 */
import process from "node:process";
import { readFileSync } from "node:fs";

import {
  detect,
  listForms,
  registerForm,
  reportPathology,
  route,
  type DetectStoreResult,
} from "../apps/gateway/src/pathology-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REFUSED = 2;

const CODE_DUPLICATE = "PATHOLOGY_FORM_DUPLICATE";
const CODE_TIP_FORBIDDEN = "PATHOLOGY_TIP_FORBIDDEN";

// 下游提前关掉管道(`| head -n`)时 stdout 会发 EPIPE:正常收尾,不打整段未捕获栈。
process.stdout.on("error", (err) => {
  if ((err as { code?: string } | undefined)?.code === "EPIPE") {
    process.exit(EXIT_OK);
  }
  throw err;
});

const VALUE_FLAGS = new Set(["root", "detect", "register", "route"]);
const BOOL_FLAGS = new Set(["catalog", "report", "json", "request-tip", "help"]);

const HELP = [
  "轨迹病理形态 CLI:用 --root 指定台账根目录(<root>/.genie/rsi/pathology.jsonl)",
  "",
  "用法:node --experimental-strip-types scripts/pathology.mts --root <dir> <子命令> [--json]",
  "",
  "子命令:",
  "  --detect <trace.json|-> [--request-tip]   归一化轨迹 → 六原语 → 形态匹配(候选只报不入目录)",
  "  --catalog [--json]                        内建 8 形态 + 已注册形态",
  "  --register <form.json>                    登记新组合(同签名幂等;不新增检测器)",
  "  --route <formId> [--request-tip]          按形态路由干预载体(tip 仅执行缺陷族)",
  "  --report [--json]                         台账报表(byFamily/byCarrier/matches/candidates)",
  "  --help                                    本帮助",
  "",
  "六原语:re-entry / reversal / fanout / overlap / dangling / decay",
  "六族:rework-chain / evolution-chain / waste / coordination / statistics / meta",
  "退出码:0 成功 / 1 参数错误 / 2 注册重复或请求 tip 被拒。",
  "提醒:tip 只对执行缺陷族(rework-chain)生效,其余形态一律走对应载体。",
].join("\n");

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
  error?: string;
}

function parseArgv(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      return { values, flags, error: `意外参数:${token}` };
    }
    const name = token.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      return { values, flags, error: `未知 flag:${token}` };
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      return { values, flags, error: `--${name} 缺参数值` };
    }
    values.set(name, next);
    i += 1;
  }
  return { values, flags };
}

/** 读 trace:支持 "-" 走 stdin,其它按文件路径。返回 undefined 表示读不到/坏 JSON。 */
function readJsonInput(spec: string): unknown {
  try {
    const text = spec === "-" ? readFileSync(0, "utf8") : readFileSync(spec, "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fmtPrimitives(result: DetectStoreResult): string[] {
  const rows = Object.entries(result.primitives ?? {}) as [
    string,
    { hit: boolean; count: number; evidence: string[] },
  ][];
  if (rows.length === 0) return ["  原语  (无)"];
  return rows.map(([name, hit]) => {
    const mark = hit.hit ? "HIT " : "    ";
    const evidence = hit.evidence.length > 0 ? `  ${hit.evidence.slice(0, 3).join(" | ")}` : "";
    return `  ${mark}${name.padEnd(8)} count=${hit.count}${evidence}`;
  });
}

function cmdDetect(root: string, spec: string, requestTip: boolean, json: boolean): number {
  const trace = readJsonInput(spec);
  if (trace === undefined || typeof trace !== "object" || trace === null) {
    process.stderr.write(`[pathology] 读不到或无法解析轨迹:${spec}\n`);
    return EXIT_USAGE;
  }
  const result = detect(root, trace as never, { requestTip });
  if (json) {
    printJson(result);
  } else {
    process.stdout.write(`pathology detect  root=${root}\n`);
    process.stdout.write(`codes: ${result.codes.join(",") || "(none)"}\n`);
    for (const line of fmtPrimitives(result)) process.stdout.write(`${line}\n`);
    if (result.matched.length === 0) {
      process.stdout.write("matched: (none)\n");
    } else {
      process.stdout.write(`matched: ${result.matched.length}\n`);
      for (const item of result.matched) {
        const carriers =
          result.interventions?.find((one) => one.formId === item.formId)?.carriers.join(",") ?? "";
        process.stdout.write(
          `  - ${item.formId} [${item.family}] sig=${item.matchedSignature.join("+")}` +
            ` extra=[${item.extraPrimitives.join(",")}] carriers=${carriers}\n`,
        );
      }
    }
    if (result.candidates.length === 0) {
      process.stdout.write("candidates: (none)\n");
    } else {
      process.stdout.write(`candidates: ${result.candidates.length}\n`);
      for (const item of result.candidates) {
        process.stdout.write(
          `  - sig=[${item.signature.join("+")}] family≈${item.familySuggestion} :: ${item.reason}\n`,
        );
      }
    }
  }
  return result.ok ? EXIT_OK : EXIT_USAGE;
}

function cmdCatalog(root: string, json: boolean): number {
  const listed = listForms(root);
  if (json) {
    printJson(listed);
    return listed.ok ? EXIT_OK : EXIT_USAGE;
  }
  if (!listed.ok) {
    process.stderr.write("[pathology] 目录读取失败\n");
    return EXIT_USAGE;
  }
  process.stdout.write(
    `pathology catalog forms=${listed.total} registered=${listed.registered} badLines=${listed.badLines}\n`,
  );
  for (const form of listed.forms) {
    const carriers = form.interventions.map((one) => one.carrier).join(",");
    const origin = form.builtin ? "builtin" : "custom ";
    process.stdout.write(
      `  - ${form.id.padEnd(22)} ${origin} [${form.family}] ${form.signature.join("+")}` +
        ` → ${carriers} tip=${form.tipAllowed}\n`,
    );
  }
  return EXIT_OK;
}

function cmdRegister(root: string, spec: string, json: boolean): number {
  const input = readJsonInput(spec);
  if (input === undefined || typeof input !== "object" || input === null) {
    process.stderr.write(`[pathology] 读不到或无法解析形态文件:${spec}\n`);
    return EXIT_USAGE;
  }
  const result = registerForm(root, input as never);
  if (json) {
    printJson(result);
  } else if (result.ok) {
    process.stdout.write(
      result.duplicate
        ? `register: duplicate → 既有 ${result.formId}\n`
        : `register: registered → ${result.formId}\n`,
    );
  } else {
    process.stdout.write(`register: failed code=${result.code ?? "(unknown)"}\n`);
  }
  if (!result.ok) return EXIT_USAGE;
  return result.duplicate ? EXIT_REFUSED : EXIT_OK;
}

function cmdRoute(root: string, formId: string, requestTip: boolean, json: boolean): number {
  const result = route(root, formId, { requestTip });
  if (json) {
    printJson(result);
  } else {
    process.stdout.write(`pathology route form=${formId} tipAllowed=${result.tipAllowed ?? "?"}\n`);
    if (result.codes.length > 0) process.stdout.write(`codes: ${result.codes.join(",")}\n`);
    if (result.carriers.length === 0) {
      process.stdout.write("carriers: (none)\n");
    } else {
      for (const item of result.carriers) {
        process.stdout.write(`  - ${item.carrier} :: ${item.detail}\n`);
      }
    }
  }
  if (!result.ok) {
    const forbidden = result.code === CODE_TIP_FORBIDDEN;
    if (!json) process.stderr.write(`[pathology] ${result.code ?? "失败"}\n`);
    return forbidden ? EXIT_REFUSED : EXIT_USAGE;
  }
  return EXIT_OK;
}

function cmdReport(root: string, json: boolean): number {
  const report = reportPathology(root);
  if (json) {
    printJson(report);
    return report.ok ? EXIT_OK : EXIT_USAGE;
  }
  process.stdout.write(
    `pathology report totalLines=${report.totalLines} badLines=${report.badLines}\n`,
  );
  process.stdout.write(`byFamily: ${JSON.stringify(report.byFamily)}\n`);
  process.stdout.write(`byCarrier: ${JSON.stringify(report.byCarrier)}\n`);
  process.stdout.write(`matches: ${JSON.stringify(report.matches)}\n`);
  process.stdout.write(`candidates: ${report.candidates.length}\n`);
  for (const item of report.candidates) {
    process.stdout.write(
      `  - [${item.signature.join("+")}] family≈${item.familySuggestion} seen=${item.seen}\n`,
    );
  }
  return report.ok ? EXIT_OK : EXIT_USAGE;
}

function main(argv: string[]): number {
  const parsed = parseArgv(argv);
  if (parsed.flags.has("help")) {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }
  if (parsed.error) {
    process.stderr.write(`[pathology] ${parsed.error}\n${HELP}\n`);
    return EXIT_USAGE;
  }
  const root = parsed.values.get("root");
  if (!root) {
    process.stderr.write("[pathology] 缺 --root\n");
    return EXIT_USAGE;
  }
  const json = parsed.flags.has("json");
  const requestTip = parsed.flags.has("request-tip");

  const detectSpec = parsed.values.get("detect");
  if (detectSpec !== undefined) return cmdDetect(root, detectSpec, requestTip, json);

  const registerSpec = parsed.values.get("register");
  if (registerSpec !== undefined) return cmdRegister(root, registerSpec, json);

  const formId = parsed.values.get("route");
  if (formId !== undefined) return cmdRoute(root, formId, requestTip, json);

  if (parsed.flags.has("catalog")) return cmdCatalog(root, json);
  if (parsed.flags.has("report")) return cmdReport(root, json);

  process.stderr.write(`[pathology] 未指定子命令\n${HELP}\n`);
  return EXIT_USAGE;
}

process.exit(main(process.argv.slice(2)));
