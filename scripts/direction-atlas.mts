#!/usr/bin/env -S npx tsx
/**
 * 方向总览 CLI(RSI #194):往方向台账追加目标/变更/冲突/裁决/决策/缺陷基因,重建快照,读三视图。
 * 纯表面层:纯逻辑在
 * packages/harness-runtime/src/agent/direction-atlas.ts
 * 落盘与投影在
 * apps/gateway/src/direction-atlas-store.ts(`<root>/.genie/rsi/atlas/entries.jsonl` + `<projectId>.json`)
 * 本文件只做 argv 解析、JSON 输入读入、摘要打印与退出码映射。
 * 退出码:0 成功(--build 即使有 driftFlags 也 0,并打印 ATLAS_DRIFT_DETECTED)
 * 1 参数错(缺 --project、未知 flag、文件不存在、JSON 不可 parse)
 * 2 仅 --resolve 失败(冲突不存在 / chosen 不属于该冲突;绝不写盘)
 * 3 目标不存在(--show/--timeline/--render/--report 时 atlas 尚未 build)
 * 用法:
 * npx tsx scripts/direction-atlas.mts --help
 * npx tsx scripts/direction-atlas.mts --root /tmp/da --project p1 --goal /tmp/g1.json # "-" 读 stdin
 * npx tsx scripts/direction-atlas.mts --root /tmp/da --project p1 --conflict /tmp/c1.json --decision /tmp/d1.json
 * npx tsx scripts/direction-atlas.mts --root /tmp/da --project p1 --defects /tmp/genes.json
 * npx tsx scripts/direction-atlas.mts --root /tmp/da --project p1 --resolve c1 --chosen g1 --by lead --reason "方向收拢"
 * npx tsx scripts/direction-atlas.mts --root /tmp/da --project p1 --build [--drift-window-days 30]
 * npx tsx scripts/direction-atlas.mts --root /tmp/da --project p1 --show [--json]
 * npx tsx scripts/direction-atlas.mts --root /tmp/da --project p1 --timeline [--from ISO --to ISO] [--json]
 * npx tsx scripts/direction-atlas.mts --root /tmp/da --project p1 --render [--format md|json] [--out /tmp/atlas.md]
 * npx tsx scripts/direction-atlas.mts --root /tmp/da --project p1 --report [--json]
 * 真实运行请只给 /tmp 下的 root:本仓 .genie 不写方向台账。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import {
  addChange,
  addConflict,
  addDecision,
  addGoal,
  ATLAS_NOT_FOUND,
  atlasJsonPath,
  build,
  getAtlas,
  ingestDefects,
  render,
  reportAtlas,
  resolveConflict,
  timeline,
} from "../apps/gateway/src/direction-atlas-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_RESOLVE_FAILED = 2;
const EXIT_MISSING = 3;

const VALUE_FLAGS = new Set([
  "root",
  "project",
  "goal",
  "change",
  "conflict",
  "decision",
  "defects",
  "resolve",
  "chosen",
  "by",
  "reason",
  "drift-window-days",
  "from",
  "to",
  "format",
  "out",
]);

const BOOL_FLAGS = new Set(["build", "show", "json", "timeline", "render", "report", "help"]);

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
  unknown: string[];
  positional: string[];
}

/** 参数/输入错误:统一映射成退出码 1。 */
class UsageError extends Error {}

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const unknown: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] as string;
    if (!raw.startsWith("--")) {
      positional.push(raw);
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
  return { values, flags, unknown, positional };
}

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function helpText(): string {
  return [
    "方向总览 CLI(RSI #194)",
    "",
    "用法:npx tsx scripts/direction-atlas.mts --root <dir> --project <id> <子命令>",
    "",
    "台账写入(append-only,<root>/.genie/rsi/atlas/entries.jsonl)",
    "  --goal <file|->       追加一个 goal(JSON,支持单对象或数组;\"-\" 读 stdin)",
    "  --change <file|->     追加一个 change(转向时间线条目)",
    "  --conflict <file|->   追加一个 conflict",
    "  --decision <file|->   追加一个 keyDecision",
    "  --defects <file|->    追加一批 defectGene(对象或数组)",
    "  --resolve <conflictId> --chosen <goalId> --by <who> --reason <text>   裁决冲突",
    "",
    "投影与视图",
    "  --build [--drift-window-days n]   重建 <projectId>.json 快照并打印摘要",
    "  --show [--json]                   打印快照",
    "  --timeline [--from ISO] [--to ISO] [--json]   打印转向时间线",
    "  --render [--format md|json] [--out <file>]    渲染五节 md / json",
    "  --report [--json]                 打印摘要报表",
    "  --help                            本说明",
    "",
    "公共参数",
    "  --root <dir>     数据根目录(缺省当前工作目录)",
    "  --project <id>   项目 id(必填)",
    "",
    "退出码:0 成功(--build 有 drift 仍 0)/ 1 参数错 / 2 --resolve 失败(不写盘)/ 3 目标不存在(尚未 --build)",
  ].join("\n");
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

/** 读 JSON 输入:文件缺失或不可 parse 一律 UsageError(退出码 1)。 */
function readJsonInput(spec: string, flag: string): unknown {
  if (spec === "") throw new UsageError(`--${flag} 需要一个文件路径或 "-"(stdin)`);
  let text: string;
  try {
    text = spec === "-" ? readStdin() : readFileSync(resolve(spec), "utf8");
  } catch {
    throw new UsageError(`--${flag}: 读不到输入 ${spec}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UsageError(`--${flag}: 输入不是合法 JSON ${spec}`);
  }
}

/** 单对象或数组统一成数组;空数组算参数错。 */
function asItems(payload: unknown, flag: string): unknown[] {
  const items = Array.isArray(payload) ? payload : [payload];
  if (items.length === 0) throw new UsageError(`--${flag}: 输入为空数组`);
  return items;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function listLines(title: string, items: string[]): string {
  return `${title}: ${items.length === 0 ? "none" : items.join(", ")}`;
}

/** 视图类命令在快照缺失时的统一出口:打印稳定码 + 退出码 3。 */
function missingExit(code: string | undefined): number {
  out(`atlas not found (${code ?? ATLAS_NOT_FOUND}); 先跑 --build`);
  return EXIT_MISSING;
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (parsed.flags.has("help") || argv.length === 0) {
    out(helpText());
    return EXIT_OK;
  }
  if (parsed.unknown.length > 0) throw new UsageError(`未知参数: ${parsed.unknown.join(", ")}(试 --help)`);
  const projectRaw = parsed.values.get("project");
  if (projectRaw === undefined || projectRaw.trim() === "") throw new UsageError("缺少 --project <id>");
  const project = projectRaw.trim();
  const rootRaw = parsed.values.get("root");
  const root = resolve(rootRaw === undefined || rootRaw.trim() === "" ? process.cwd() : rootRaw);
  const json = parsed.flags.has("json");
 /** 有台账写入(或裁决)就算一次成功的动作:不再要求必须有视图子命令。 */
  let acted = false;

 /** 台账写入段:goal / change / conflict / decision / defects。 */
  const writers: Array<{ flag: string; append: (item: unknown) => { ok: boolean; code?: string } }> = [
    { flag: "goal", append: (item) => addGoal(root, project, item as Parameters<typeof addGoal>[2]) },
    { flag: "change", append: (item) => addChange(root, project, item as Parameters<typeof addChange>[2]) },
    { flag: "conflict", append: (item) => addConflict(root, project, item as Parameters<typeof addConflict>[2]) },
    { flag: "decision", append: (item) => addDecision(root, project, item as Parameters<typeof addDecision>[2]) },
  ];

  const argvOrder = argv.filter((item) => item.startsWith("--")).map((item) => item.slice(2));
  const requested = (flag: string): boolean => argvOrder.includes(flag);

  for (const writer of writers) {
    if (!requested(writer.flag)) continue;
    const items = asItems(readJsonInput(parsed.values.get(writer.flag) ?? "", writer.flag), writer.flag);
    let written = 0;
    for (const item of items) {
      const result = writer.append(item);
      if (!result.ok) throw new UsageError(`--${writer.flag} 写入失败: ${result.code ?? "UNKNOWN"}`);
      written += 1;
    }
    out(`ok ${writer.flag} x${written}`);
    acted = true;
  }

  if (requested("defects")) {
    const items = asItems(readJsonInput(parsed.values.get("defects") ?? "", "defects"), "defects");
    const result = ingestDefects(root, project, items as Parameters<typeof ingestDefects>[2]);
    if (!result.ok) throw new UsageError(`--defects 写入失败: ${result.code ?? "UNKNOWN"}`);
    out(`ok defects x${items.length}`);
    acted = true;
  }

  if (requested("resolve")) {
    const conflictId = (parsed.values.get("resolve") ?? "").trim();
    const chosenGoalId = (parsed.values.get("chosen") ?? "").trim();
    const by = (parsed.values.get("by") ?? "").trim();
    const reason = parsed.values.get("reason") ?? "";
    if (conflictId === "") throw new UsageError("--resolve 需要 <conflictId>");
    if (chosenGoalId === "" || by === "" || reason.trim() === "") {
      throw new UsageError("--resolve 需要 --chosen <goalId> --by <who> --reason <text>");
    }
    const result = resolveConflict(root, project, conflictId, { chosenGoalId, reason, by });
    if (!result.ok) {
      out(`resolve failed: ${result.code ?? "UNKNOWN"}(台账未改动)`);
      return EXIT_RESOLVE_FAILED;
    }
    out(`ok resolve ${conflictId} -> ${chosenGoalId}${result.idempotent === true ? " (idempotent)" : ""}`);
    acted = true;
  }

  if (parsed.flags.has("build")) {
    const driftRaw = parsed.values.get("drift-window-days");
    let driftWindowDays: number | undefined;
    if (driftRaw !== undefined) {
      const parsedDays = Number(driftRaw);
      if (!Number.isFinite(parsedDays) || parsedDays <= 0) throw new UsageError("--drift-window-days 需要正数");
      driftWindowDays = parsedDays;
    }
    const built = build(root, project, { driftWindowDays });
    if (!built.ok) throw new UsageError(`build 失败: ${built.code ?? "UNKNOWN"}`);
    const codes = built.codes ?? [];
    const report = reportAtlas(root, project).report;
    const classes = (report?.topDefectClasses ?? []).map((row) => `${row.class}=${row.count}`);
    const atlasPath = built.path ?? atlasJsonPath(root, project);
    if (json) {
      out(
        JSON.stringify(
          {
            ok: true,
            codes,
            badLines: built.badLines ?? 0,
            atlasPath,
            report: report ?? null,
          },
          null,
          2),
      );
      return EXIT_OK;
    }
    const lines = [
      `projectId: ${project}`,
      `activeGoals: ${report?.activeGoals ?? 0}`,
      `achieved: ${report?.achieved ?? 0}`,
      `abandoned: ${report?.abandoned ?? 0}`,
      `openConflicts: ${report?.openConflicts ?? 0}`,
      listLines("topDefectClasses", classes),
      listLines("driftFlags", report?.driftFlags ?? []),
      `codes: ${codes.length === 0 ? "none" : codes.join(",")}`,
      `badLines: ${built.badLines ?? 0}`,
      `atlas: ${atlasPath}`,
    ];
    out(lines.join("\n"));
    return EXIT_OK;
  }

  if (parsed.flags.has("show")) {
    const got = getAtlas(root, project);
    if (!got.ok) return missingExit(got.code);
    const atlas = asRecord(got.atlas);
    if (json) {
      out(JSON.stringify(got.atlas, null, 2));
      return EXIT_OK;
    }
    const summary = asRecord(atlas.summary);
    out(
      [
        `projectId: ${project}`,
        `generatedAt: ${typeof atlas.generatedAt === "string" ? atlas.generatedAt : ""}`,
        `goals: ${Array.isArray(atlas.goals) ? atlas.goals.length : 0}`,
        `changes: ${Array.isArray(atlas.timeline) ? atlas.timeline.length : 0}`,
        `conflicts: ${Array.isArray(atlas.conflicts) ? atlas.conflicts.length : 0}`,
        `highImpactDecisions: ${numOf(summary.highImpactDecisions)}`,
        `driftFlags: ${
          Array.isArray(atlas.driftFlags) && atlas.driftFlags.length > 0
            ? (atlas.driftFlags as string[]).join(", ")
            : "none"
        }`,
        `atlas: ${atlasJsonPath(root, project)}`,
      ].join("\n"),
    );
    return EXIT_OK;
  }

  if (parsed.flags.has("timeline")) {
    const result = timeline(root, project, { from: parsed.values.get("from"), to: parsed.values.get("to") });
    if (!result.ok) return missingExit(result.code);
    if (json) {
      out(JSON.stringify(result.changes, null, 2));
      return EXIT_OK;
    }
    if (result.changes.length === 0) {
      out("暂无转向记录");
      return EXIT_OK;
    }
    const rows = result.changes.map((change) => {
      const row = asRecord(change);
      const at = typeof row.at === "string" ? row.at : "";
      const kind = typeof row.kind === "string" ? row.kind : "";
      const label =
        typeof row.reason === "string"
          ? row.reason
          : typeof row.note === "string"
            ? row.note
            : typeof row.summary === "string"
              ? row.summary
              : typeof row.title === "string"
                ? row.title
                : "";
      const from = typeof row.from === "string" ? row.from : "-";
      const to = typeof row.to === "string" ? row.to : "-";
      return `${at}  ${kind}  ${from} → ${to}  ${label}`.trimEnd();
    });
    out(rows.join("\n"));
    return EXIT_OK;
  }

  if (parsed.flags.has("render")) {
    const formatRaw = (parsed.values.get("format") ?? "md").toLowerCase();
    if (formatRaw !== "md" && formatRaw !== "json") throw new UsageError("--format 只支持 md|json");
    const result = render(root, project, { format: formatRaw });
    if (!result.ok) return missingExit(result.code);
    const outPath = parsed.values.get("out");
    if (outPath !== undefined && outPath !== "") {
      const target = resolve(outPath);
      try {
        writeFileSync(target, result.text ?? "", "utf8");
      } catch {
        throw new UsageError(`--out 写不进去 ${target}`);
      }
      out(`rendered -> ${target}`);
      return EXIT_OK;
    }
    out(result.text ?? "");
    return EXIT_OK;
  }

  if (parsed.flags.has("report")) {
    const result = reportAtlas(root, project);
    if (!result.ok) return missingExit(result.code);
    const report = result.report;
    if (json) {
      out(JSON.stringify(report ?? null, null, 2));
      return EXIT_OK;
    }
    const rows = report?.topDefectClasses ?? [];
    out(
      [
        `projectId: ${report?.projectId ?? project}`,
        `generatedAt: ${report?.generatedAt ?? ""}`,
        `goals: ${report?.goalCount ?? 0}(active ${report?.activeGoals ?? 0} / achieved ${report?.achieved ?? 0} / abandoned ${report?.abandoned ?? 0})`,
        `abandonedGoals: ${(report?.abandonedGoals ?? []).join(", ") || "none"}`,
        `openConflicts: ${report?.openConflicts ?? 0}${(report?.openConflictIds ?? []).length > 0 ? ` (${(report?.openConflictIds ?? []).join(", ")})` : ""}`,
        `highImpactDecisions: ${report?.highImpactDecisions ?? 0}`,
        `changes: ${report?.changeCount ?? 0}`,
        `decisions: ${report?.decisionCount ?? 0}`,
        listLines(
          "topDefectClasses",
          rows.map((row) => `${row.class}=${row.count}`),
        ),
        listLines("driftFlags", report?.driftFlags ?? []),
      ].join("\n"),
    );
    return EXIT_OK;
  }

  if (acted) return EXIT_OK;
  throw new UsageError("没有子命令(试 --help)");
}

async function main(): Promise<number> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof UsageError) {
      out(err.message);
      return EXIT_USAGE;
    }
    out(`direction-atlas 失败: ${String(err).slice(0, 200)}`);
    return EXIT_USAGE;
  }
}

main().then((code) => process.exit(code));
