/**
 * 接线单测：TeamP2P.send/flushQueue 接入死目标表、未证实目标拒绝、decline 终态。
 * 两条线：
 * 1) 源码接线断言（可选选项/联合类型/短路顺序是否真在源码里）；
 * 2) 真实例化 TeamP2P 走真路径（死目标短路不进队列、未证实拒收、decline 终态、旧行为兼容）。
 * 跑法：cd apps/gateway && NODE_OPTIONS=--conditions=development npx vitest run test/delivery-target-wiring.test.ts
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeadTargetTable } from "@lampgenie/runtime/notify/delivery-target";
import { TeamP2P, type TeamMember } from "../src/team-p2p.js";

const SRC = readFileSync(fileURLToPath(new URL("../src/team-p2p.ts", import.meta.url)), "utf-8");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "m141-wiring-"));
}

/** 在临时仓里补一个对端成员（目录条目只需 username/host/port/指纹/角色）。 */
function addPeer(root: string, username: string): void {
  const file = join(root, ".genie", "team", "members.json");
  const arr = JSON.parse(readFileSync(file, "utf-8")) as TeamMember[];
  arr.push({ username, host: "127.0.0.1", port: 7911, pubkeyFingerprint: "peer-fp", role: "member" });
  writeFileSync(file, JSON.stringify(arr, null, 2));
}

const okFetch = (async () => ({ ok: true, status: 200 }) as unknown as Response) as typeof fetch;
const failFetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as typeof fetch;

describe("源码接线：类型与选项只增不改", () => {
  it("P2pMessage 增可选项 reason/declined，via 联合增 rejected", () => {
    expect(SRC).toMatch(/via: "p2p" \| "relay" \| "queued" \| "rejected"/);
    expect(SRC).toMatch(/reason\?: string;/);
    expect(SRC).toMatch(/declined\?: boolean;/);
  });
  it("TeamP2POptions 增三个可选项", () => {
    expect(SRC).toMatch(/deadTargets\?: DeadTargetTable;/);
    expect(SRC).toMatch(/attestedTargets\?: \(to: string\) => boolean;/);
    expect(SRC).toMatch(/relaySendDeclined\?: \(to: string, text: string\) => boolean;/);
  });
  it("send 内死目标短路先于 members 查找，未证实拒收先于旧 queued 分支", () => {
    const sendBody = SRC.slice(SRC.indexOf("async send("), SRC.indexOf("async flushQueue("));
    const iDead = sendBody.indexOf("deadTargets?.isDead(to)");
    const iMembers = sendBody.indexOf("this.members().find((x) => x.username === to)");
    const iAttest = sendBody.indexOf("attestedTargets(to) === false");
    const iQueued = sendBody.indexOf('msg.via = "queued";');
    expect(iDead).toBeGreaterThan(-1);
    expect(iMembers).toBeGreaterThan(iDead);
    expect(iAttest).toBeGreaterThan(iMembers);
    expect(iQueued).toBeGreaterThan(iAttest);
 // 拒收原因与 decline 标死的真值字面量必须在位
    expect(SRC).toContain('reason = "dead-target"');
    expect(SRC).toContain('reason = "target-not-attested"');
    expect(SRC).toContain('reason: "whole-chat declined"');
    expect(SRC).toContain("deadTargets?.clear(to)");
  });
  it("flushQueue 先查死表跳过并移除，不再 push", () => {
    const flushBody = SRC.slice(SRC.indexOf("async flushQueue("), SRC.indexOf("handleRequest("));
    expect(flushBody).toContain("deadTargets?.isDead(m.to)");
    const iGuard = flushBody.indexOf("deadTargets?.isDead(m.to)");
    const iSend = flushBody.indexOf("await this.send(");
    expect(iGuard).toBeGreaterThan(-1);
    expect(iSend).toBeGreaterThan(iGuard);
    expect(flushBody).toContain("continue;");
  });
});

