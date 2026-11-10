/**
 * 子代理能力取证脚本(交付一/三):真实起子代理跑一遍——脚本化 LLM 驱动
 * 真 LlmLoopBackend+AgentLoop+权限闸门,逐工具探针,工具结果/权限闸门事件经后端
 * onLoopEvent 通道取证(与生产环境 subagent.event 同源)=「真实运行日志显示可调/被拒」。
 * 常态=纯冒烟(不写文件,断言只锚定「探针链路活着」);设 GENIE_FORENSICS_OUT=<目录>
 * (或 GENIE_FORENSICS=1)时跑全角色矩阵并把报告(JSON+MD)落盘——
 * 证据进。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";
import { resolveSubagentCapability, buildSubagentExtraTools, renderSubagentSkillIndex } from "../src/agent-wiring.js";
import { loadAgentProfiles, expandToolTokens } from "@lampgenie/runtime/agent/agent-profiles";
import { ExperienceStore } from "@lampgenie/experience";
import type { PermissionRule } from "@lampgenie/core";

const OUT_DIR = process.env.GENIE_FORENSICS_OUT ?? "";

/** 探针工具全集:主 agent 全工具面 + 子代理候选面(逐个真实调用,记录可调/未知/被拒)。 */
const PROBE_TOOLS = [
  "read_file", "glob", "grep", "list_dir",
  "write_file", "edit_file", "run_cmd",
  "code_sense", "skill_view",
  "mcp__demo__lookup", "todo_write", "task_output",
];

interface ProbeRow { tool: string; verdict: string; detail: string }

/** 探针参数:每工具一个真实调用(有副作用的写到临时目录内)。 */
function argsOf(dir: string, name: string): Record<string, unknown> {
  switch (name) {
    case "read_file": return { path: join(dir, "sample.txt") };
    case "glob": return { pattern: "*.txt" };
    case "grep": return { pattern: "sample" };
    case "list_dir": return { path: dir };
    case "write_file": return { path: join(dir, "probe.txt"), content: "probe" };
    case "edit_file": return { path: join(dir, "sample.txt"), old_string: "sample", new_string: "probe" };
    case "run_cmd": return { command: "echo probe-ok" };
    case "code_sense": return { action: "entrypoints" };
    case "skill_view": return { category: "builtin", name: "nonexistent-probe" };
    case "mcp__demo__lookup": return { arguments: { q: "probe" } };
    case "todo_write": return { items: [] };
    case "task_output": return { agentId: "probe" };
    default: return {};
  }
}

/** 单探针真实子代理:脚本化 LLM 先发该工具调用再;取证=chat 收到的工具面+tool.result/permission.gate 事件。 */
async function probeOne(opts: {
  role: string;
  dir: string;
  tool: string;
  rules?: PermissionRule[];
  ask?: (tool: string, summary: string) => Promise<boolean>;
  whitelist?: string[];
  extraTools?: { name: string; execute: (a: unknown) => Promise<string> }[];
  skillIndexText?: string;
}) {
  const dir = opts.dir;
  const args = argsOf(dir, opts.tool);
  const seenTools: string[][] = [];
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  let step = 0;
  const llm = {
    async chat(_m: unknown, tools: { name: string }[]) {
      seenTools.push(tools.map((t) => t.name));
      step++;
      if (step === 1) return { content: "", toolCalls: [{ id: "x1", name: opts.tool, arguments: JSON.stringify(args) }] };
      return { content: "done 探针完成" };
    },
  } as never;
  const backend = new LlmLoopBackend({
    llm, roots: [dir], workdir: dir, role: opts.role, stallTimeoutMs: 30_000,
    ...(opts.rules ? { permissionRules: opts.rules } : {}),
    ...(opts.ask ? { onPermissionAsk: opts.ask } : {}),
    ...(opts.whitelist ? { toolWhitelist: opts.whitelist, extraTools: opts.extraTools as never } : {}),
    ...(opts.skillIndexText ? { skillIndexText: opts.skillIndexText } : {}),
    onLoopEvent: (e) => { events.push({ kind: e.kind, payload: e.payload }); },
  });
  let result: { ok: boolean; finalText?: string } | undefined;
  await backend.spawn(
    { taskId: "p1", instructions: "探针任务", workdir: dir, permissions: "sandbox", ...(opts.rules ? { permissionRules: opts.rules } : {}) },
    (e) => { if (e.type === "result") result = e.result as typeof result; },
  );
  for (let t = 0; t < 400 && !result; t++) await new Promise((r) => setTimeout(r, 50));
  if (!result) throw new Error("探针子代理 20s 未收敛(" + opts.role + "/" + opts.tool + ")");
  const offered = [...new Set(seenTools.flat())];
  const tr = events.find((e) => e.kind === "tool.result" && e.payload.name === opts.tool);
  const gate = events.find((e) => e.kind === "permission.gate");
  const content = String(tr?.payload.content ?? "");
  const verdict = !offered.includes(opts.tool) && !content
    ? "absent(未下发:模型调用被 loop 判未知工具)"
    : content.startsWith("错误:未知工具") ? "absent(未下发)"
    : content.includes("被权限规则拒绝") ? "denied(权限拒绝:" + String(gate?.payload.by ?? "?") + ")"
    : content.startsWith("错误:") ? "error(工具执行报错)"
    : "ok(可调)";
  return { offered, row: { tool: opts.tool, verdict, detail: content.replace(/\s+/g, " ").slice(0, 110) } as ProbeRow };
}

