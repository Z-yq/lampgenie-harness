import { afterAll, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModificationRequest } from "@lampgenie/runtime/agent/self-modification";
import {
  approveModification,
  denyModification,
  getModification,
  listModifications,
  loadSelfModProjection,
  markApplied,
  reportModifications,
  requestModification,
  rollbackModification,
  selfModificationPath,
} from "../src/self-modification-store";

/** 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。 */
const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-self-mod-store-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 六件套齐全的请求(owner 作者,默认应放行)。 */
function makeRequest(overrides: Record<string, unknown> = {}): ModificationRequest {
  const now = Date.now();
  const base: Record<string, unknown> = {
    id: "mod-1",
    schemaVersion: 1,
    surface: "tip",
    targetRef: "tips/read-file.md",
    variant: "v2",
    summary: "tip 内联文件摘要降低重复读",
    author: { kind: "owner", id: "owner-1" },
    evidence: { experimentId: "exp-1", diffSummary: "diff --stat", testsRun: "vitest run tips" },
    impact: { files: ["tips/read-file.md"], scanRef: "code-sense:tip", blastRadius: "low" },
    dryRun: { command: "npx vitest run tips", ok: true, at: now },
    canary: { scope: "session", size: 3 },
    rollback: { kind: "flag", ref: "flag:tip-inline-summary" },
    ownerName: "owner-1",
    irreversible: false,
    riskFlags: [],
    createdAt: now,
    updatedAt: now,
    decision: { kind: "pending" },
  };
  return { ...base, ...overrides } as unknown as ModificationRequest;
}

/** rsi 作者(需人类审批)。 */
function makeRsiRequest(overrides: Record<string, unknown> = {}): ModificationRequest {
  return makeRequest({ id: "mod-rsi", author: { kind: "rsi", id: "rsi-1" }, ...overrides });
}

/** 台账非空行(直接读文件,绕开投影)。 */
async function ledgerLines(root: string): Promise<string[]> {
  const text = await readFile(selfModificationPath(root), "utf8");
  return text.split("\n").filter((line) => line.trim() !== "");
}

/** 手工追加一行原始文本(模拟坏行/外部写入)。 */
async function appendRaw(root: string, line: string): Promise<void> {
  const path = selfModificationPath(root);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, "utf8");
}