describe("真实例化：死目标短路", () => {
  it("send 到死目标 → via=rejected / reason=dead-target，且不进离线队列、不发起 fetch", async () => {
    const root = tmpRoot();
    try {
      let fetched = 0;
      const fetchImpl = (async () => {
        fetched++;
        return { ok: true, status: 200 } as unknown as Response;
      }) as typeof fetch;
      const deadTargets = new DeadTargetTable();
      const p2p = new TeamP2P({ repoRoot: root, port: 7912, username: "me", fetchImpl, deadTargets });
      addPeer(root, "ghost"); // 目录里有，但整聊已死
      deadTargets.markDead("ghost", { reason: "kicked by owner", at: 1 });
      const r = await p2p.send("ghost", "hello");
      expect(r.via).toBe("rejected");
      expect(r.reason).toBe("dead-target");
      expect(p2p.status().offlineQueue).toBe(0);
      expect(fetched).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("真实例化：未证实目标拒绝", () => {
  it("attestedTargets 明确 false → via=rejected / reason=target-not-attested，不落队列", async () => {
    const root = tmpRoot();
    try {
      const p2p = new TeamP2P({ repoRoot: root, port: 7913, username: "me", fetchImpl: okFetch, attestedTargets: () => false });
      const r = await p2p.send("stranger", "hello");
      expect(r.via).toBe("rejected");
      expect(r.reason).toBe("target-not-attested");
      expect(p2p.status().offlineQueue).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("未提供 attestedTargets 时保持旧行为：未知目标 → queued（兼容）", async () => {
    const root = tmpRoot();
    try {
      const p2p = new TeamP2P({ repoRoot: root, port: 7914, username: "me", fetchImpl: okFetch });
      const r = await p2p.send("stranger", "hello");
      expect(r.via).toBe("queued");
      expect(p2p.status().offlineQueue).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("真实例化：decline 是终态", () => {
  it("p2p 不可达 + relay 回答 decline → via=rejected/declined=true，不排队且标死", async () => {
    const root = tmpRoot();
    try {
      const deadTargets = new DeadTargetTable();
      let relayCalls = 0;
      const p2p = new TeamP2P({
        repoRoot: root,
        port: 7915,
        username: "me",
        fetchImpl: failFetch,
        deadTargets,
        relaySendDeclined: () => true,
        relaySend: () => {
          relayCalls++;
          return true; // 旧 relay 兜底即使可用也不该被采纳（decline 优先）
        },
      });
      addPeer(root, "peer");
      const r = await p2p.send("peer", "hello");
      expect(r.via).toBe("rejected");
      expect(r.declined).toBe(true);
      expect(r.reason).toBe("declined");
      expect(relayCalls).toBe(0);
      expect(p2p.status().offlineQueue).toBe(0);
      expect(deadTargets.isDead("peer")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("未配置 relaySendDeclined 时旧降级路径逐字不变：relay 命中 → via=relay", async () => {
    const root = tmpRoot();
    try {
      const p2p = new TeamP2P({ repoRoot: root, port: 7916, username: "me", fetchImpl: failFetch, relaySend: () => true });
      addPeer(root, "peer2");
      const r = await p2p.send("peer2", "hello");
      expect(r.via).toBe("relay");
      expect(r.declined).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("真实例化：p2p 成功路径未受影响", () => {
  it("对端在线 → via=p2p，死表无残留", async () => {
    const root = tmpRoot();
    try {
      const deadTargets = new DeadTargetTable();
      const p2p = new TeamP2P({ repoRoot: root, port: 7917, username: "me", fetchImpl: okFetch, deadTargets });
      addPeer(root, "peer3");
      const r = await p2p.send("peer3", "hi");
      expect(r.via).toBe("p2p");
      expect(deadTargets.isDead("peer3")).toBe(false);
      expect(p2p.status().offlineQueue).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("真实例化：flushQueue 跳过并移除死目标条目", () => {
  it("队列里的死目标被移除，返回 0 且不再重发", async () => {
    const root = tmpRoot();
    try {
      let fetched = 0;
      const fetchImpl = (async () => {
        fetched++;
        return { ok: true, status: 200 } as unknown as Response;
      }) as typeof fetch;
      const deadTargets = new DeadTargetTable();
      const p2p = new TeamP2P({ repoRoot: root, port: 7918, username: "me", fetchImpl, deadTargets });
 // 旧行为：未知目标入队
      await p2p.send("ghost2", "queued msg");
      expect(p2p.status().offlineQueue).toBe(1);
 // 随后整聊死亡
      deadTargets.markDead("ghost2", { reason: "whole-chat deleted", at: 2 });
      const sent = await p2p.flushQueue();
      expect(sent).toBe(0);
      expect(p2p.status().offlineQueue).toBe(0);
      expect(fetched).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
