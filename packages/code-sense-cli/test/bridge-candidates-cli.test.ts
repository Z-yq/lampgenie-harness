/**
 * CLI `bridge --candidates`:候选区文本/JSON 输出 + 参数解析兼容。
 * 契约:缺省 bridge 输出不变;--candidates 追加 tier=semantic 候选区(确定性边仍在默认区)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../src/cli.js";
import { parseArgs } from "../src/args.js";

let ws = "";

function capture(): { io: CliIo; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: { out: (s) => (o.push(s), undefined), err: (s) => (e.push(s), undefined) },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

const BACKEND = `from flask import Flask

app = Flask(__name__)

@app.route("/api/orders", methods=["POST"])
def create_order():
    return {}

@app.route("/api/admin/panel")
def admin_panel():
    return {}

@app.route("/api/health")
def health():
    return {}
`;

const FRONTEND = `export const load = () => fetch("/api/orders");
export const admin = () => fetch("/api/admin");
export const base = "/api";
`;

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "csbridge-cli-"));
  mkdirSync(join(ws, "backend"), { recursive: true });
  mkdirSync(join(ws, "frontend"), { recursive: true });
  writeFileSync(join(ws, "backend", "app.py"), BACKEND);
  writeFileSync(join(ws, "frontend", "main.ts"), FRONTEND);
});
afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("parseArgs --candidates/--semantic", () => {
  it("布尔开关不吞后续位置参数/取值", () => {
    const p = parseArgs(["bridge", "--candidates", "--root", "/x"]);
    expect(p.flags.candidates).toBe(true);
    expect(p.flags.root).toBe("/x");
    expect(p._).toEqual(["bridge"]);
    const p2 = parseArgs(["bridge", "--semantic", "--all"]);
    expect(p2.flags.semantic).toBe(true);
    expect(p2.flags.all).toBe(true);
    const p3 = parseArgs(["bridge", "--candidates=all"]);
    expect(p3.flags.candidates).toBe("all");
  });
});

describe("CLI bridge --candidates", () => {
  it("缺省 JSON 兼容:无 semanticCandidates 字段", async () => {
    const r = capture();
    expect(await runCli(["bridge", "--root", ws, "--json"], r.io)).toBe(0);
    const j = JSON.parse(r.out());
    expect(j.query).toBe("bridge");
    expect(Array.isArray(j.edges)).toBe(true);
    expect(j.edges.length).toBe(1);
    expect(j.semanticCandidates).toBeUndefined();
    expect(j.semanticCandidateStats).toBeUndefined();
  }, 60_000);

  it("--candidates --json:候选区在场且 tier=semantic;确定性边仍在 edges", async () => {
    const r = capture();
    expect(await runCli(["bridge", "--root", ws, "--candidates", "--json"], r.io)).toBe(0);
    const j = JSON.parse(r.out());
    expect(j.edges.length).toBe(1);
    expect(Array.isArray(j.semanticCandidates)).toBe(true);
    expect(j.semanticCandidates.length).toBeGreaterThanOrEqual(1);
    expect(j.semanticCandidateStats.endpointsExact).toBe(1);
    const cand = j.semanticCandidates.find((c: { from: { literal: string } }) => c.from.literal === "/api/admin");
    expect(cand.to.path).toBe("/api/admin/panel");
    expect(cand.to.handler).toBe("admin_panel");
    expect(cand.tier).toBe("semantic");
    expect(cand.confidence).toBe("medium");
    expect(cand.evidence.join("\n")).toContain("前端证据");
    expect(cand.evidence.join("\n")).toContain("后端证据");
    // prefix1 不在缺省候选区
    expect(j.semanticCandidates.some((c: { match: string }) => c.match === "prefix1")).toBe(false);
  }, 60_000);

  it("文本输出:确定性边区 + 候选区两段;--semantic 同义;=all 追加 prefix1", async () => {
    const r = capture();
    expect(await runCli(["bridge", "--root", ws, "--candidates", "--no-color"], r.io)).toBe(0);
    const text = r.out();
    expect(text).toContain("跨语言桥边(http-api)");
    expect(text).toContain("LLM 消歧候选区(http-api)");
    expect(text).toContain("admin_panel");
    expect(text).toContain("tier=semantic");

    const r2 = capture();
    expect(await runCli(["bridge", "--root", ws, "--semantic", "--json"], r2.io)).toBe(0);
    expect(JSON.parse(r2.out()).semanticCandidates.length).toBeGreaterThanOrEqual(1);

    const r3 = capture();
    expect(await runCli(["bridge", "--root", ws, "--candidates=all", "--json"], r3.io)).toBe(0);
    const j3 = JSON.parse(r3.out());
    const p1 = j3.semanticCandidates.find((c: { match: string; confidence: string }) => c.match === "prefix1");
    expect(p1).toBeTruthy();
    expect(p1.confidence).toBe("low");
  }, 90_000);
});
