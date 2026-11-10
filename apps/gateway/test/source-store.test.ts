import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimSourceHealth,
  loadSources,
  registerSourceInstance,
  registerSourceKind,
  replaySource,
  reportSources,
  saveSources,
  sourcesPath,
  writeSourceEvent,
} from "../src/source-store";

const roots: string[] = [];

async function newRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "source-store-"));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

/** 合法 mail kind(默认带 1 个 event 必填字段 + 1 个 config 必填字段);over 覆盖任意字段。 */
function mailKind(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "mail",
    identity: "mailbox",
    title: "邮件",
    schema: "mail.event.v1",
    fields: [
      { name: "subject", type: "string", required: true },
      { name: "url", type: "string", required: true, in: "config" },
    ],
    facts: { protocol: "imap" },
    health: { key: "mail-heartbeat" },
    ...over,
  };
}

/** 先注册 mail kind,再返回 root(多数用例的前置)。 */
async function withMailKind(): Promise<string> {
  const root = await newRoot();
  const registered = registerSourceKind(root, mailKind());
  expect(registered.ok).toBe(true);
  return root;
}

describe("source-store 落盘与热加载", () => {
  it("1) 空 root 读到空登记簿,nextSeq 为 0", async () => {
    const root = await newRoot();
    const registry = loadSources(root);
    expect(registry.kinds).toEqual({});
    expect(registry.instances).toEqual({});
    expect(registry.claims).toEqual({});
    expect(registry.events).toEqual([]);
    expect(registry.nextSeq).toBe(0);
    expect(sourcesPath(root)).toBe(join(root, ".genie", "rsi", "sources.json"));
  });

  it("2) registerSourceKind 落盘,重读仍在", async () => {
    const root = await withMailKind();
    const registry = loadSources(root);
    expect(Object.keys(registry.kinds)).toEqual(["mail"]);
    expect(registry.kinds["mail"]?.schema).toBe("mail.event.v1");
    const raw = JSON.parse(await readFile(sourcesPath(root), "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe(1);
  });

  it("3) 保留名 core 被拒且不创建 sources.json", async () => {
    const root = await newRoot();
    const result = registerSourceKind(root, mailKind({ kind: "core" }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_RESERVED_NAME");
    await expect(readFile(sourcesPath(root), "utf8")).rejects.toBeTruthy();
  });

  it("4) 重复 kind 被拒,原定义不被覆盖", async () => {
    const root = await withMailKind();
    const dup = registerSourceKind(root, mailKind({ title: "邮件(第二版)" }));
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe("SOURCE_DUPLICATE_KIND");
    const registry = loadSources(root);
    expect(registry.kinds["mail"]?.title).toBe("邮件");
  });

  it("5) 合法 config 注册 i1 → enabled:true,重读仍在", async () => {
    const root = await withMailKind();
    const result = registerSourceInstance(root, { id: "i1", kind: "mail", config: { url: "imap://inbox" } });
    expect(result.ok).toBe(true);
    expect(result.instance?.enabled).toBe(true);
    const registry = loadSources(root);
    expect(registry.instances["i1"]?.enabled).toBe(true);
    expect(registry.instances["i1"]?.config["url"]).toBe("imap://inbox");
  });

  it("6) 未知 kind 的 i2 被拒但以 enabled:false 落库,i1 不受影响(negative)", async () => {
    const root = await withMailKind();
    registerSourceInstance(root, { id: "i1", kind: "mail", config: { url: "imap://inbox" } });
    const result = registerSourceInstance(root, { id: "i2", kind: "chat", config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_UNKNOWN_KIND");
    expect(result.instance?.enabled).toBe(false);
    const registry = loadSources(root);
    expect(registry.instances["i1"]?.enabled).toBe(true);
    expect(registry.instances["i2"]?.enabled).toBe(false);
  });

  it("7) i3 缺 config 必填 url → CONFIG_INVALID 且 disabled", async () => {
    const root = await withMailKind();
    const result = registerSourceInstance(root, { id: "i3", kind: "mail", config: { url: 42 } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_CONFIG_INVALID");
    expect(result.instance?.enabled).toBe(false);
    expect(loadSources(root).instances["i3"]?.enabled).toBe(false);
  });

  it("8) 两实例抢同一 config.claims key → CLAIM_CONFLICT", async () => {
    const root = await withMailKind();
    const first = registerSourceInstance(root, { id: "i1", kind: "mail", config: { url: "imap://a", claims: ["mailbox:inbox"] } });
    expect(first.ok).toBe(true);
    const second = registerSourceInstance(root, { id: "i2", kind: "mail", config: { url: "imap://b", claims: ["mailbox:inbox"] } });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("SOURCE_CLAIM_CONFLICT");
    const registry = loadSources(root);
    expect(registry.claims["mailbox:inbox"]).toBe("i1");
    expect(registry.instances["i2"]?.enabled).toBe(false);
  });

  it("9) 两条事件 seq=1/2,重读后 replay fromSeq=1 只回 seq 2(negative)", async () => {
    const root = await withMailKind();
    registerSourceInstance(root, { id: "i1", kind: "mail", config: { url: "imap://inbox" } });
    const one = writeSourceEvent(root, { instanceId: "i1", event: { type: "mail.received", payload: { subject: "a" } } });
    const two = writeSourceEvent(root, { instanceId: "i1", event: { type: "mail.received", payload: { subject: "b" } } });
    expect(one.seq).toBe(1);
    expect(two.seq).toBe(2);
    expect(two.code).toBe("SOURCE_WROTE");

    const replayed = replaySource(root, { instanceId: "i1", fromSeq: 1 });
    expect(replayed.ok).toBe(true);
    expect(replayed.events.map((record) => record.seq)).toEqual([2]);
    expect(replayed.events[0]?.payload["subject"]).toBe("b");
    expect(replaySource(root, {}).events.length).toBe(2);
  });

  it("10) nextSeq 持久化:重读后新写入 seq=3(negative: 不回退到 1)", async () => {
    const root = await withMailKind();
    registerSourceInstance(root, { id: "i1", kind: "mail", config: { url: "imap://inbox" } });
    writeSourceEvent(root, { instanceId: "i1", event: { type: "mail.received", payload: { subject: "a" } } });
    writeSourceEvent(root, { instanceId: "i1", event: { type: "mail.received", payload: { subject: "b" } } });
    expect(loadSources(root).nextSeq).toBe(3);

    const third = writeSourceEvent(root, { instanceId: "i1", event: { type: "mail.received", payload: { subject: "c" } } });
    expect(third.seq).toBe(3);
    expect(third.seq ?? 0).toBeGreaterThan(2);
    expect(loadSources(root).events.map((record) => record.seq)).toEqual([1, 2, 3]);
  });

  it("11) health claim 两次 → 第二次 HEALTH_CLAIM_DUPLICATE", async () => {
    const root = await withMailKind();
    registerSourceInstance(root, { id: "i1", kind: "mail", config: { url: "imap://inbox" } });
    const first = claimSourceHealth(root, { instanceId: "i1", key: "mail-heartbeat" });
    expect(first.ok).toBe(true);
    expect(first.claimId).toBe("health:mail-heartbeat");
    const second = claimSourceHealth(root, { instanceId: "i1", key: "mail-heartbeat" });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("SOURCE_HEALTH_CLAIM_DUPLICATE");
  });

  it("12) reportSources 文本含各项计数,enabled 只含 i1", async () => {
    const root = await withMailKind();
    registerSourceInstance(root, { id: "i1", kind: "mail", config: { url: "imap://inbox", claims: ["mailbox:inbox"] } });
    registerSourceInstance(root, { id: "i2", kind: "chat", config: {} });
    writeSourceEvent(root, { instanceId: "i1", event: { type: "mail.received", payload: { subject: "a" } } });

    const report = reportSources(root);
    expect(report.ok).toBe(true);
    expect(report.kinds).toEqual(["mail"]);
    expect(report.enabled).toEqual(["i1"]);
    expect(report.disabled).toEqual(["i2"]);
    expect(report.claims).toEqual(["mailbox:inbox"]);
    expect(report.events).toBe(1);
    expect(report.nextSeq).toBe(2);
    expect(report.text).toContain("kinds(1)");
    expect(report.text).toContain("enabled(1)");
    expect(report.text).toContain("disabled(1)");
    expect(report.text).toContain("claims(1)");
    expect(report.text).toContain("events: 1");
    expect(report.text).not.toContain("i2, i1");
  });

  it("13) 落盘失败:sources.json 位置被目录占用 → ok:false 且不抛、不残留 tmp(negative)", async () => {
    const root = await newRoot();
    await mkdir(sourcesPath(root), { recursive: true });
    const saved = saveSources(root, { kinds: {}, instances: {}, claims: {}, events: [], nextSeq: 0 });
    expect(saved.ok).toBe(false);
    expect(typeof saved.error).toBe("string");

    const registered = registerSourceKind(root, mailKind());
    expect(registered.ok).toBe(false);
    expect(registered.code).toBe("SOURCE_WRITE_FAILED");

    const entries = await readdir(join(root, ".genie", "rsi"));
    expect(entries).toEqual(["sources.json"]);
    // 目录仍在原处,坏掉的状态没有被覆盖成文件
    const registry = loadSources(root);
    expect(registry.kinds).toEqual({});
  });

  it("14) invalidate 语义后 listEnabled 不含它,claim 已归还", async () => {
    const root = await withMailKind();
    registerSourceInstance(root, { id: "i1", kind: "mail", config: { url: "imap://inbox", claims: ["mailbox:inbox"] } });
    expect(loadSources(root).claims["mailbox:inbox"]).toBe("i1");

    const invalidated = registerSourceInstance(root, {
      id: "i1",
      kind: "mail",
      config: { url: "imap://inbox" },
      enabled: false,
    });
    expect(invalidated.ok).toBe(true);
    const registry = loadSources(root);
    const listEnabled = Object.keys(registry.instances).filter((id) => registry.instances[id]?.enabled === true);
    expect(listEnabled).not.toContain("i1");
    expect(registry.instances["i1"]?.enabled).toBe(false);
    expect(Object.keys(registry.claims)).toEqual([]);
    const write = writeSourceEvent(root, { instanceId: "i1", event: { type: "mail.received", payload: { subject: "a" } } });
    expect(write.code).toBe("SOURCE_DISABLED");
  });
});
