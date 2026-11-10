/**
 * 写板拒收自愈(2026-10-31):kind 校正 + label 截断。
 *
 * 缺陷实测:两轮真跑(15 步 / 14 步)都因同样两件事被**整板拒收**——
 * ① kind 写枚举外值(`util`/`cache` 之类);② label 20 字超 14 限。
 * schema 描述里早已写明「只能取本枚举值之一」「≤14 字」,模型照踩 → 文案路线到顶,改机制兜底。
 * 代价:白付一步 + 一条 400 字符错误回执永驻历史(board_upsert 在 NEVER_COMPACT_TOOLS 里)。
 *
 * negative:不得把「真错误」也自愈掉——边悬空/id 重复/P0 缺 accept/证据不足 仍必须拒收。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveBoard, allowedNodeKinds, FALLBACK_NODE_KINDS, LABEL_MAX_CHARS } from "../src/board-store.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gh-board-heal-"));
}

function doc(nodes: unknown[], extra: Record<string, unknown> = {}) {
  return {
    version: 1, taskId: "t1", sessionId: "s1", title: "板", status: "draft", rev: 0,
    nodes, edges: [], planned_files: [], updatedAt: 0, ...extra,
  };
}

const node = (over: Record<string, unknown>) => ({
  id: "n1", kind: "module", label: "正常节点", summary: "实现细节描述", change: "add", ...over,
});

describe("agent 写入面自愈:kind 校正", () => {
  it("枚举外 kind(util)→ 纠正为 module 并落盘,回执点名改了什么", () => {
    const root = tmp();
    try {
      const r = saveBoard(root, doc([node({ kind: "util" })]), { agentWrite: true, skipGates: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.doc.nodes[0]!.kind).toBe("module");
      expect(r.corrections).toHaveLength(1);
      expect(r.corrections![0]).toContain("util");
      expect(r.corrections![0]).toContain("module");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("别名映射按最近义(cache→module / condition→decision / endpoint→http)", () => {
    const root = tmp();
    try {
      const r = saveBoard(root, doc([
        node({ id: "a", kind: "cache" }),
        node({ id: "b", kind: "condition" }),
        node({ id: "c", kind: "endpoint" }),
      ]), { agentWrite: true, skipGates: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const byId = new Map(r.doc.nodes.map((n) => [n.id, n.kind]));
      expect(byId.get("a")).toBe("module");
      expect(byId.get("b")).toBe("decision");
      expect(byId.get("c")).toBe("http");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("未知别名(没映射过)→ 回落 module(合法值,不整板拒收)", () => {
    const root = tmp();
    try {
      const r = saveBoard(root, doc([node({ kind: "zzz-unknown" })]), { agentWrite: true, skipGates: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.doc.nodes[0]!.kind).toBe("module");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("合法 kind 不产生纠正记录(不制造噪音)", () => {
    const root = tmp();
    try {
      const r = saveBoard(root, doc([node({ kind: "function", label: "短标签" })]), { agentWrite: true, skipGates: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.corrections ?? []).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("agent 写入面自愈:label 截断", () => {
  it("label 超 14 字 → 截断到 14 字并落盘,回执点名", () => {
    const root = tmp();
    try {
      const long = "package.json test 脚本"; // 实测真跑里就是这条被拒
      expect([...long].length).toBeGreaterThan(LABEL_MAX_CHARS);
      const r = saveBoard(root, doc([node({ label: long })]), { agentWrite: true, skipGates: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect([...r.doc.nodes[0]!.label].length).toBe(LABEL_MAX_CHARS);
      expect(r.corrections![0]).toContain("label");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("label 已在豁免集里(本次没改它)→ 不截断(存量超长不因每次提交被动刀)", () => {
    const root = tmp();
    try {
      const long = "存量超长的历史标签文本";
      const r = saveBoard(root, doc([node({ label: long })]),
        { agentWrite: true, skipGates: true, labelExemptNodeIds: ["n1"] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.doc.nodes[0]!.label).toBe(long);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("negative:真错误仍必须拒收(自愈不得变成免检)", () => {
  it("边引用不存在节点 → 拒收", () => {
    const root = tmp();
    try {
      const r = saveBoard(root, doc([node({})], { edges: [{ from: "n1", to: "ghost" }] }), { agentWrite: true, skipGates: true });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain("不存在的节点");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("节点 id 重复 → 拒收", () => {
    const root = tmp();
    try {
      const r = saveBoard(root, doc([node({ id: "dup" }), node({ id: "dup", label: "另一个" })]), { agentWrite: true, skipGates: true });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain("重复");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("P0 缺 accept → 仍拒收(自愈只管 kind/label)", () => {
    const root = tmp();
    try {
      const r = saveBoard(root, doc([node({ phase: "P0" })]), { agentWrite: true });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain("accept");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("人经 board.save 写(不传 agentWrite)→ 非法 kind 不纠正,保持严格校验", () => {
    const root = tmp();
    try {
      const r = saveBoard(root, doc([node({ kind: "util" })]), { skipGates: true });
      expect(r.ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("kind 枚举内省(协议加新 kind 而兜底清单没跟上 = 可测)", () => {
  it("allowedNodeKinds() 与 FALLBACK_NODE_KINDS 集合一致", () => {
    const live = new Set(allowedNodeKinds());
    const fallback = new Set(FALLBACK_NODE_KINDS);
    const missing = [...live].filter((k) => !fallback.has(k));
    const extra = [...fallback].filter((k) => !live.has(k));
    expect(missing, `协议新增了 kind 但 FALLBACK_NODE_KINDS 没跟上:${missing.join(",")}`).toHaveLength(0);
    expect(extra, `FALLBACK_NODE_KINDS 有协议已删的 kind:${extra.join(",")}`).toHaveLength(0);
  });

  it("内省走通(不是回落到硬编码)", () => {
    expect(allowedNodeKinds().length).toBeGreaterThan(0);
  });
});