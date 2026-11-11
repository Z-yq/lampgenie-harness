#!/usr/bin/env -S npx tsx
/**
 * 任务档案 CLI #:add / list / show / resolve / remove / report。
 * 用法:
 * tsx scripts/task-profile.mts --root /tmp/tp add --json '{"id":"coding-default","taskClass":"coding","maxSteps":120}'
 * tsx scripts/task-profile.mts --root /tmp/tp list
 * tsx scripts/task-profile.mts --root /tmp/tp show --id coding-default
 * tsx scripts/task-profile.mts --root /tmp/tp resolve --task-class coding [--profile <id>]
 * tsx scripts/task-profile.mts --root /tmp/tp remove --id coding-default
 * tsx scripts/task-profile.mts --root /tmp/tp report
 * 退出码:0 成功(含 CONFLICT 解析胜出);1 校验失败/坏文件/写入失败/NO_MATCH;
 * 2 参数错误 / 显式档案不存在(NOT_FOUND)。
 */
import { readFile } from "node:fs/promises";

type StoreModule = typeof import("../apps/gateway/src/task-profile-store.ts");

const USAGE = `任务档案 CLI(#)

用法:
  --root <dir>                     仓库根;档案文件 <dir>/.genie/task-profiles.json
  add --json '<json>' | --file <p> 新增一份档案(create-only;同 id 已存在=CONFLICT)
  list                             列出现有档案
  show --id <id>                   查看一份档案
  resolve --task-class <cls> [--profile <id>]
                                   解析档案(显式 id 优先;否则 taskClass → "*")
  remove --id <id>                 删除一份档案
  report                           汇总计数
  --out json                       以 JSON 输出(默认人读文本)
  --help, -h                       打印本说明

退出码:0 成功;1 校验/IO/NO_MATCH;2 参数错误 / NOT_FOUND。`;

