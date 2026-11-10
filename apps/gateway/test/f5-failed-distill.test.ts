/**
 * F5 失败轮沉淀:failed 终态→incidents candidate 经验条目(hermes 负面清单纪律:
 * 未验证尝试不进 active,只做 candidate 待确认)。
 */
import { describe, it, expect } from "vitest";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { wireExecutor } from "../src/executor-wiring.js";
import { ExperienceStore } from "@lampgenie/experience";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("F5 失败轮沉淀经验", () => {
  it("failed 任务→incidents candidate 落库(确定性兜底),正文含失败语境", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f5-"));
    const store = new ExperienceStore(join(dir, "exp"));
    const { distillFromTask } = await import("@lampgenie/experience");
    const name = "task-" + "f5probe01".slice(0, 8);
    // 轨迹须含错误模式(确定性兜底的提取闸):喂一条带 Error 的工具结果事件。
    const journal = new MemoryJournal();
    journal.append({ kind: "tool.result", sessionId: "s", payload: { content: "Error: docker daemon 未启动(exit 1)" } });
    const r = await distillFromTask(store, journal, {
      id: "f5probe01xx",
      sessionId: "s",
      instruction: "构建镜像发布",
      state: "failed",
      result: "Error: docker daemon 未启动",
    });
    expect(r.distilled).toBe(1);
    const fm = store.read("incidents", name);
    expect(fm).toBeTruthy();
    expect(fm?.status).toBe("candidate"); // hermes 纪律:未验证尝试只进 candidate 不进 active
    expect(store.readBody("incidents", name)).toContain("failed");
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  it("幂等:同任务二次失败提炼跳过(distilled=0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f5b-"));
    const store = new ExperienceStore(join(dir, "exp"));
    const { distillFromTask } = await import("@lampgenie/experience");
    const j = new MemoryJournal();
    j.append({ kind: "tool.result", sessionId: "s", payload: { content: "Error: boom(exit 1)" } });
    const task = { id: "abc12345xx", sessionId: "s", instruction: "x", state: "failed", result: "boom" };
    const r1 = await distillFromTask(store, j, task);
    const r2 = await distillFromTask(store, j, task);
    expect(r1.distilled).toBe(1);
    expect(r2.distilled).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  it("接线面:wireExecutor 失败终态触发提炼(真实仓经验库出现锚定条目,验证后清理)", async () => {
    const marker = "F5wireAnchor" + Date.now();
    const backend = {
      kind: "f5-e2e",
      async spawn(spec, onEvent) {
        onEvent({ type: "result", result: { ok: false, error: { kind: "test", detail: "Error: " + marker } } });
        return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
      },
    };
    const tm = new TaskSupervisor();
    const j = new MemoryJournal();
    wireExecutor(tm, j, backend);
    const t = tm.submit("user", "f5", marker);
    await new Promise((r) => setTimeout(r, 600));
    expect(tm.get(t.id)?.state).toBe("failed");
    // 提炼异步:轮询经验库(真实仓 .genie/experiences)
    const { repoRoot } = await import("../src/repo-root.js");
    const store = new ExperienceStore(join(repoRoot(), ".genie", "experiences"));
    const wantName = "task-" + t.id.slice(0, 8);
    let fm = null;
    for (let i = 0; i < 20 && !fm; i++) {
      await new Promise((r) => setTimeout(r, 200));
      fm = store.read("incidents", wantName);
    }
    expect(fm).toBeTruthy();
    expect(fm?.description).toContain(marker.slice(0, 20));
    // 清理:直接删条目目录(SKILL.md 所在),受控不留痕
    rmSync(store.dirOf("incidents", wantName), { recursive: true, force: true });
  }, 15_000);
});
