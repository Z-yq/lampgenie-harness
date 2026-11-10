/**
 * #179 Peer 级访问快照(IO 面)直测:全部落 /tmp(禁止写仓库内 .genie)。
 *
 * 关注点不是「函数返回了什么」,而是**磁盘上到底写了什么**:
 * 策略文件缺失/坏掉只降级不炸、POLICY_FAILED 的授权不能以任何形态进 baseline、
 * 快照整份原子替换且不留临时文件、invalidate 必须按**当前**策略重算(改文件后基线就变)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  decidePeer,
  invalidatePeer,
  listPeerAllows,
  mergeReconnectPeer,
  peerPolicyPaths,
  readPeerPolicyFile,
  readPeerSnapshots,
  reloadPeer,
  reportPeerPolicies,
  snapshotPeer,
  writePeerSnapshots,
} from "../src/peer-policy-store";
import type { PeerSnapshot } from "@lampgenie/runtime/agent/peer-policy";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "genie-peer-store-"));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** 写文件前先建目录:.genie/rsi 首次写入时并不存在(store 侧同样要 mkdir recursive)。 */
async function writeRaw(file: string, body: string): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
  return file;
}

async function writePolicy(rel: string, body: string): Promise<string> {
  return writeRaw(rel.startsWith("/") ? rel : join(root, rel), body);
}

function policyBody(methods: string[], policies: unknown[]): string {
  return JSON.stringify({ v: 1, methods, policies });
}

describe("策略文件读取", () => {
  it("缺策略文件 → 空 PolicySet,decide 为 DENY_NO_POLICY", async () => {
    const res = await decidePeer(root, { principal: { id: "v1", kind: "viewer" }, method: "msg.send" });
    expect(res.code).toBe("PEER_DENY_NO_POLICY");
    expect(res.allow).toBe(false);
    expect(res.file).toBe(peerPolicyPaths(root).policyFile);
    const policy = await readPeerPolicyFile(root);
    expect(policy.policySet).toEqual({ policies: [], methods: [] });
    expect(policy.missing).toBe(true);
    expect(policy.corrupt).toBe(0);
  });

  it("坏策略 JSON → 同结果且 corrupt 计数 1", async () => {
    const alt = await writePolicy(".genie/rsi/broken-policies.json", "{not json");
    const policy = await readPeerPolicyFile(root, alt);
    expect(policy.corrupt).toBe(1);
    expect(policy.policySet.policies).toEqual([]);
    const res = await decidePeer(root, {
      principal: { id: "v1", kind: "viewer" },
      method: "msg.send",
      policyFile: alt,
    });
    expect(res.code).toBe("PEER_DENY_NO_POLICY");
    expect(res.corrupt).toBe(1);
  });

  it("v 不对 → 空策略且计 corrupt", async () => {
    const alt = await writePolicy(".genie/rsi/wrong-v.json", JSON.stringify({ v: 9, methods: ["msg.send"], policies: [] }));
    const policy = await readPeerPolicyFile(root, alt);
    expect(policy.corrupt).toBe(1);
    expect(policy.policySet.methods).toEqual([]);
  });

  it("非法策略项跳过并计 corrupt,合法项照常生效", async () => {
    const alt = await writePolicy(
      ".genie/rsi/mixed-policies.json",
      policyBody(["msg.send", "msg.edit"], [
        { kind: "nobody" },
        { kind: "viewer", condition: "method-in:msg.send" },
      ]),
    );
    const policy = await readPeerPolicyFile(root, alt);
    expect(policy.corrupt).toBe(1);
    expect(policy.policySet.policies.length).toBe(1);
    expect(policy.policySet.methods).toEqual(["msg.send", "msg.edit"]);
    const send = await decidePeer(root, {
      principal: { id: "v1", kind: "viewer" },
      method: "msg.send",
      policyFile: alt,
    });
    const edit = await decidePeer(root, {
      principal: { id: "v1", kind: "viewer" },
      method: "msg.edit",
      policyFile: alt,
    });
    expect(send.code).toBe("PEER_ALLOW");
    expect(edit.code).toBe("PEER_DENY_POLICY");
  });

  it("policyFile override 指向的文件优先生效", async () => {
    const alt = await writePolicy(".genie/rsi/alt-policies.json", policyBody(["msg.send"], [{ kind: "member" }]));
    const res = await decidePeer(root, {
      principal: { id: "m1", kind: "member" },
      method: "msg.send",
      policyFile: alt,
    });
    expect(res.file).toBe(alt);
    expect(res.code).toBe("PEER_ALLOW");
  });
});