/** 全探针 × 一角色(每探针独立临时目录,probeRole 自建;装配走 wiring 同映射 resolveSubagentCapability)。 */
async function probeRole(opts: { role: string; rules?: PermissionRule[]; ask?: (t: string, s: string) => Promise<boolean>; tools?: string[]; profiles?: ReturnType<typeof loadAgentProfiles> }) {
  const names = opts.tools ?? PROBE_TOOLS;
  const offered = new Set<string>();
  const rows: ProbeRow[] = [];
  const cap = opts.profiles ? resolveSubagentCapability(opts.profiles, opts.role) : undefined;
  for (const tool of names) {
    const d = mkdtempSync(join(tmpdir(), "s61-"));
    writeFileSync(join(d, "sample.txt"), "sample line\n");
    const r = await probeOne({
      role: opts.role, dir: d, tool, rules: opts.rules, ask: opts.ask,
      ...(cap?.toolWhitelist ? {
        whitelist: cap.toolWhitelist,
        extraTools: buildSubagentExtraTools(d, [fakeMcp("mcp__demo__lookup")], new ExperienceStore(d)),
        ...(expandToolTokens(cap.toolWhitelist).includes("skill_view") ? { skillIndexText: renderSubagentSkillIndex(new ExperienceStore(d)) } : {}),
      } : {}),
    });
    for (const t of r.offered) offered.add(t);
    rows.push(r.row);
  }
  return { offered: [...offered], rows };
}

/** 假 MCP 工具(默认不下发/显式开启下发的取证探针)。 */
const fakeMcp = (name: string): { name: string; execute: (a: unknown) => Promise<string> } => ({
  name,
  execute: async () => "mcp-ok",
});

