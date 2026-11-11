/**
 * LSP 启动失败指数退避(broken Set → brokenUntil/failures 时间窗)。
 * 做法:临时目录写假 server 脚本(每次启动把 spawn 记进日志),
 * 失败用「启动即 exit(1)」注入;时间推进用 Date.now mock(不用假定时器,避免 spawn/IO 卡死)。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LSP_BROKEN_BACKOFF_MS,
  disposeAllLspClients,
  lspBrokenState,
  resetLspBroken,
  resetLspManagerState,
  withLspClient,
} from "../src/manager.js";
import type { ServerSpec } from "../src/servers.js";

const DIR = mkdtempSync(join(tmpdir(), "m137-lsp-"));
const FAIL_LSP = join(DIR, "fail-lsp.mjs");
const OK_LSP = join(DIR, "ok-lsp.mjs");

writeFileSync(FAIL_LSP, [
  "import { appendFileSync } from 'node:fs';",
  "appendFileSync(process.argv[2], 'spawn\\n');",
  "process.exit(1);",
].join("\n"), "utf8");

writeFileSync(OK_LSP, [
  "import { appendFileSync } from 'node:fs';",
  "const log = process.argv[2];",
  "appendFileSync(log, 'spawn\\n');",
  "const send = (obj) => {",
  "  const body = JSON.stringify(obj);",
  "  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
  "};",
  "let buf = Buffer.alloc(0);",
  "process.stdin.on('data', (chunk) => {",
  "  buf = Buffer.concat([buf, chunk]);",
  "  for (;;) {",
  "    const sep = buf.indexOf('\\r\\n\\r\\n');",
  "    if (sep < 0) break;",
  "    const m = /content-length:\\s*(\\d+)/i.exec(buf.toString('ascii', 0, sep));",
  "    if (!m) break;",
  "    const len = Number(m[1]);",
  "    const start = sep + 4;",
  "    if (buf.length < start + len) break;",
  "    const msg = JSON.parse(buf.toString('utf8', start, start + len));",
  "    buf = buf.subarray(start + len);",
  "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });",
  "    else if (msg.method === 'shutdown') send({ jsonrpc: '2.0', id: msg.id, result: null });",
  "    else if (msg.method === 'exit') process.exit(0);",
  "    else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: null });",
  "  }",
  "});",
].join("\n"), "utf8");

let now = 1_700_000_000_000;
let roots: string[] = [];

function mkRoot(): string {
  const d = mkdtempSync(join(DIR, "root-"));
  roots.push(d);
  return d;
}

function spec(id: string, log: string, ok = false): ServerSpec {
  return { id, command: process.execPath, args: [ok ? OK_LSP : FAIL_LSP, log], label: `fake-${id}` };
}

function spawns(log: string): number {
  try {
    return readFileSync(log, "utf8").split("\n").filter((l) => l === "spawn").length;
  } catch {
    return 0;
  }
}

/** 一次 withLspClient 调用(失败=null)。 */
async function callLsp(s: ServerSpec, root: string): Promise<string | null> {
  return withLspClient(s, root, 500, async () => "ok");
}

function stateOf(key: string) {
  return lspBrokenState().find((s) => s.key === key);
}

