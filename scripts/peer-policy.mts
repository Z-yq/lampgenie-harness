#!/usr/bin/env node
/**
 * Peer 级访问快照 CLI(#179):判定 / 批量判定 / 快照生成 / 重载 / 失效 / 报告。
 *
 * 纯表面层:所有判定在
 *   packages/harness-runtime/src/agent/peer-policy.ts(纯逻辑)
 *   apps/gateway/src/peer-policy-store.ts(.genie/rsi/peer-policies.json + peer-snapshots.json)
 * 本文件只做 argv 解析、items/args 读入与退出码映射。
 *
 * 跑法:node --experimental-strip-types scripts/peer-policy.mts --help
 *
 * 退出码:0 成功/allow / 1 参数或运行错误 / 2 被拒(deny · policy-failed · 事件被拒)。
 */
import fs from "node:fs";
import path from "node:path";

import {
  decidePeer,
  invalidatePeer,
  listPeerAllows,
  mergeReconnectPeer,
  peerPolicyPaths,
  reloadPeer,
  reportPeerPolicies,
  snapshotPeer,
} from "../apps/gateway/src/peer-policy-store.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REJECTED = 2;

const PRINCIPAL_KINDS = ["owner", "member", "viewer", "relay", "group"];

const VALUE_FLAGS = new Set(["root", "policy", "principal", "kind", "method", "args", "items"]);
const BOOL_FLAGS = new Set(["json", "help", "report", "decide", "list", "snapshot", "reload", "invalidate", "reconnect"]);

/** 判定被拒的稳定码 → 退出码 2(与「参数错误」区分开)。 */
const REJECTED_CODES = new Set([
  "PEER_DENY_NO_POLICY",
  "PEER_DENY_POLICY",
  "PEER_POLICY_FAILED",
  "PEER_EVENT_DENIED",
]);

type Parsed = { values: Map<string, string>; flags: Set<string>; positional: string[] };

function parseArgs(argv: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
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
      i++;
      continue;
    }
    if (BOOL_FLAGS.has(name)) flags.add(name);
  }
  return { values, flags, positional };
}