describe("子代理能力取证", () => {
  it("探针链路冒烟(worker 可调 read_file、explore 不下发 write_file)", async () => {
    const d = mkdtempSync(join(tmpdir(), "s61smoke-"));
    writeFileSync(join(d, "sample.txt"), "sample line\n");
    const w = await probeOne({ role: "worker", dir: d, tool: "read_file" });
    expect(w.row.verdict).toBe("ok(可调)");
    const d2 = mkdtempSync(join(tmpdir(), "s61smoke2-"));
    const e = await probeOne({ role: "explore", dir: d2, tool: "write_file" });
    expect(e.row.verdict).toBe("absent(未下发)");
  }, 30_000);

  it("全角色矩阵+权限档取证(GENIE_FORENSICS_OUT/GENIE_FORENSICS=1 触发,报告落盘)", async () => {
    if (!OUT_DIR && process.env.GENIE_FORENSICS !== "1") return;
    const profileRoot = mkdtempSync(join(tmpdir(), "s61p-"));
    mkdirSync(join(profileRoot, ".genie", "agents"), { recursive: true });
    writeFileSync(join(profileRoot, ".genie", "agents", "custom-writer.md"),
      "---\nname: custom-writer\ndescription: 自定义写手(声明 read+write+code_sense)\ntools: read, write, code_sense\n---\n自定义角色提示词。\n");
    writeFileSync(join(profileRoot, ".genie", "agents", "mcp-writer.md"),
      "---\nname: mcp-writer\ndescription: 显式开启 MCP 的自定义角色\ntools: read, mcp__demo\n---\n自定义角色提示词。\n");
    writeFileSync(join(profileRoot, ".genie", "agents", "strict-analyst.md"),
      "---\nname: strict-analyst\ndescription: deny-only 权限档自定义角色\ntools: read\npermission: deny-only\n---\n自定义角色提示词。\n");
    const profiles = loadAgentProfiles(profileRoot);
    const roles = ["worker", "general", "explore", "judge", "test-analyst", "custom-writer", "mcp-writer", "strict-analyst"];
    const matrix: Record<string, { declared: unknown; offered: string[]; rows: ProbeRow[] }> = {};
    for (const role of roles) {
      const prof = profiles.find((p) => p.name === role);
      const m = await probeRole({ role, profiles });
      matrix[role] = { declared: prof?.tools ?? [], offered: m.offered, rows: m.rows };
    }
 // 权限档(worker)。生产环境布线形态:permRules 在场时 wiring 恒挂 makeSubagentPermissionAsker
    // (agent-wiring),故除显式审批案例外统一挂 ask=async()=>false(无面板时应答=fail-closed),
 // 读类工具走 asker 链而非 loop 内部 ask-default——与生产环境一致。
    const permMatrix: Record<string, ProbeRow[]> = {};
    const failClosed = async () => false;
    const permCases: { label: string; rules?: PermissionRule[]; ask?: (t: string, s: string) => Promise<boolean> }[] = [
      { label: "无规则(不设闸,行为同旧版)" },
      { label: "deny write_file(父 deny 下传)+审批链 fail-closed", rules: [{ permission: "write_file", pattern: "*", action: "deny" }], ask: failClosed },
      { label: "allow file.write 类别(父面板 always-allow 形态)+审批链 fail-closed", rules: [{ permission: "file.write", pattern: "*", action: "allow" }], ask: failClosed },
      { label: "ask write_file+审批放行", rules: [{ permission: "write_file", pattern: "*", action: "ask" }], ask: async () => true },
      { label: "ask write_file+审批拒绝(fail-closed)", rules: [{ permission: "write_file", pattern: "*", action: "ask" }], ask: failClosed },
      { label: "deny run_cmd+审批链 fail-closed", rules: [{ permission: "run_cmd", pattern: "*", action: "deny" }], ask: failClosed },
      // 生产 asker(makeSubagentPermissionAsker)会先查 matchPermissionRule(rules,"subagent",summary)——
      // 本案例复刻该步(env/mode/broker 前置层跳过):面板「总是允许」写的 subagent[*]=allow 应放行子工具 ask。
      { label: "父规则=[subagent *:allow](C9 总是允许形态,asker 规则步放行)", rules: [{ permission: "subagent", pattern: "*", action: "allow" }],
        ask: async (_t, summary) => {
          const { matchPermissionRule } = await import("@lampgenie/core");
          return matchPermissionRule([{ permission: "subagent", pattern: "*", action: "allow" }], "subagent", summary)?.action === "allow";
        } },
    ];
    for (const c of permCases) {
      const r = await probeRole({ role: "worker", rules: c.rules, ask: c.ask, tools: ["read_file", "write_file", "edit_file", "run_cmd"] });
      permMatrix[c.label] = r.rows;
    }
    if (OUT_DIR) {
      mkdirSync(OUT_DIR, { recursive: true });
      const report = { generatedAt: new Date().toISOString(), probeTools: PROBE_TOOLS, matrix, permMatrix };
      writeFileSync(join(OUT_DIR, "capability-matrix.json"), JSON.stringify(report, null, 2), "utf-8");
      const lines = ["# 子代理能力矩阵(真实运行取证)", "", "生成:" + report.generatedAt + ";每个格子=一次真实子代理 spawn(脚本化 LLM 发起该工具调用),取证自 chat 工具面与 tool.result/permission.gate 事件。", ""];
      for (const [role, m] of Object.entries(matrix)) {
        lines.push(`## ${role}(profile.tools 声明=[${Array.isArray(m.declared) ? (m.declared as string[]).join(",") : ""}])`, "", "实际下发工具面:" + m.offered.sort().join(", "), "", "| 探针工具 | 判定 | 明细 |", "|---|---|---|");
        for (const row of m.rows) lines.push(`| ${row.tool} | ${row.verdict} | ${row.detail} |`);
        lines.push("");
      }
      lines.push("## 权限档(worker)", "");
      for (const [label, rows] of Object.entries(permMatrix)) {
        lines.push(`### ${label}`, "", "| 探针工具 | 判定 | 明细 |", "|---|---|---|");
        for (const row of rows) lines.push(`| ${row.tool} | ${row.verdict} | ${row.detail} |`);
        lines.push("");
      }
      writeFileSync(join(OUT_DIR, "capability-matrix.md"), lines.join("\n"), "utf-8");
    }
    expect(Object.keys(matrix)).toHaveLength(roles.length);
  }, 300_000);
});