beforeEach(() => {
  now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  resetLspManagerState();
  resetLspBroken();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLspManagerState();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterAll(async () => {
  await disposeAllLspClients();
  rmSync(DIR, { recursive: true, force: true });
});

describe("LSP broken 指数退避", () => {
  it("首次启动失败 → failures=1、retryAt=now+60s(探针 E-1)", async () => {
    const log = join(DIR, "e1.log");
    const root = mkRoot();
    const s = spec("e1", log);
    expect(await callLsp(s, root)).toBeNull();
    const st = stateOf(`${s.id}|${root}`)!;
    expect(st.failures).toBe(1);
    expect(st.retryAt).toBe(now + LSP_BROKEN_BACKOFF_MS[0]!);
    expect(st.permanent).toBeUndefined();
    expect(spawns(log)).toBe(1);
  }, 20_000);

  it("退避期内再次调用 → 不 spawn、fail-soft 返回 null(探针 E-2)", async () => {
    const log = join(DIR, "e2.log");
    const root = mkRoot();
    const s = spec("e2", log);
    await callLsp(s, root);
    now += LSP_BROKEN_BACKOFF_MS[0]! - 1; // 差 1ms 到期
    expect(await callLsp(s, root)).toBeNull();
    expect(spawns(log)).toBe(1);
    expect(stateOf(`${s.id}|${root}`)!.failures).toBe(1);
  }, 20_000);

  it("退避到期 → 重试一次,失败计数 +1、档位升到 5m(探针 E-3)", async () => {
    const log = join(DIR, "e3.log");
    const root = mkRoot();
    const s = spec("e3", log);
    await callLsp(s, root);
    now += LSP_BROKEN_BACKOFF_MS[0]! + 1;
    expect(await callLsp(s, root)).toBeNull();
    expect(spawns(log)).toBe(2);
    const st = stateOf(`${s.id}|${root}`)!;
    expect(st.failures).toBe(2);
    expect(st.retryAt).toBe(now + LSP_BROKEN_BACKOFF_MS[1]!);
  }, 20_000);

  it("第三次失败 → 15m 档(仍在退避阶梯内)", async () => {
    const log = join(DIR, "e4.log");
    const root = mkRoot();
    const s = spec("e4", log);
    await callLsp(s, root);
    now += LSP_BROKEN_BACKOFF_MS[0]! + 1;
    await callLsp(s, root);
    now += LSP_BROKEN_BACKOFF_MS[1]! + 1;
    await callLsp(s, root);
    const st = stateOf(`${s.id}|${root}`)!;
    expect(st.failures).toBe(3);
    expect(st.retryAt).toBe(now + LSP_BROKEN_BACKOFF_MS[2]!);
    expect(st.permanent).toBeUndefined();
    expect(spawns(log)).toBe(3);
  }, 25_000);

  it("第四次失败 → 永久 broken(brokenUntil=Infinity)(探针 F)", async () => {
    const log = join(DIR, "e5.log");
    const root = mkRoot();
    const s = spec("e5", log);
    for (const wait of [0, LSP_BROKEN_BACKOFF_MS[0]!, LSP_BROKEN_BACKOFF_MS[1]!, LSP_BROKEN_BACKOFF_MS[2]!]) {
      now += wait;
      await callLsp(s, root);
    }
    const st = stateOf(`${s.id}|${root}`)!;
    expect(st.failures).toBe(4);
    expect(st.permanent).toBe(true);
    expect(st.retryAt).toBeUndefined();
    expect(spawns(log)).toBe(4);
  }, 30_000);

  it("永久 broken 后不再 spawn(即使时间推进很久)", async () => {
    const log = join(DIR, "e6.log");
    const root = mkRoot();
    const s = spec("e6", log);
    for (const wait of [0, LSP_BROKEN_BACKOFF_MS[0]!, LSP_BROKEN_BACKOFF_MS[1]!, LSP_BROKEN_BACKOFF_MS[2]!]) {
      now += wait;
      await callLsp(s, root);
    }
    now += 365 * 24 * 3600_000;
    expect(await callLsp(s, root)).toBeNull();
    expect(spawns(log)).toBe(4);
  }, 30_000);

  it("启动成功 → 返回结果且 broken 状态为空(探针 G)", async () => {
    const log = join(DIR, "g1.log");
    const root = mkRoot();
    const s = spec("g1", log, true);
    expect(await callLsp(s, root)).toBe("ok");
    expect(stateOf(`${s.id}|${root}`)).toBeUndefined();
    expect(lspBrokenState()).toEqual([]);
    expect(spawns(log)).toBe(1);
  }, 20_000);

  it("失败后换可用命令(同 key)→ 成功即清除 failures/retryAt", async () => {
    const log = join(DIR, "g2.log");
    const root = mkRoot();
    const id = "g2";
    await callLsp(spec(id, log), root); // 失败 1 次
    expect(stateOf(`${id}|${root}`)!.failures).toBe(1);
    now += LSP_BROKEN_BACKOFF_MS[0]! + 1;
    expect(await callLsp(spec(id, log, true), root)).toBe("ok"); // 到期后换成可用 server
    expect(stateOf(`${id}|${root}`)).toBeUndefined();
    expect(lspBrokenState()).toEqual([]);
    expect(spawns(log)).toBe(2);
  }, 25_000);

  it("resetLspBroken(key) 定点清除,缺省全清", async () => {
    const root = mkRoot();
    const a = spec("r1", join(DIR, "r1.log"));
    const b = spec("r2", join(DIR, "r2.log"));
    await callLsp(a, root);
    await callLsp(b, root);
    expect(lspBrokenState()).toHaveLength(2);
    resetLspBroken(`${a.id}|${root}`);
    expect(lspBrokenState().map((s) => s.key)).toEqual([`${b.id}|${root}`]);
    resetLspBroken();
    expect(lspBrokenState()).toEqual([]);
  }, 20_000);

  it("不同 key 互不影响(失败 A 不拉黑 B)", async () => {
    const rootA = mkRoot();
    const rootB = mkRoot();
    const logA = join(DIR, "k-a.log");
    const logB = join(DIR, "k-b.log");
    await callLsp(spec("ka", logA), rootA);
    expect(stateOf(`ka|${rootA}`)!.failures).toBe(1);
    expect(stateOf(`ka|${rootB}`)).toBeUndefined();
    expect(await callLsp(spec("kb", logB, true), rootB)).toBe("ok");
    expect(stateOf(`ka|${rootB}`)).toBeUndefined();
  }, 25_000);

  it("退避期间 fail-soft:不抛错,返回 null", async () => {
    const log = join(DIR, "soft.log");
    const root = mkRoot();
    const s = spec("soft", log);
    await expect(callLsp(s, root)).resolves.toBeNull();
    await expect(callLsp(s, root)).resolves.toBeNull();
    expect(spawns(log)).toBe(1);
  }, 20_000);
});