function fail(code: number, message: string, json: boolean): never {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, codes: [message], exitCode: code }, null, 2)}\n`);
  else process.stderr.write(`${message}\n`);
  process.exit(code);
  throw new Error(message);
}

function readPayload(spec: string): unknown {
  const raw = spec === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(spec), "utf8");
  return JSON.parse(raw);
}

function emit(json: boolean, payload: Record<string, unknown>, lines: string[]): void {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

function exitFor(code: string, allow: boolean): number {
  if (allow && !REJECTED_CODES.has(code)) return EXIT_OK;
  return EXIT_REJECTED;
}

const HELP = [
  "用法:node --experimental-strip-types scripts/peer-policy.mts --root <dir> <子命令> [--json]",
  "  --decide --principal <id> [--kind <k>] --method <m> [--args <file.json|->]   单次准入判定",
  "  --list --principal <id> [--kind <k>] --items <file.json|-> [--method <m>]    批量判定(逐项独立)",
  "  --snapshot --principal <id> [--kind <k>]            生成快照并落盘",
  "  --reload ...                                        全新重载(旧 follow 清空)",
  "  --invalidate ...                                    按当前策略重算 baseline,清空 follow",
  "  --reconnect ...                                     重连:保留最后快照(follow 原样)",
  "  --report [--json]                                   策略/快照投影报告",
  "  --policy <file>                                     覆盖策略文件(缺省 <root>/.genie/rsi/peer-policies.json)",
  "  --kind <owner|member|viewer|relay|group>            缺省 viewer",
  "  --help",
  "数据面:<root>/.genie/rsi/peer-policies.json(只读策略)+ <root>/.genie/rsi/peer-snapshots.json(原子写快照)",
  "退出码:0 成功/allow / 1 参数或运行错误 / 2 被拒(deny·policy-failed·事件被拒)",
].join("\n");

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = parsed.flags.has("json");
  const get = (name: string): string | undefined => parsed.values.get(name);
  const root = get("root") ?? "";

  if (parsed.flags.has("help") || (parsed.flags.size === 0 && parsed.values.size === 0)) {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }

  if (!root) fail(EXIT_USAGE, "--root 必填", json);

  const policyFile = get("policy") || undefined;
  const kindRaw = get("kind") || "viewer";
  if (!PRINCIPAL_KINDS.includes(kindRaw)) fail(EXIT_USAGE, `--kind 非法:${kindRaw}`, json);
  const kind = kindRaw as (typeof PRINCIPAL_KINDS)[number];

  const principalId = (): string => {
    const id = (get("principal") ?? "").trim();
    if (!id) fail(EXIT_USAGE, "需要 --principal <id>", json);
    return id;
  };

  if (parsed.flags.has("decide")) {
    const method = (get("method") ?? "").trim();
    if (!method) fail(EXIT_USAGE, "--decide 需要 --method <m>", json);
    let args: unknown;
    const argsSpec = get("args") ?? "";
    if (argsSpec) {
      try {
        args = readPayload(argsSpec);
      } catch (err) {
        fail(EXIT_USAGE, `--args 读取/解析失败:${(err as Error).message}`, json);
      }
    }
    const res = await decidePeer(root, {
      principal: { id: principalId(), kind },
      method,
      args,
      ...(policyFile ? { policyFile } : {}),
    });
    emit(
      json,
      {
        ok: res.allow,
        code: res.code,
        allow: res.allow,
        principalId: res.principalId,
        method: res.method,
        policyFile: res.file,
        corrupt: res.corrupt,
        counts: { allow: res.allow ? 1 : 0, deny: res.allow ? 0 : 1 },
      },
      [`code=${res.code}`, `allow=${res.allow}`, `principal=${res.principalId}`, `method=${res.method}`, `policyFile=${res.file}`],
    );
    if (!res.allow) process.stderr.write(`codes=${res.code}\n`);
    return exitFor(res.code, res.allow);
  }

  if (parsed.flags.has("list")) {
    const itemsSpec = get("items") ?? "";
    if (!itemsSpec) fail(EXIT_USAGE, "--list 需要 --items <file.json|->", json);
    let items: unknown;
    try {
      items = readPayload(itemsSpec);
    } catch (err) {
      fail(EXIT_USAGE, `--items 读取/解析失败:${(err as Error).message}`, json);
    }
    if (!Array.isArray(items)) fail(EXIT_USAGE, "--items 必须是 JSON 数组", json);
    const fallback = (get("method") ?? "").trim();
    const methodInItem = (item: unknown): string => {
      if (typeof item !== "object" || item === null) return "";
      const method = (item as { method?: unknown }).method;
      return typeof method === "string" ? method : "";
    };
    // item 自带 method 就用它;否则退回 --method;两者都没有 → usage error(退出码 1,不是 deny)。
    const missing = items.some((item) => !methodInItem(item)) && !fallback;
    if (missing) fail(EXIT_USAGE, "--items 里有项没有 method,且未给 --method", json);

    const res = await listPeerAllows(root, {
      principal: { id: principalId(), kind },
      items,
      methodOf: (item) => methodInItem(item) || fallback,
      ...(policyFile ? { policyFile } : {}),
    });
    emit(
      json,
      {
        ok: res.event.allow,
        code: res.event.code,
        allow: res.event.allow,
        entries: res.entries,
        counts: { allow: res.allowed, deny: res.denied },
        principalId: res.principalId,
        policyFile: res.file,
      },
      [
        `code=${res.event.code}`,
        `allow=${res.event.allow}`,
        `allowed=${res.allowed}`,
        `denied=${res.denied}`,
        ...res.entries.map((e) => `[${e.index}] method=${e.method} allow=${e.allow} code=${e.code}`),
      ],
    );
    if (!res.event.allow) process.stderr.write(`codes=${res.event.code}\n`);
    return exitFor(res.event.code, res.event.allow);
  }

  const snapshotCommands: Array<["snapshot" | "reload" | "invalidate" | "reconnect", string]> = [
    ["snapshot", "snapshot"],
    ["reload", "reload"],
    ["invalidate", "invalidate"],
    ["reconnect", "reconnect"],
  ];
  for (const [flag, label] of snapshotCommands) {
    if (!parsed.flags.has(flag)) continue;
    const options = { principal: { id: principalId(), kind }, ...(policyFile ? { policyFile } : {}), at: new Date().toISOString() };
    const res =
      label === "snapshot"
        ? await snapshotPeer(root, options)
        : label === "reload"
          ? await reloadPeer(root, options)
          : label === "invalidate"
            ? await invalidatePeer(root, options)
            : await mergeReconnectPeer(root, options);
    const baselineKeys = Object.keys(res.snapshot.baseline).sort();
    emit(
      json,
      {
        ok: res.written,
        code: res.code,
        allow: true,
        principalId: res.snapshot.principalId,
        baseline: res.snapshot.baseline,
        follow: res.snapshot.follow,
        snapshotFile: res.file,
        written: res.written,
        counts: {
          baseline: baselineKeys.length,
          allow: Object.values(res.snapshot.baseline).filter(Boolean).length,
          deny: Object.values(res.snapshot.baseline).filter((v) => !v).length,
          follow: res.snapshot.follow.length,
        },
      },
      [
        `code=${res.code}`,
        `principal=${res.snapshot.principalId}`,
        `baseline=${baselineKeys.map((k) => `${k}:${String(res.snapshot.baseline[k])}`).join(",") || "-"}`,
        `follow=${JSON.stringify(res.snapshot.follow)}`,
        `snapshotFile=${res.file}`,
        `written=${res.written}`,
      ],
    );
    return res.written ? EXIT_OK : EXIT_USAGE;
  }

  if (parsed.flags.has("report")) {
    const report = await reportPeerPolicies(root);
    const paths = peerPolicyPaths(root);
    emit(
      json,
      { ok: true, code: "PEER_SNAPSHOT", ...report, paths },
      [
        `policies=${report.policies}`,
        `corruptPolicies=${report.corruptPolicies}`,
        `methods=${report.methods}`,
        `peers=${report.peers}`,
        `allow=${report.allow}`,
        `deny=${report.deny}`,
        `fail=${report.fail}`,
        `lastAt=${report.lastAt || "-"}`,
        `policyFile=${report.policyFile}`,
        `snapshotFile=${report.snapshotFile}`,
      ],
    );
    return EXIT_OK;
  }

  fail(EXIT_USAGE, "缺少子命令(--decide/--list/--snapshot/--reload/--invalidate/--reconnect/--report)", json);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`error: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(EXIT_USAGE);
  },
);