interface CliArgs {
  root: string;
  command: "add" | "list" | "show" | "resolve" | "remove" | "report" | "";
  payload?: string;
  file?: string;
  id?: string;
  taskClass?: string;
  profile?: string;
  outJson: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { root: "", command: "", outJson: false, help: false };
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 缺少取值`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--") && out.command === "") {
      if (arg === "add" || arg === "list" || arg === "show" || arg === "resolve" || arg === "remove" || arg === "report") {
        out.command = arg;
        continue;
      }
      throw new Error(`未知命令:${arg}`);
    }
    switch (arg) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--root":
        out.root = valueOf(i, arg);
        i += 1;
        break;
      case "--json":
        out.payload = valueOf(i, arg);
        i += 1;
        break;
      case "--file":
        out.file = valueOf(i, arg);
        i += 1;
        break;
      case "--id":
        out.id = valueOf(i, arg);
        i += 1;
        break;
      case "--task-class":
        out.taskClass = valueOf(i, arg);
        i += 1;
        break;
      case "--profile":
        out.profile = valueOf(i, arg);
        i += 1;
        break;
      case "--out":
        if (valueOf(i, arg) !== "json") throw new Error("--out 只接受 json");
        out.outJson = true;
        i += 1;
        break;
      default:
        throw new Error(`未知参数:${arg}`);
    }
  }
  return out;
}

async function loadStore(): Promise<StoreModule> {
  return (await import("../apps/gateway/src/task-profile-store.ts")) as unknown as StoreModule;
}

function emit(args: CliArgs, payload: Record<string, unknown>, human: string): void {
  if (args.outJson) console.log(JSON.stringify(payload, null, 2));
  else console.log(human);
}

/** 业务码 → 退出码:NOT_FOUND=2(显式档案不存在);OK/CONFLICT=0;其余 1。 */
function exitCodeOf(code: string): number {
  if (code === "PROFILE_OK" || code === "PROFILE_CONFLICT") return 0;
  if (code === "PROFILE_NOT_FOUND") return 2;
  return 1;
}

async function readPayload(args: CliArgs): Promise<unknown> {
  let text: string | undefined = args.payload;
  if (text === undefined && args.file !== undefined) text = await readFile(args.file, "utf8");
  if (text === undefined) throw new Error("add 需要 --json '<profile>' 或 --file <path>");
  return JSON.parse(text);
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    console.error(USAGE);
    return 2;
  }
  if (args.help || args.command === "") {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  if (args.root === "") {
    console.error("--root 必填");
    return 2;
  }
  const store = await loadStore();
  const root = args.root;

  if (args.command === "add") {
    let payload: unknown;
    try {
      payload = await readPayload(args);
    } catch (err) {
      emit(args, { ok: false, code: "PROFILE_INVALID", reason: String(err instanceof Error ? err.message : err) }, `code=PROFILE_INVALID reason=${String(err instanceof Error ? err.message : err)}`);
      return 1;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      emit(args, { ok: false, code: "PROFILE_INVALID", reason: "档案必须是 JSON 对象" }, "code=PROFILE_INVALID reason=档案必须是 JSON 对象");
      return 1;
    }
    const res = await store.addTaskProfile(root, payload as Parameters<StoreModule["addTaskProfile"]>[1]);
    emit(
      args,
      { ok: res.ok, code: res.code, profile: res.profile, issues: res.issues, reason: res.reason, path: res.path },
      res.ok
        ? `code=PROFILE_OK id=${res.profile?.id} taskClass=${res.profile?.taskClass} path=${res.path}`
        : `code=${res.code} reason=${res.reason ?? (res.issues ?? []).map((i) => i.message).join(";")}`,
    );
    return exitCodeOf(res.code);
  }

  if (args.command === "list") {
    const res = await store.listTaskProfiles(root);
    emit(
      args,
      { ok: res.ok, code: res.code, count: res.count, profiles: res.profiles, parseErrors: res.parseErrors, path: res.path, error: res.error },
      [
        `code=${res.code} count=${res.count} parseErrors=${res.parseErrors} path=${res.path}`,
        ...res.profiles.map((p) => `- ${p.id} [${p.taskClass}]${typeof p.maxSteps === "number" ? ` maxSteps=${p.maxSteps}` : ""}`),
      ].join("\n"),
    );
    return res.ok ? 0 : 1;
  }

  if (args.command === "show") {
    if (args.id === undefined) {
      console.error("show 需要 --id");
      return 2;
    }
    const res = await store.showTaskProfile(root, args.id);
    emit(args, { ok: res.ok, code: res.code, profile: res.profile, reason: res.reason, path: res.path }, res.ok ? JSON.stringify(res.profile, null, 2) : `code=${res.code} reason=${res.reason ?? ""}`);
    return exitCodeOf(res.code);
  }

  if (args.command === "remove") {
    if (args.id === undefined) {
      console.error("remove 需要 --id");
      return 2;
    }
    const res = await store.removeTaskProfile(root, args.id);
    emit(args, { ok: res.ok, code: res.code, removed: res.removed, reason: res.reason, path: res.path }, res.ok ? `code=PROFILE_OK removed=${res.removed?.id} path=${res.path}` : `code=${res.code} reason=${res.reason ?? ""}`);
    return exitCodeOf(res.code);
  }

  if (args.command === "resolve") {
    if (args.taskClass === undefined) {
      console.error("resolve 需要 --task-class");
      return 2;
    }
    const res = await store.resolveTaskProfileAt(root, {
      taskClass: args.taskClass,
      ...(args.profile !== undefined ? { profileId: args.profile } : {}),
    });
    emit(
      args,
      { ok: res.ok, code: res.code, profile: res.profile, reason: res.reason, issues: res.issues, path: res.path },
      res.ok
        ? `code=${res.code} profileId=${res.profile?.id} taskClass=${res.profile?.taskClass}${res.reason ? ` reason=${res.reason}` : ""}`
        : `code=${res.code} reason=${res.reason ?? ""}`,
    );
    return exitCodeOf(res.code);
  }

  const rep = await store.reportTaskProfiles(root);
  emit(
    args,
    { ...rep },
    [
      `code=${rep.code} total=${rep.total} parseErrors=${rep.parseErrors} path=${rep.path}`,
      `byTaskClass=${JSON.stringify(rep.byTaskClass)}`,
      `with=${JSON.stringify(rep.with)}`,
      ...(rep.latestUpdatedAt !== undefined ? [`latestUpdatedAt=${rep.latestUpdatedAt}`] : []),
    ].join("\n"),
  );
  return rep.ok ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`运行失败:${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
