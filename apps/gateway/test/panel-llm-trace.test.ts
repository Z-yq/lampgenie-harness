/**
 * GET /api/llm-trace 契约测试(step-1026):轨迹看板卡体的全文读取口。
 * 安全面:正例 200、越界 403、非 .json 403、不存在 404、超 8MB 413。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { servePanel } from "../src/panel.js";
import { repoRoot } from "../src/repo-root.js";

const PORT = 7902;
const BASE = "http://127.0.0.1:" + PORT;
const ROOT = join(repoRoot(), ".genie", "llm-trace");
const SID = "test-step1026-route";
const DIR = join(ROOT, SID);
const GOOD = join(DIR, "call-0001-t1s0-1.json");
const TXT = join(DIR, "note.txt");
const BIG = join(DIR, "call-0002-t1s1-2.json");
let srv: { close: () => Promise<void> } | null = null;

beforeAll(async () => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(GOOD, JSON.stringify({ sessionId: SID, request: { messages: [{ role: "user", content: "hi" }] }, response: { content: "ok" } }), "utf-8");
  writeFileSync(TXT, "not json", "utf-8");
  writeFileSync(BIG, "{pad:" + "a".repeat(9 * 1024 * 1024) + "}", "utf-8");
  srv = servePanel(PORT, () => {});
  await new Promise((r) => setTimeout(r, 150));
});

afterAll(async () => {
  if (srv) await srv.close();
  try { rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
});

const url = (p: string) => BASE + "/api/llm-trace?path=" + encodeURIComponent(p);

describe("/api/llm-trace 全文读取口", () => {
  it("①正例:轨迹根内 .json 原样返回,cache-control private", async () => {
    const res = await fetch(url(realpathSync(GOOD)));
    expect(res.status).toBe(200);
    expect(String(res.headers.get("cache-control") || "")).toContain("private");
    const body = await res.json() as { sessionId?: string; response?: { content?: string } };
    expect(body.sessionId).toBe(SID);
    expect(body.response?.content).toBe("ok");
  });

  it("②越界:轨迹根之外(系统文件/仓库文件)一律 403", async () => {
    for (const p of ["/etc/passwd", join(repoRoot(), "package.json"), join(ROOT, "..", "boards")]) {
      const res = await fetch(url(p));
      expect(res.status, "应拒绝 " + p).toBe(403);
    }
  });

  it("③非 .json:根内但扩展名不符 → 403", async () => {
    const res = await fetch(url(TXT));
    expect(res.status).toBe(403);
    const j = await res.json() as { reason?: string };
    expect(String(j.reason || "")).toContain("json");
  });

  it("④不存在 → 404;缺 path/相对路径 → 400", async () => {
    expect((await fetch(url(join(DIR, "call-9999-t9s9-0.json")))).status).toBe(404);
    expect((await fetch(BASE + "/api/llm-trace")).status).toBe(400);
    expect((await fetch(url("relative/path.json"))).status).toBe(400);
  });

  it("⑤超 8MB → 413", async () => {
    const res = await fetch(url(BIG));
    expect(res.status).toBe(413);
  });
});
