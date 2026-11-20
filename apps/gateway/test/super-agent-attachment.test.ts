/**
 * 指挥台上传:super 轮次吃附件。
 * 口径:附件块进 user 文本(「## 附件」),图片进视觉通道(images);不支持视觉时不进通道但块内如实说明。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { runSuperAgentTurn, type SuperAgentDeps } from "../src/super-agent.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const TIMEOUT = 120_000;
type Msg = { role: string; content: unknown; images?: string[] };
type Captured = { content: string; images?: string[] };

/** 捕获 llm 请求(messages 里 user 的 content/images 就是附件注入的落点)。 */
function deps(): { d: SuperAgentDeps; captured: Captured[]; chats: () => number } {
  const taskManager = new TaskSupervisor();
  const projects = new ProjectRegistry(null);
  const journal = new MemoryJournal();
  const captured: Captured[] = [];
  let n = 0;
  const llm = {
    async chat(messages: Msg[]) {
      n++;
      const last = [...(messages || [])].reverse().find((m) => m.role === "user");
      if (last) captured.push({ content: String(last.content ?? ""), ...(last.images?.length ? { images: last.images } : {}) });
      return { content: "收到" };
    },
  };
  return { d: { taskManager, projects, journal, llm } as unknown as SuperAgentDeps, captured, chats: () => n };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "super-att-"));
}
const soul = () => new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));

describe("super 轮次附件注入(2026-11-16)", () => {
  it("图片+文本附件:块进 user 文本,图片进视觉通道", async () => {
    const dir = tempDir();
    const img = join(dir, "shot.png");
    writeFileSync(img, PNG_1PX);
    const txt = join(dir, "note.md");
    writeFileSync(txt, "# 备注\n内容");
    const { d, captured } = deps();
    await runSuperAgentTurn(d, "看看这两个附件", soul(), {
      attachments: [
        { name: "shot.png", path: img, mime: "image/png", size: PNG_1PX.length },
        { name: "note.md", path: txt, mime: "text/markdown" },
      ],
    });
    expect(captured.length).toBeGreaterThan(0);
    const u = captured[0]!;
    expect(u.content).toContain("## 附件");
    expect(u.content).toContain("shot.png");
    expect(u.content).toContain("note.md");
    expect(u.content).toContain("看看这两个附件");
    expect(u.images?.length).toBe(1);
  }, TIMEOUT);

  it("单张图片超 2MB:不进视觉通道,但块里写明未进原因", async () => {
    const dir = tempDir();
    const big = join(dir, "big.png");
    writeFileSync(big, Buffer.concat([PNG_1PX, Buffer.alloc(3 * 1024 * 1024, 7)]));
    const { d, captured } = deps();
    await runSuperAgentTurn(d, "看大图", soul(), { attachments: [{ name: "big.png", path: big, mime: "image/png" }] });
    const u = captured[0]!;
    expect(u.images).toBeUndefined();
    expect(u.content).toContain("## 附件");
    expect(u.content).toMatch(/超单张上限|未进视觉通道/);
  }, TIMEOUT);

  it("会话模型不支持视觉:图片不进通道,块内出现明确降级说明(不静默丢)", async () => {
    const dir = tempDir();
    const img = join(dir, "shot.png");
    writeFileSync(img, PNG_1PX);
    const base = deps();
    const d = base.d;
    const llmRef = (d as unknown as { llm: never }).llm;
    d.resolveTurnModel = () => ({ llm: llmRef as never, model: "text-only-model", vision: false });
    await runSuperAgentTurn(d, "这是截图", soul(), { attachments: [{ name: "shot.png", path: img, mime: "image/png" }] });
    const u = base.captured[0]!;
    expect(u.images).toBeUndefined();
    expect(u.content).toContain("视觉降级");
    expect(u.content).toContain("text-only-model");
    expect(u.content).toContain("shot.png");
  }, TIMEOUT);
});
