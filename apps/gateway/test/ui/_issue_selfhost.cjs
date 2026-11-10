/** fixD MVP 自启跑法:自起 7858 实例(临时 gitlab-remote 项目+假 token)+真实浏览器跑 issueboard.spec.cjs。
 * 场景:私有 gitlab URL 样本 + 假 token → 原生失败自动降级 RepoIssues → 新建 issue → 看板卡 → 拖拽落盘 → 刷新保持。
 * 用法:cd apps/gateway && npx tsx test/ui/_issue_selfhost.cjs   (SELF_PORT 可改,默认 7858;不碰产线 7700)
 * 清理纪律:临时项目/journal 随进程清;真实仓 .genie/{team/members.json,secrets.json} 恢复测试前原样。 */
// 新协议消息(issue.*)在 @lampgenie/protocol src;tsx 直跑解析到旧 dist 会判 invalid-message——
// 缺 development 条件时自重跑(与 vitest 的 NODE_OPTIONS=--conditions=development 同语义)。
if (!String(process.env.NODE_OPTIONS || "").includes("--conditions=development")) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("npx", ["tsx", __filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : "") + "--conditions=development" },
  });
  process.exit(r.status ?? 1);
}
process.env.GENIE_CHECKPOINT = "off";
process.env.GENIE_P2P_USER = process.env.GENIE_P2P_USER || "tester-a";
process.env.GENIE_GITLAB_TOKEN = "glpat-fake-token-for-degrade-test";
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PORT = Number(process.env.SELF_PORT || 7858);
const REPO_ROOT = resolve(__dirname, "../../..");
const SNAP = ["team/members.json", "secrets.json"].map((rel) => {
  const p = join(REPO_ROOT, ".genie", rel);
  return { p, rel, existed: existsSync(p), bytes: existsSync(p) ? readFileSync(p) : null };
});

(async () => {
  const jd = mkdtempSync(join(tmpdir(), "issjd-"));
  const proj = mkdtempSync(join(tmpdir(), "issproj-"));
  try {
    execFileSync("git", ["init", "-q", proj]);
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.localhost.invalid/acme/widgets.git"], { cwd: proj });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init", "-q"], { cwd: proj });
    const backend = { kind: "sbd-e2e", async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "echo:" + spec.instructions.slice(0, 20) } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    } };
    const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });
    const added = app.projects.add(proj);
    if (!added.ok) throw new Error("项目注册失败:" + added.reason);
    app.projects.activate(added.project.id);
    globalThis.__selfhostApp = app;
    globalThis.__issueProjectId = added.project.id;
    servePanel(PORT, (srv) => app.attachWs(srv));
    process.env.PANEL_BASE = "http://127.0.0.1:" + PORT;
    const t0 = Date.now();
    for (;;) {
      try { const r = await fetch(process.env.PANEL_BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
      if (Date.now() - t0 > 20000) throw new Error("self-host panel not ready on " + PORT);
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log("[issue-selfhost] panel on " + process.env.PANEL_BASE + " (project=" + added.project.id + ", journalDir=" + jd + ")");
    // spec 是 async IIFE:require 立即返回、spec 末尾 process.exit 收尾——finally 会先于 spec 跑完
    // (曾把临时项目目录提前删掉→resolveWorkdir 回退 harness 根→issue 落错仓)。清理必须挂
    // process.on("exit")(同步 rmSync,process.exit 也会执行),绝不提前。
    process.on("exit", () => {
      try {
        const listDir = (d) => (existsSync(d) ? require("node:fs").readdirSync(d).filter((f) => f.startsWith("ISSUE-")) : []);
        console.log("[issue-selfhost] issues-in-temp=" + listDir(join(proj, ".genie", "issues")) + " issues-in-harness=" + listDir(join(REPO_ROOT, ".genie", "issues")));
      } catch (e) { /* 诊断尽力 */ }
      try { rmSync(jd, { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
      try { rmSync(proj, { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
      for (const s of SNAP) {
        try {
          if (s.existed) writeFileSync(s.p, s.bytes);
          else if (existsSync(s.p)) rmSync(s.p, { force: true });
        } catch (e) { /* 恢复尽力 */ }
      }
      try { if (existsSync(join(REPO_ROOT, ".genie", "team"))) { const left = require("node:fs").readdirSync(join(REPO_ROOT, ".genie", "team")); if (!left.length) rmSync(join(REPO_ROOT, ".genie", "team"), { recursive: true, force: true }); } } catch (e) { /* 尽力 */ }
    });
    require(resolve(process.env.SPEC || join(__dirname, "issueboard.spec.cjs"))); // 进程内运行 spec(末尾 process.exit 收尾)
  } catch (e) {
    console.error("SELFHOST CRASH", e);
    process.exit(1);
  }
})().catch((e) => { console.error("SELFHOST CRASH", e); process.exit(1); });
