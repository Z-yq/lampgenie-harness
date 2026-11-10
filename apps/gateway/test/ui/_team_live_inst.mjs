/**
 * 团队页经验证实例( §3 验收 e2):**不改 7700、不重启网关**。
 * 关键点:7700 上跑的是旧 dist(团队仓 digest 还没有 roles/counts/memberRoles 字段),
 * 所以这里用**源码**起一套独立实例:
 *   真实团队仓(.genie/team/team-repo.git) → 新代码 TeamRelay(临时 workdir,只读轮询)
 *   → 新代码 TeamView(仓内身份) → 新 panel.ts 临时端口。
 * 团队页因此渲染真实虚拟组织数据(4 个 demo 成员 + 三角色 + 3 规则 3 技能 + demo-app 绑定)。
 * 用法:cd apps/gateway && SELF_PORT=7719 npx tsx test/ui/_team_live_inst.mjs
 * (必须 .mjs:src 里有 top-level await,.cjs 会被 tsx 转成 CJS 而报 ERR_REQUIRE_ASYNC_MODULE)
 */
process.env.GENIE_CHECKPOINT = "off";
const { createGatewayApp } = await import("../../src/app.ts");
const { servePanel } = await import("../../src/panel.ts");
const { TeamView } = await import("../../src/team-view.ts");
const { TeamRelay } = await import("../../../../packages/harness-runtime/src/team/team-relay.ts");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join, dirname } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SELF_PORT || 7719);
const relayPort = Number(process.env.TEAM_RELAY_PORT || 0);
const REPO = process.env.GENIE_REPO_ROOT || join(here, "../../../..");
const bare = join(REPO, ".genie", "team", "team-repo.git");
const IDENTITY = join(REPO, ".genie", "identity");
const jd = mkdtempSync(join(tmpdir(), "teamlive-"));

const backend = { kind: "team-live-e2e", async spawn(spec, onEvent) {
  onEvent({ type: "result", result: { ok: true, finalText: "ok" } });
  return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
} };
const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });

// 只读 relay:独立 workdir(不碰 7700 的 clone),轮询团队仓供 digest
async function freePort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const actualPort = relayPort || (await freePort());
const relay = new TeamRelay({
  port: actualPort,
  teamRepoUrl: bare,
  workdir: join(jd, "relay"),
  rosterPollMs: 5000,
  presenceBroadcastMs: 5000,
});
await relay.start();
console.log(`[team-live] relay on :${actualPort} bare=${bare}`);

const teamView = new TeamView({
  urls: [`ws://127.0.0.1:${actualPort}`],
  identityDir: IDENTITY,
  presenceFacts: () => ({ lastInputAt: Date.now(), runningSessions: 0, pendingAsks: 0, dnd: false }),
  log: (l) => console.log("[team-live] " + l),
});
globalThis.__teamView = teamView;

servePanel(PORT, (srv) => app.attachWs(srv));
console.log(`READY port=${PORT} relayPort=${actualPort} repo=${REPO}`);

const t0 = Date.now();
for (;;) {
  const d = teamView.teamaiDigest();
  if (d && d.roles) {
    console.log("[team-live] digest ready: roles=" + ((d.roles || []).length) + " memberRoles=" + JSON.stringify(d.memberRoles || {}) + " counts=" + JSON.stringify(d.counts || {}));
    break;
  }
  if (Date.now() - t0 > 30000) { console.log("[team-live] WARN digest 30s 未到"); break; }
  await new Promise((r) => setTimeout(r, 500));
}

process.on("SIGINT", () => { try { teamView.stop(); } catch { /* noop */ } void relay.close(); process.exit(0); });
setInterval(() => {}, 10000);
