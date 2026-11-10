import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSoul, MemoryStore, rewriteImperativeToFact, buildSoulPreamble, DEFAULT_SOUL_MD } from "../src/agent/soul-memory.js";

const tmp = () => mkdtempSync(join(tmpdir(), "zh-soul-"));

describe("loadSoul(hermes 播种语义)", () => {
  it("首次创建播种默认", () => {
    const d = tmp();
    const r1 = loadSoul(d);
    expect(r1.seeded).toBe(true);
    expect(r1.content).toBe(DEFAULT_SOUL_MD);
    const r2 = loadSoul(d);
    expect(r2.seeded).toBe(true); // 内容仍等于模板 → 幂等升级(写同样字节),用户无感
    expect(r2.content).toBe(DEFAULT_SOUL_MD);
  });
  it("用户改过一个字 → 永不覆盖", () => {
    const d = tmp();
    loadSoul(d);
    const p = join(d, "SOUL.md");
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(p, DEFAULT_SOUL_MD + "\n用户加的一行", "utf-8");
    const r = loadSoul(d);
    expect(r.seeded).toBe(false);
    expect(r.content).toContain("用户加的一行");
  });
});

describe("MemoryStore 双库", () => {
  it("add/replace/remove + 去重 + § 分隔落盘", () => {
    const s = new MemoryStore(tmp());
    expect(s.add("user", "用户偏好简短回答").ok).toBe(true);
    expect(s.add("user", "用户偏好简短回答").ok).toBe(false); // 重复
    expect(s.add("memory", "项目用 pnpm").ok).toBe(true);
    expect(s.entries("user")).toEqual(["用户偏好简短回答"]);
    expect(s.replace("user", "简短回答", "用户偏好简短回答,中文").ok).toBe(true);
    expect(s.entries("user")).toEqual(["用户偏好简短回答,中文"]);
    expect(s.remove("user", "中文").ok).toBe(true);
    expect(s.entries("user")).toEqual([]);
  });
  it("预算:超限拒绝并给出占用;整条替换可腾位", () => {
    const s = new MemoryStore(tmp(), { userCharLimit: 30 });
    expect(s.add("user", "a".repeat(31)).ok).toBe(false);
    expect(s.add("user", "short-ok").ok).toBe(true);
    const r = s.add("user", "b".repeat(20));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("30");
  });
  it("渲染块:═ 边框 + 标题 + [pct%] + § join(hermes 格式)", () => {
    const s = new MemoryStore(tmp());
    s.add("memory", "项目用 pnpm");
    s.add("memory", "工具 X 有怪癖");
    const out = s.render("memory");
    expect(out.startsWith("═".repeat(46))).toBe(true);
    expect(out).toContain("MEMORY (环境笔记");
    expect(out).toMatch(/\[\d+% — \d+\/2200 chars\]/);
    expect(out).toContain("项目用 pnpm\n§\n工具 X 有怪癖");
  });
  it("renderAll: memory 块在前 user 块在后", () => {
    const s = new MemoryStore(tmp());
    s.add("memory", "m1");
    s.add("user", "u1");
    const all = s.renderAll();
    expect(all.indexOf("MEMORY")).toBeLessThan(all.indexOf("USER PROFILE"));
  });
});

describe("rewriteImperativeToFact(防漂移:祈使句→陈述句)", () => {
  it("常见祈使开头改写", () => {
    expect(rewriteImperativeToFact("总是用中文回答")).toBe("用户偏好用中文回答");
    expect(rewriteImperativeToFact("不要啰嗦")).toBe("用户不希望啰嗦");
    expect(rewriteImperativeToFact("请保持简短")).toBe("用户偏好保持简短");
  });
  it("已是陈述句不动", () => {
    expect(rewriteImperativeToFact("用户偏好简短回答")).toBe("用户偏好简短回答");
    expect(rewriteImperativeToFact("项目部署在 192.168.8.60")).toBe("项目部署在 192.168.8.60");
  });
});

describe("buildSoulPreamble", () => {
  it("SOUL 原文第 0 块 + memory 块拼接", () => {
    const d = tmp();
    const s = new MemoryStore(join(d, "memories"));
    s.add("user", "用户偏好简短回答");
    const out = buildSoulPreamble(d, s);
    expect(out.startsWith("你是 lampgenie-harness 的主 agent")).toBe(true);
    expect(out).toContain("USER PROFILE");
  });
});