describe("self-modification-store", () => {
  it("1. 六件套齐全的 owner 请求 → allow,applied=false,frozenHash 64 hex", async () => {
    const root = await tmpRoot();
    const result = requestModification(root, makeRequest());
    expect(result.ok).toBe(true);
    expect(result.decision).toBe("allow");
    expect(result.codes).toEqual([]);
    expect(result.id).toBe("mod-1");

    const record = getModification(root, "mod-1");
    expect(record).toBeDefined();
    expect(record?.applied).toBe(false);
    expect(record?.frozenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.decision.kind).toBe("allow");
    expect(await ledgerLines(root)).toHaveLength(1);
  });

  it("2. rsi 作者无 approver → need-approval 且落盘", async () => {
    const root = await tmpRoot();
    const result = requestModification(root, makeRsiRequest());
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("need-approval");
    expect(result.codes).toContain("MOD_RSI_NEEDS_HUMAN");
    const record = getModification(root, "mod-rsi");
    expect(record?.decision.kind).toBe("need-approval");
    expect(record?.applied).toBe(false);
  });

  it("3. 缺 evidence → deny 且 codes 含 MOD_EVIDENCE_MISSING", async () => {
    const root = await tmpRoot();
    const result = requestModification(root, makeRequest({ id: "mod-noev", evidence: {} }));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("deny");
    expect(result.codes).toContain("MOD_EVIDENCE_MISSING");
    expect(getModification(root, "mod-noev")?.decision.kind).toBe("deny");
  });

  it("4. 重复 id → MOD_DUPLICATE 且不写盘", async () => {
    const root = await tmpRoot();
    expect(requestModification(root, makeRequest()).ok).toBe(true);
    const dup = requestModification(root, makeRequest({ summary: "另一条同 id 请求" }));
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe("MOD_DUPLICATE");
    expect(dup.codes).toEqual(["MOD_DUPLICATE"]);
    expect(await ledgerLines(root)).toHaveLength(1);
    expect(loadSelfModProjection(root).totalLines).toBe(1);
  });

  it("5. human 审批 rsi 请求 → allow 且投影记录 approver", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRsiRequest());
    const approved = approveModification(root, "mod-rsi", { by: "human-1", kind: "human", reason: "评审通过" });
    expect(approved.ok).toBe(true);
    expect(approved.decision).toBe("allow");
    expect(approved.codes).toEqual([]);

    const record = getModification(root, "mod-rsi");
    expect(record?.decision.kind).toBe("allow");
    expect(record?.approver?.kind).toBe("human");
    expect(record?.approver?.id).toBe("human-1");
    expect(record?.lastAction).toBe("approve");
  });

  it("6. owner 审批 rsi 请求 → 拒绝且 codes 含 MOD_AGENT_APPROVAL_FORBIDDEN", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRsiRequest());
    const before = (await ledgerLines(root)).length;
    const result = approveModification(root, "mod-rsi", { by: "owner-1", kind: "owner" });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("MOD_AGENT_APPROVAL_FORBIDDEN");
    expect(result.codes).toContain("MOD_RSI_NEEDS_HUMAN");
    expect((await ledgerLines(root)).length).toBe(before);
    expect(getModification(root, "mod-rsi")?.decision.kind).toBe("need-approval");
  });

  it("7. 审批已 allow 的记录 → MOD_DECISION_FINAL", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRequest());
    const result = approveModification(root, "mod-1", { by: "human-2", kind: "human" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MOD_DECISION_FINAL");
    expect(result.codes).toEqual(["MOD_DECISION_FINAL"]);
  });

  it("8. apply 未 allow 的记录 → MOD_DECISION_FINAL", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRsiRequest());
    const frozenHash = getModification(root, "mod-rsi")?.frozenHash ?? "";
    const result = markApplied(root, "mod-rsi", { frozenHash });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MOD_DECISION_FINAL");
    expect(getModification(root, "mod-rsi")?.applied).toBe(false);
  });

  it("9. apply 正确 frozenHash → applied=true,apply 行含 16 hex objectHash", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRequest());
    const frozenHash = getModification(root, "mod-1")?.frozenHash ?? "";
    const result = markApplied(root, "mod-1", { frozenHash });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.objectHash).toMatch(/^[0-9a-f]{16}$/);

    const record = getModification(root, "mod-1");
    expect(record?.applied).toBe(true);
    expect(record?.lastAction).toBe("apply");
    expect(record?.objectHash).toBe(result.objectHash);

    const lines = await ledgerLines(root);
    expect(lines).toHaveLength(2);
    const applyLine = JSON.parse(lines[1]) as { type: string; patch: { frozenHash: string; objectHash: string } };
    expect(applyLine.type).toBe("apply");
    expect(applyLine.patch.frozenHash).toBe(frozenHash);
    expect(applyLine.patch.objectHash).toBe(result.objectHash);
  });

  it("10. apply 错误 hash → MOD_HASH_MISMATCH 且不写盘", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRequest());
    const before = (await ledgerLines(root)).length;
    const result = markApplied(root, "mod-1", { frozenHash: "0".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MOD_HASH_MISMATCH");
    expect(result.codes).toEqual(["MOD_HASH_MISMATCH"]);
    expect((await ledgerLines(root)).length).toBe(before);
    expect(getModification(root, "mod-1")?.applied).toBe(false);
  });

  it("11. rollback → rolled-back 且 reason 记录", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRequest());
    const result = rollbackModification(root, "mod-1", { reason: "结果指标回退" });
    expect(result.ok).toBe(true);
    expect(result.decision).toBe("rolled-back");
    const record = getModification(root, "mod-1");
    expect(record?.decision.kind).toBe("rolled-back");
    expect(record?.reason).toBe("结果指标回退");
    expect(record?.lastAction).toBe("rollback");
  });

  it("12. 坏行(坏 JSON + 未知 v)只计数,其它记录仍可读", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRequest());
    await appendRaw(root, "{bad json\n");
    await appendRaw(root, `${JSON.stringify({ v: 2, type: "request", at: Date.now(), request: makeRequest({ id: "mod-x" }) })}\n`);

    const projection = loadSelfModProjection(root);
    expect(projection.badLines).toBe(2);
    expect(projection.totalLines).toBe(3);
    expect(projection.requests).toHaveLength(1);
    expect(projection.requests[0]?.id).toBe("mod-1");
    expect(projection.requests[0]?.decision.kind).toBe("allow");
  });

  it("13. report 计数正确(pending/allowed/applied/bySurface)", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRequest({ id: "mod-a" }));
    markApplied(root, "mod-a", { frozenHash: getModification(root, "mod-a")?.frozenHash ?? "" });
    requestModification(root, makeRsiRequest({ id: "mod-b" }));
    requestModification(root, makeRequest({ id: "mod-c", surface: "prompt", evidence: {} }));

    const report = reportModifications(root);
    expect(report.ok).toBe(true);
    expect(report.totalLines).toBe(4);
    expect(report.badLines).toBe(0);
    expect(report.total).toBe(3);
    expect(report.pending).toBe(0);
    expect(report.allowed).toBe(1);
    expect(report.needApproval).toBe(1);
    expect(report.denied).toBe(1);
    expect(report.applied).toBe(1);
    expect(report.rolledBack).toBe(0);
    expect(report.bySurface).toEqual({ tip: 2, prompt: 1 });
    expect(listModifications(root, { decision: "allow" }).map((r) => r.id)).toEqual(["mod-a"]);
    expect(listModifications(root, { surface: "prompt" }).map((r) => r.id)).toEqual(["mod-c"]);
  });

  it("14. deny 缺 reason → MOD_REASON_REQUIRED 且不写盘", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRsiRequest());
    const before = (await ledgerLines(root)).length;
    const result = denyModification(root, "mod-rsi", { by: "human-1", reason: "   " });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MOD_REASON_REQUIRED");
    expect((await ledgerLines(root)).length).toBe(before);
    expect(getModification(root, "mod-rsi")?.decision.kind).toBe("need-approval");
  });

  it("15. 投影 latest-wins:approve 之后的 deny 行覆盖 decision", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRsiRequest());
    expect(approveModification(root, "mod-rsi", { by: "human-1", kind: "human" }).ok).toBe(true);
    expect(getModification(root, "mod-rsi")?.decision.kind).toBe("allow");

    await appendRaw(
      root,
      `${JSON.stringify({
        v: 1,
        type: "deny",
        at: Date.now(),
        id: "mod-rsi",
        patch: { decision: { kind: "deny", at: Date.now(), codes: ["MOD_DENIED"] }, reason: "人类事后推翻" },
      })}\n`,
    );
    const record = getModification(root, "mod-rsi");
    expect(record?.decision.kind).toBe("deny");
    expect(record?.reason).toBe("人类事后推翻");
    expect(record?.lastAction).toBe("deny");
    expect(reportModifications(root).denied).toBe(1);
  });

  it("16. 未知 id 的 apply 行 → 计入 badLines 不抛", async () => {
    const root = await tmpRoot();
    requestModification(root, makeRequest());
    await appendRaw(
      root,
      `${JSON.stringify({ v: 1, type: "apply", at: Date.now(), id: "ghost", patch: { frozenHash: "a", objectHash: "b" } })}\n`,
    );
    let projection: ReturnType<typeof loadSelfModProjection> | undefined;
    expect(() => {
      projection = loadSelfModProjection(root);
    }).not.toThrow();
    expect(projection?.badLines).toBe(1);
    expect(projection?.totalLines).toBe(2);
    expect(projection?.requests).toHaveLength(1);
    expect(projection?.requests[0]?.applied).toBe(false);
  });
});
