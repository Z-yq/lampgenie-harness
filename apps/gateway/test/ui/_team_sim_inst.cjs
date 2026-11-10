/**
 * 团队模拟成员实例(team-sim):由 _team_sim_mainlink.cjs spawn。
 * 隔离纪律:
 *  - 端口只由 SELF_PORT 注入(绝不 cfg.set gateway.port / 绝不碰 7700);
 *  - journal 只由 GENIE_JOURNAL_DIR 注入(实例间互不共享事实源);
 *  - 身份/成员目录/密钥全部落在 GENIE_REPO_ROOT 指定的临时根(不碰真实仓 .genie,
 *    避免与 7700 上在跑的任务争用 secrets.json)。
 * relay 桩:TEAM_SIM_RELAY=1 时给 globalThis.__teamView 挂一个假 org(ready 由
 * $GENIE_JOURNAL_DIR/relay-on.flag 是否存在决定),用来验证 app.ts 里真实的 relaySend
 * 兜底分支(relay 在=via relay;relay 拔掉=via queued)。
 */
process.env.GENIE_CHECKPOINT = "off";
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { appendFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const PORT = Number(process.env.SELF_PORT);
const PROJ = process.env.TEAM_SIM_PROJ;
const JD = process.env.GENIE_JOURNAL_DIR;
const RELAY_FLAG = join(JD, "relay-on.flag");
const RELAY_LOG = join(JD, "relay-pushes.jsonl");

(async () => {
  if (process.env.TEAM_SIM_RELAY === "1") {
    // 只读桩:与方法签名面一致(ready 是 getter,wsSend 记录)。真实实现见 team-view.ts。
    const org = {
      get client() {
        return {
          get ready() { return existsSync(RELAY_FLAG); },
          wsSend: (m) => { try { appendFileSync(RELAY_LOG, JSON.stringify(m) + "\n"); } catch { /* 尽力 */ } },
        };
      },
    };
    globalThis.__teamView = { orgs: new Map([["sim-relay://local", org]]), snapshot: () => ({ orgs: [] }), teamaiDigest: () => null };
  }

  // 执行器:echo 形(立即终态)——验证「派发→终态回写」全链而不起真 LLM。
  const backend = { kind: "team-sim-echo", async spawn(spec, onEvent) {
    onEvent({ type: "result", result: { ok: true, finalText: "团队模拟完成:" + spec.instructions.slice(0, 24) } });
    return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
  } };

  const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: JD });
  const added = app.projects.add(PROJ);
  if (!added.ok) { console.error("TEAM-SIM-INST FAIL " + added.reason); process.exit(1); }
  app.projects.activate(added.project.id);
  servePanel(PORT, (srv) => app.attachWs(srv));
  console.log("READY port=" + PORT + " user=" + process.env.GENIE_P2P_USER + " project=" + added.project.id + " journal=" + JD);
  setInterval(() => {}, 10000);
})().catch((e) => { console.error("TEAM-SIM INST CRASH", e); process.exit(1); });