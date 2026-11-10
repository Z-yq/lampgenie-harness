/**
 * 夹具落盘层(#110):open/replay/record/close/refresh/report 的真文件行为。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExpectedRequest } from "@lampgenie/runtime/agent/fixture-replay";
import {
  FIXTURE_NOT_FOUND,
  close,
  fixturePath,
  fixturesDir,
  openScope,
  readFixture,
  record,
  refresh,
  replayNext,
  report,
} from "../src/fixture-store";

const T0 = 1_700_000_000_000;
const tempDirs: string[] = [];

function tmpRoot(tag = "fixtures"): string {
  const dir = mkdtempSync(join(tmpdir(), `${tag}-`));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function req(id: string, url = `https://api.example.test/${id}`, method = "POST"): ExpectedRequest {
  return { id, method, url };
}

function seed(root: string, name: string, expected: ExpectedRequest[], entries: Array<{ request: ExpectedRequest; response: unknown; at?: number }>, cursor: number, status: "open" | "closed" = "open"): void {
  mkdirSync(fixturesDir(root), { recursive: true });
  writeFileSync(
    fixturePath(root, name),
    `${JSON.stringify(
      {
        v: 1,
        name,
        mode: "replay",
        expected,
        entries: entries.map((e) => ({ request: e.request, response: e.response, at: e.at ?? T0 })),
        cursor,
        status,
        createdAt: "2026-11-10T00:00:00.000Z",
        updatedAt: "2026-11-10T00:00:00.000Z",
      },
      null,
      2)}\n`,
    "utf8",
  );
}

function tmpLeftovers(root: string): string[] {
  const dir = fixturesDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".tmp"));
}

describe("openScope", () => {
  it("本地缺夹具 → record 模式并落盘空 scope", async () => {
    const root = tmpRoot();
    const opened = await openScope(root, "demo", [req("a")]);
    expect(opened.code).toBe("FIXTURE_OPENED");
    expect(opened.mode).toBe("record");
    expect(existsSync(fixturePath(root, "demo"))).toBe(true);
    const loaded = await readFixture(root, "demo");
    expect(loaded.scope?.cursor).toBe(0);
    expect(loaded.scope?.expected).toHaveLength(1);
  });

  it("夹具存在 → replay 模式,expected 以文件为准", async () => {
    const root = tmpRoot();
    seed(root, "demo", [req("a"), req("b")], [], 0);
    const opened = await openScope(root, "demo", [req("a"), req("b")]);
    expect(opened.code).toBe("FIXTURE_OPENED");
    expect(opened.mode).toBe("replay");
    expect(opened.scope?.expected).toHaveLength(2);
    expect(opened.expectedDrift).toBeUndefined();
  });

  it("传入的 expected 与文件不一致 → expectedDrift 告警且不改文件", async () => {
    const root = tmpRoot();
    seed(root, "demo", [req("a")], [], 0);
    const before = readFileSync(fixturePath(root, "demo"), "utf8");
    const opened = await openScope(root, "demo", [req("other")]);
    expect(opened.mode).toBe("replay");
    expect(opened.expectedDrift).toBe(true);
    const after = readFileSync(fixturePath(root, "demo"), "utf8");
    // untouched = only the cursor reset（回放指针）,expected 不被覆盖
    expect(JSON.parse(after).expected).toEqual(JSON.parse(before).expected);
  });

  it("打开已存在夹具 = 开始本轮回放,cursor 清零并落盘", async () => {
    const root = tmpRoot();
    seed(root, "demo", [req("a")], [{ request: req("a"), response: "A" }], 1, "closed");
    const opened = await openScope(root, "demo", [req("a")]);
    expect(opened.scope?.cursor).toBe(0);
    expect((await readFixture(root, "demo")).scope?.cursor).toBe(0);
  });

  it("CI 缺夹具 → FIXTURE_REPLAY_MISSING 且不创建文件", async () => {
    const root = tmpRoot();
    const opened = await openScope(root, "ci-scope", [req("a")], { envMode: "ci" });
    expect(opened.code).toBe("FIXTURE_REPLAY_MISSING");
    expect(opened.missing).toBe(true);
    expect(existsSync(fixturePath(root, "ci-scope"))).toBe(false);
  });

  it("显式 passthrough → FIXTURE_PASSTHROUGH,不创建文件", async () => {
    const root = tmpRoot();
    const opened = await openScope(root, "demo", [req("a")], { passthrough: true });
    expect(opened.code).toBe("FIXTURE_PASSTHROUGH");
    expect(opened.mode).toBe("passthrough");
    expect(existsSync(fixturePath(root, "demo"))).toBe(false);
  });
});

describe("replayNext", () => {
  it("按顺序回放 → 返回录制响应并推进 cursor(落盘)", async () => {
    const root = tmpRoot();
    seed(root, "demo", [req("a"), req("b")], [{ request: req("a"), response: { ok: "A" } }, { request: req("b"), response: { ok: "B" } }], 0);
    const first = await replayNext(root, "demo", req("a"));
    expect(first.code).toBe("FIXTURE_MATCHED");
    expect(first.response).toEqual({ ok: "A" });
    expect(first.index).toBe(0);
    const persisted = await readFixture(root, "demo");
    expect(persisted.scope?.cursor).toBe(1);
  });

  it("乱序 → FIXTURE_MISMATCH 且不推进 cursor", async () => {
    const root = tmpRoot();
    seed(root, "demo", [req("a"), req("b")], [{ request: req("a"), response: "A" }, { request: req("b"), response: "B" }], 0);
    const bad = await replayNext(root, "demo", req("b"));
    expect(bad.code).toBe("FIXTURE_MISMATCH");
    expect(bad.expected?.id).toBe("a");
    expect((await readFixture(root, "demo")).scope?.cursor).toBe(0);
  });

  it("expected 匹配但录制缺该条 → MISMATCH(entry-missing)", async () => {
    const root = tmpRoot();
    seed(root, "demo", [req("a"), req("b")], [{ request: req("a"), response: "A" }], 1);
    const result = await replayNext(root, "demo", req("b"));
    expect(result.code).toBe("FIXTURE_MISMATCH");
    expect(result.reason).toBe("entry-missing");
  });

  it("夹具不存在 → FIXTURE_REPLAY_MISSING", async () => {
    const root = tmpRoot();
    const result = await replayNext(root, "missing", req("a"));
    expect(result.code).toBe("FIXTURE_REPLAY_MISSING");
  });

  it("关闭后的夹具仍可回放(CI 场景:重放已完成的夹具)", async () => {
    const root = tmpRoot();
    seed(root, "demo", [req("a")], [{ request: req("a"), response: "A" }], 0, "closed");
    const result = await replayNext(root, "demo", req("a"));
    expect(result.code).toBe("FIXTURE_MATCHED");
    expect(result.response).toBe("A");
  });

  it("关闭且 cursor 已走满 → replay 从第一条重跑,不报 expected-exhausted", async () => {
    const root = tmpRoot();
    seed(root, "demo", [req("a"), req("b")], [{ request: req("a"), response: "A" }, { request: req("b"), response: "B" }], 2, "closed");
    const result = await replayNext(root, "demo", req("a"));
    expect(result.code).toBe("FIXTURE_MATCHED");
    expect(result.response).toBe("A");
  });
});

describe("record", () => {
  it("顺序录制 → FIXTURE_RECORDED,原子写且无 .tmp 残留", async () => {
    const root = tmpRoot();
    await openScope(root, "demo", [req("a"), req("b")]);
    const result = await record(root, "demo", { request: req("a"), response: { ok: 1 }, at: T0 });
    expect(result.code).toBe("FIXTURE_RECORDED");
    expect(result.written).toBe(true);
    const loaded = await readFixture(root, "demo");
    expect(loaded.scope?.cursor).toBe(1);
    expect(loaded.scope?.entries[0]?.response).toEqual({ ok: 1 });
    expect(tmpLeftovers(root)).toEqual([]);
  });

  it("乱序录制 → FIXTURE_MISMATCH,文件不变", async () => {
    const root = tmpRoot();
    await openScope(root, "demo", [req("a"), req("b")]);
    const before = readFileSync(fixturePath(root, "demo"), "utf8");
    const result = await record(root, "demo", { request: req("b"), response: "B" });
    expect(result.code).toBe("FIXTURE_MISMATCH");
    expect(result.written).toBe(false);
    expect(readFileSync(fixturePath(root, "demo"), "utf8")).toBe(before);
  });

  it("响应含 sk- token → FIXTURE_SECRET_DETECTED,旧文件逐字不变", async () => {
    const root = tmpRoot();
    await openScope(root, "demo", [req("a")]);
    await record(root, "demo", { request: req("a"), response: { ok: "first" } });
    const before = readFileSync(fixturePath(root, "demo"), "utf8");
    const rejected = await record(root, "demo", { request: req("a"), response: { key: "sk-live-abcdef123456" } });
    expect(rejected.code).toBe("FIXTURE_SECRET_DETECTED");
    expect(rejected.written).toBe(false);
    expect(rejected.hits?.length).toBeGreaterThan(0);
    expect(readFileSync(fixturePath(root, "demo"), "utf8")).toBe(before);
  });

  it("凭据 env 值出现在请求里 → 拒写", async () => {
    const root = tmpRoot();
    await openScope(root, "demo", [{ ...req("a"), headers: { "x-api-key": "super-secret-value-42" } }]);
    const result = await record(
      root,
      "demo",
      { request: { ...req("a"), headers: { "x-api-key": "super-secret-value-42" } }, response: { ok: 1 } },
      { envValues: ["super-secret-value-42"] },
    );
    expect(result.code).toBe("FIXTURE_SECRET_DETECTED");
    expect(result.hits?.some((h) => h.kind === "env-value")).toBe(true);
  });

  it("scope 未打开 → FIXTURE_INVALID(先 openScope)", async () => {
    const root = tmpRoot();
    const result = await record(root, "nope", { request: req("a"), response: 1 });
    expect(result.code).toBe("FIXTURE_INVALID");
    expect(result.reason).toContain("scope-not-open");
  });

  it("正常 64 位 bodyHash 不被高熵扫描误伤", async () => {
    const root = tmpRoot();
    const hash = "fnv1a64:0123456789abcdef";
    await openScope(root, "demo", [{ ...req("a"), bodyHash: hash }]);
    const result = await record(root, "demo", { request: { ...req("a"), bodyHash: hash }, response: { ok: 1 } });
    expect(result.code).toBe("FIXTURE_RECORDED");
  });
});

describe("close", () => {
  it("used<total → FIXTURE_INCOMPLETE,文件保持 open", async () => {
    const root = tmpRoot();
    await openScope(root, "demo", [req("a"), req("b")]);
    const result = await close(root, "demo");
    expect(result.code).toBe("FIXTURE_INCOMPLETE");
    expect(result.summary).toMatchObject({ used: 0, total: 2, status: "open" });
    expect((await readFixture(root, "demo")).scope?.status).toBe("open");
  });

  it("used==total → FIXTURE_CLOSED 且状态落盘", async () => {
    const root = tmpRoot();
    await openScope(root, "demo", [req("a")]);
    await record(root, "demo", { request: req("a"), response: 1 });
    const result = await close(root, "demo");
    expect(result.code).toBe("FIXTURE_CLOSED");
    expect(result.summary?.complete).toBe(true);
    expect((await readFixture(root, "demo")).scope?.status).toBe("closed");
  });
});

describe("refresh / report", () => {
  it("refresh 删文件,重复 refresh 返回 removed=false", async () => {
    const root = tmpRoot();
    await openScope(root, "demo", [req("a")]);
    const first = await refresh(root, "demo");
    expect(first.code).toBe("FIXTURE_REFRESHED");
    expect(first.removed).toBe(true);
    expect(existsSync(fixturePath(root, "demo"))).toBe(false);
    expect((await refresh(root, "demo")).removed).toBe(false);
  });

  it("report 单个 → summary;缺失 → FIXTURE_NOT_FOUND", async () => {
    const root = tmpRoot();
    await openScope(root, "demo", [req("a"), req("b")]);
    const single = await report(root, "demo");
    expect(single.code).toBe("FIXTURE_REPORT");
    expect(single.summary).toMatchObject({ used: 0, total: 2 });
    expect((await report(root, "ghost")).code).toBe(FIXTURE_NOT_FOUND);
  });

  it("report 全量 → 多 scope 并存时逐个列出", async () => {
    const root = tmpRoot();
    await openScope(root, "alpha", [req("a")]);
    await openScope(root, "beta", [req("b"), req("c")]);
    const all = await report(root);
    expect(all.code).toBe("FIXTURE_REPORT");
    expect(all.reports?.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("坏 JSON 夹具 → readFixture 报错但不抛,report 记为错误", async () => {
    const root = tmpRoot();
    mkdirSync(fixturesDir(root), { recursive: true });
    writeFileSync(join(fixturesDir(root), "broken.json"), "{ not json", "utf8");
    const loaded = await readFixture(root, "broken");
    expect(loaded.scope).toBeUndefined();
    expect(loaded.code).not.toBe("FIXTURE_MATCHED");
    const all = await report(root);
    expect(all.code).toBe("FIXTURE_REPORT");
    expect(all.errors?.some((e) => e.startsWith("broken:"))).toBe(true);
  });
});

describe("参数边界", () => {
  it("root 空 → TypeError", async () => {
    await expect(openScope("", "demo", [])).rejects.toThrow(/root/);
  });

  it("scope 名带路径分隔符 → TypeError(不许写出夹具目录)", () => {
    expect(() => fixturePath("/tmp/x", "../escape")).toThrow(/路径/);
    expect(() => fixturePath("/tmp/x", "a/b")).toThrow(/路径/);
  });
});