describe("快照落盘与回读", () => {
  it("snapshotPeer 落盘可回读(路径与 baseline 一致)", async () => {
    const paths = peerPolicyPaths(root);
    const res = await snapshotPeer(root, {
      principal: { id: "v1", kind: "viewer" },
      policyFile: await writePolicy(
        ".genie/rsi/snap-policies.json",
        policyBody(["msg.send", "msg.edit"], [{ kind: "viewer", condition: "method-in:msg.send" }]),
      ),
    });
    expect(res.code).toBe("PEER_SNAPSHOT");
    expect(res.file).toBe(paths.snapshotFile);
    expect(res.written).toBe(true);
    const text = await readFile(paths.snapshotFile, "utf8");
    expect(JSON.parse(text).v).toBe(1);
    const read = await readPeerSnapshots(root);
    expect(read.peers["v1"]?.baseline).toEqual({ "msg.send": true, "msg.edit": false });
    expect(read.corrupt).toBe(0);
  });

  it("owner 快照全 allow(策略为空也全 true)", async () => {
    const empty = await writePolicy(".genie/rsi/empty-policies.json", policyBody(["a", "b"], []));
    const res = await snapshotPeer(root, {
      principal: { id: "o1", kind: "owner" },
      policyFile: empty,
    });
    expect(res.snapshot.baseline).toEqual({ a: true, b: true });
    const read = await readPeerSnapshots(root);
    expect(read.peers["o1"]?.baseline).toEqual({ a: true, b: true });
  });

  it("POLICY_FAILED 的 method 不落进 baseline(读盘也没有该 key)", async () => {
    const throwing = await writePolicy(
      ".genie/rsi/throw-policies.json",
      policyBody(["msg.send"], [{ kind: "relay", condition: "throw" }]),
    );
    const res = await snapshotPeer(root, {
      principal: { id: "r1", kind: "relay" },
      policyFile: throwing,
    });
    expect("msg.send" in res.snapshot.baseline).toBe(false);
    const read = await readPeerSnapshots(root);
    expect("msg.send" in (read.peers["r1"]?.baseline ?? {})).toBe(false);
  });

  it("坏 peer-snapshots.json → 读回空且不 throw", async () => {
    await writeRaw(peerPolicyPaths(root).snapshotFile, "{坏文件");
    let read: Awaited<ReturnType<typeof readPeerSnapshots>> | undefined;
    expect(() => readPeerSnapshots(root)).not.toThrow();
    read = await readPeerSnapshots(root);
    expect(read.peers).toEqual({});
    expect(read.corrupt).toBe(1);
    const report = await reportPeerPolicies(root);
    expect(report.peers).toBe(0);
    expect(report.risks.join(",")).toContain("坏快照条目");
  });

  it("坏快照条目跳过,合法条目保留", async () => {
    const file = peerPolicyPaths(root).snapshotFile;
    const good: PeerSnapshot = { principalId: "m9", baseline: { x: true }, follow: [] };
    await writeRaw(file, JSON.stringify({ v: 1, peers: { m9: good, bad: { principalId: 1 } } }));
    const read = await readPeerSnapshots(root);
    expect(read.corrupt).toBe(1);
    expect(Object.keys(read.peers)).toEqual(["m9"]);
    expect(read.peers["m9"]?.baseline).toEqual({ x: true });
  });

  it("原子写后目录里没有临时文件残留", async () => {
    await writePeerSnapshots(root, {
      v2: { principalId: "v2", baseline: { "msg.send": true }, follow: [] },
    });
    const entries = await readdir(peerPolicyPaths(root).dir);
    expect(entries.filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(entries).toContain("peer-snapshots.json");
  });
});

describe("快照演进(reload / invalidate / reconnect)", () => {
  it("reloadPeer 清空旧 follow", async () => {
    const policy = await writePolicy(
      ".genie/rsi/reload-policies.json",
      policyBody(["msg.send"], [{ kind: "viewer", condition: "method-in:msg.send" }]),
    );
    await writePeerSnapshots(root, {
      v3: {
        principalId: "v3",
        baseline: { "msg.send": true },
        follow: [{ at: "2026-01-01T00:00:00.000Z", method: "msg.send", allow: true }],
      },
    });
    const res = await reloadPeer(root, { principal: { id: "v3", kind: "viewer" }, policyFile: policy, at: "T2" });
    expect(res.code).toBe("PEER_RELOADED");
    expect(res.snapshot.follow).toEqual([]);
    expect(res.snapshot.baseline).toEqual({ "msg.send": true });
    const read = await readPeerSnapshots(root);
    expect(read.peers["v3"]?.follow).toEqual([]);
  });

  it("invalidatePeer 按当前策略重算(改文件后 baseline 变化)且 follow 空", async () => {
    const policyFile = join(root, ".genie/rsi/invalidate-policies.json");
    await writeRaw(policyFile, policyBody(["msg.send", "msg.edit"], [{ kind: "viewer", condition: "method-in:msg.send" }]));
    const first = await snapshotPeer(root, { principal: { id: "v4", kind: "viewer" }, policyFile });
    expect(first.snapshot.baseline).toEqual({ "msg.send": true, "msg.edit": false });

    // 策略收紧后失效重算:同一 principal 的基线必须按新策略重建。
    await writeRaw(policyFile, policyBody(["msg.send", "msg.edit"], [{ kind: "viewer", condition: "never" }]));
    const res = await invalidatePeer(root, { principal: { id: "v4", kind: "viewer" }, policyFile, at: "T3" });
    expect(res.code).toBe("PEER_INVALIDATED");
    expect(res.snapshot.baseline).toEqual({ "msg.send": false, "msg.edit": false });
    expect(res.snapshot.follow).toEqual([]);
    const read = await readPeerSnapshots(root);
    expect(read.peers["v4"]?.baseline).toEqual({ "msg.send": false, "msg.edit": false });
  });

  it("invalidatePeer 无既有快照时等价 fresh snapshot(不 throw)", async () => {
    const policy = await writePolicy(".genie/rsi/inv-new-policies.json", policyBody(["msg.send"], [{ kind: "group" }]));
    const res = await invalidatePeer(root, { principal: { id: "g7", kind: "group" }, policyFile: policy });
    expect(res.code).toBe("PEER_SNAPSHOT");
    expect(res.snapshot.baseline).toEqual({ "msg.send": true });
  });

  it("mergeReconnectPeer 保留最后快照的 follow", async () => {
    const follow = [{ at: "2026-02-02T00:00:00.000Z", method: "msg.edit", allow: true }];
    await writePeerSnapshots(root, {
      v5: { principalId: "v5", baseline: { "msg.send": true, "msg.edit": true }, follow },
    });
    const res = await mergeReconnectPeer(root, { principal: { id: "v5", kind: "viewer" } });
    expect(res.code).toBe("PEER_SNAPSHOT");
    expect(res.snapshot.follow).toEqual(follow);
    const read = await readPeerSnapshots(root);
    expect(read.peers["v5"]?.follow).toEqual(follow);
  });
});

describe("批量判定与报告", () => {
  it("listPeerAllows 两 allow 一 deny 且 event 为 PEER_EVENT_DENIED", async () => {
    const policy = await writePolicy(
      ".genie/rsi/list-policies.json",
      policyBody(["msg.send", "msg.edit"], [{ kind: "viewer", condition: "method-in:msg.send" }]),
    );
    const res = await listPeerAllows(root, {
      principal: { id: "v6", kind: "viewer" },
      policyFile: policy,
      items: [{ method: "msg.send" }, { method: "msg.send" }, { method: "msg.edit" }],
    });
    expect(res.allowed).toBe(2);
    expect(res.denied).toBe(1);
    expect(res.event).toEqual({ allow: false, code: "PEER_EVENT_DENIED" });
    expect(res.entries[2]?.code).toBe("PEER_DENY_POLICY");
    expect(res.file).toBe(policy);
  });

  it("reportPeerPolicies 汇总策略/方法/快照与 allow-deny-fail 计数", async () => {
    const report = await reportPeerPolicies(root);
    expect(report.policyFile).toBe(peerPolicyPaths(root).policyFile);
    expect(report.snapshotFile).toBe(peerPolicyPaths(root).snapshotFile);
    expect(report.policies).toBeGreaterThanOrEqual(0);
    expect(report.peers).toBeGreaterThan(0);
    expect(report.allow + report.deny + report.fail).toBeGreaterThan(0);
    expect(typeof report.lastAt).toBe("string");
    expect(Array.isArray(report.risks)).toBe(true);
  });

  it("principal 非法 → TypeError(唯一允许 throw 的情形)", async () => {
    await expect(decidePeer(root, { principal: { id: "", kind: "viewer" }, method: "m" })).rejects.toThrow(TypeError);
    await expect(
      decidePeer(root, { principal: { id: "x", kind: "nobody" as never }, method: "m" }),
    ).rejects.toThrow(TypeError);
    await expect(decidePeer(root, { principal: undefined as never, method: "m" })).rejects.toThrow(TypeError);
  });
});
