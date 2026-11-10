/**
 * step-131 总路线并入代码档案:WS 读/生成面实测。
 *
 * 断言链(全走真实链路,不 mock code-sense):
 *  ① 协议:profile.sense.get 合法(信封 v:1 强制)。
 *  ② manifest 缺席 → exists=false + 显式原因(不猜、不报错)。
 *  ③ generate=true → 确定性骨架落盘 .genie/sense-index/profile.json;purpose 取 README 首段
 *     (无 LLM 时 purposeSource=readme,llmState=off 如实标注,不冒充语义产物)。
 *  ④ 二次读回(不带 generate)→ exists=true 且 builtAt/stale/骨架事实齐。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClientMessage } from "@lampgenie/protocol";
import { startGatewayServer } from "../src/server.js";
import { profilePath } from "@lampgenie/code-sense/project-profile";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";
import { MemoryJournal } from "@lampgenie/core";

let closer: (() => Promise<void>) | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await closer?.();
  closer = null;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-roadmap-"));
  dirs.push(dir);
  writeFileSync(join(dir, "README.md"), [
    "# roadmap-demo",
    "",
    "A tiny toolkit that turns camera rosbags into training-ready frames.",
    "",
    "## Install",
    "npm i",
  ].join("\n"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "roadmap-demo", description: "Dataset toolkit", version: "0.1.0" }, null, 2));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.ts"), "export const main = 1;\n");
  return dir;
}

async function connect(port: number): Promise<{ ws: WebSocket; inbox: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Record<string, unknown>[] = [];
  ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
  await new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, inbox };
}

function waitFor(inbox: Record<string, unknown>[], type: string, after = 0, ms = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const hits = inbox.filter((m) => m.type === type);
      if (hits.length > after) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(hits[after]!);
      } else if (Date.now() - t0 > ms) {
        clearInterval(poll);
        clearTimeout(timer);
        reject(new Error(`等待 ${type} 超时(命中 ${hits.length})`));
      }
    }, 25);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`等待 ${type} 超时`));
    }, ms);
  });
}

describe("profile.sense.get(总路线并入代码档案,step-131)", () => {
  it("协议:合法消息过 / 缺信封拒", () => {
    expect(parseClientMessage('{"v":1,"type":"profile.sense.get"}')?.type).toBe("profile.sense.get");
    expect(parseClientMessage('{"v":1,"type":"profile.sense.get","projectId":"p1","generate":true}')?.type).toBe("profile.sense.get");
    expect(parseClientMessage('{"type":"profile.sense.get"}')).toBeNull();
  });

  it("缺席=显式 false → 生成落盘 → 读回宗旨与骨架事实", async () => {
    const root = fixture();
    const port = 7861;
    const projects = new ProjectRegistry(root, null);
    const srv = startGatewayServer({ port, taskManager: new TaskSupervisor(), journal: new MemoryJournal(), projects });
    closer = () => srv.close();
    const { ws, inbox } = await connect(port);

    // ① manifest 尚未生成:如实 false + 原因
    ws.send(JSON.stringify({ v: 1, type: "profile.sense.get" }));
    const absent = await waitFor(inbox, "profile.sense.result", 0);
    expect(absent.exists).toBe(false);
    expect(absent.root).toBe(root);
    expect(absent.generated).toBe(false);
    expect((absent.llmState as { status: string }).status).toBe("off");
    expect(String((absent.llmState as { reason?: string }).reason ?? "")).toContain("尚未生成");
    expect(existsSync(profilePath(root))).toBe(false);

    // ② 显式生成:确定性骨架落盘;purpose 来自 README 首段(无 LLM 不冒充 llm)
    ws.send(JSON.stringify({ v: 1, type: "profile.sense.get", generate: true }));
    const gen = await waitFor(inbox, "profile.sense.result", 1, 60_000);
    expect(gen.generated).toBe(true);
    expect(gen.exists).toBe(true);
    expect(existsSync(profilePath(root))).toBe(true);
    expect(gen.purposeSource).toBe("readme");
    expect(String(gen.purpose ?? "")).toContain("rosbags");
    expect((gen.capabilities as string[]).length).toBe(0); // 无 LLM=主线能力缺席,不补占位
    expect((gen.llmState as { status: string }).status).toBe("off");
    const sk = gen.skeleton as { techStack: { language: string }[]; topoNotes: string[] };
    expect(sk.techStack.some((t) => t.language === ".ts")).toBe(true);
    expect(sk.topoNotes.some((n) => n.startsWith("src/"))).toBe(true);

    // ③ 不带 generate 读回:仍是同一份画像(不重生成)
    ws.send(JSON.stringify({ v: 1, type: "profile.sense.get" }));
    const read = await waitFor(inbox, "profile.sense.result", 2);
    expect(read.exists).toBe(true);
    expect(read.generated).toBe(false);
    expect(read.builtAt).toBe(gen.builtAt);
    expect(String(read.purpose ?? "")).toContain("rosbags");

    ws.close();
  }, 90_000);
});