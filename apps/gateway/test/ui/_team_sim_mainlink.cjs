/**
 * 团队功能多成员端到端模拟(team-sim harness)。
 * 目的:用两个真实隔离实例(不是单测桩)验证 P2P 通道 + issue 双通道 + 看板全链,
 * 每类断言都拿三类证据:WS/REST 回包、journal 事件、磁盘文件。
 * 隔离纪律(硬约束):
 *  - 端口只走 SELF_PORT → 7781/7782;绝不 cfg.set gateway.port、绝不碰 7700;
 *  - GENIE_JOURNAL_DIR=/tmp/team-sim-A|B(实例事实源互不共享);
 *  - GENIE_REPO_ROOT=/tmp/team-sim/members(成员目录/密钥/issue 文件的共享根,
 *    不碰真实仓 .genie —— 7700 上的任务正在用);
 *  - 收尾按落盘 PID 杀进程组 + 删 /tmp 临时目录。
 * 签名测试:harness 直接从共享成员根读成员的 ed25519 私钥自行签名,用来模拟
 * 「对端时钟偏移」「同 id 重发」「篡改 body」三类恶意/异常输入(这是真实对端能做的事)。
 * 跑法:cd apps/gateway && npx tsx test/ui/_team_sim_mainlink.cjs
 */
if (!String(process.env.NODE_OPTIONS || "").includes("--conditions=development")) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("npx", ["tsx", __filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : "") + "--conditions=development" },
  });
  process.exit(r.status ?? 1);
}

const { spawn, execFileSync, execSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const crypto = require("node:crypto");
const WebSocket = require("ws");

const SIM = "/tmp/team-sim";
const MEMBER_ROOT = join(SIM, "members");
const PROJ = join(SIM, "proj");
const JD = { A: "/tmp/team-sim-A", B: "/tmp/team-sim-B" };
const PORTS = { A: 7781, B: 7782 };
const RELAY_FLAG = join(JD.A, "relay-on.flag");
const RELAY_LOG = join(JD.A, "relay-pushes.jsonl");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsClient(port) {
  const handlers = new Set();
  const ws = new WebSocket("ws://127.0.0.1:" + port);
  const obj = {
    ws,
    onType: (fn) => { handlers.add(fn); return () => handlers.delete(fn); },
    request: (msg, want, timeoutMs = 20000) =>
      new Promise((resolveP, rejectP) => {
        const off = obj.onType((m) => { if (m.type === want) { off(); clearTimeout(t); resolveP(m); } });
        const t = setTimeout(() => { off(); rejectP(new Error("timeout 等 " + want)); }, timeoutMs);
        ws.send(JSON.stringify(msg));
      }),
  };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    for (const h of [...handlers]) { try { h(m); } catch { /* 监听者异常不拦 */ } }
  });
  return new Promise((res, rej) => { ws.on("open", () => res(obj)); ws.on("error", rej); });
}

function journalEvents(which) {
  const f = join(JD[which], "gateway.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
function journalOf(which, ns, kind) {
  return journalEvents(which).filter((e) => e.payload && e.payload.ns === ns && (kind === undefined || e.payload.kind === kind));
}

/** 用共享成员根里的成员私钥自行签名(模拟真实对端;支持时钟偏移/篡改 body)。 */
function signFor(user, body, opts = {}) {
  const secrets = JSON.parse(readFileSync(join(MEMBER_ROOT, ".genie", "secrets.json"), "utf-8"));
  const priv = secrets["p2pKey." + user];
  const pub = secrets["p2pKey." + user + ".pub"];
  if (!priv || !pub) throw new Error("成员私钥缺失:" + user + "(keys=" + Object.keys(secrets).join(",") + ")");
  const ts = String(Date.now() + (opts.skewMs || 0));
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const sig = crypto.sign(null, Buffer.from(`${ts}:${user}:${hash}`, "utf-8"), priv).toString("base64");
  return {
    "content-type": "application/json",
    "x-genie-user": opts.asUser || user,
    "x-genie-ts": ts,
    "x-genie-key": Buffer.from(pub, "utf-8").toString("base64"),
    "x-genie-sig": opts.tamperSig ? sig.slice(0, -8) + "AAAAAAAA" : sig,
  };
}

(async () => {
  rmSync(SIM, { recursive: true, force: true });
  rmSync(JD.A, { recursive: true, force: true });
  rmSync(JD.B, { recursive: true, force: true });
  for (const d of [SIM, MEMBER_ROOT, PROJ, JD.A, JD.B]) mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q", PROJ]);
  // 私有 gitlab 域 + 多级子组路径(同时覆盖「原生判定→失败→降级」与「fullPath 编码」两件事)。
  execFileSync("git", ["remote", "add", "origin", "https://gitlab.team-sim.invalid/平台/工具/team-tool.git"], { cwd: PROJ });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init", "-q"], { cwd: PROJ });

  const children = {};
  const spawnInst = (who) => {
    const child = spawn("npx", ["tsx", join(__dirname, "_team_sim_inst.cjs")], {
      env: {
        ...process.env,
        SELF_PORT: String(PORTS[who]),
        GENIE_JOURNAL_DIR: JD[who],
        GENIE_REPO_ROOT: MEMBER_ROOT,
        GENIE_P2P_USER: "member-" + who.toLowerCase(),
        GENIE_P2P_HOST: "127.0.0.1",
        GENIE_GITLAB_TOKEN: "fake-token-for-degrade", // 假 token:原生通道首调必失败 → 自动降级
        TEAM_SIM_PROJ: PROJ,
        TEAM_SIM_RELAY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.on("data", (d) => { if (String(d).includes("READY")) child.emit("ready"); });
    child.stderr.on("data", (d) => process.stderr.write("[sim" + PORTS[who] + " err] " + String(d).slice(0, 400)));
    writeFileSync(join(SIM, "pid-" + who), String(child.pid));
    children[who] = child;
    return child;
  };
  const killGroup = (who) => {
    const child = children[who];
    if (!child) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退 */ }
    try { child.kill("SIGKILL"); } catch { /* 已退 */ }
    delete children[who];
  };
  const waitReady = (child, who, ms = 45000) =>
    new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(who + " 未在 " + ms + "ms 内 READY")), ms);
      child.once("ready", () => { clearTimeout(t); res(); });
    });

  let A, B;
  try {
    // ============================================================
    // 0. 两个隔离实例(7781/7782,各自 journal,共享成员根)
    // ============================================================
    const ca = spawnInst("A");
    await waitReady(ca, "A");
    await sleep(1500); // 共享 members.json 的 upsertSelf 读改写错峰
    const cb = spawnInst("B");
    await waitReady(cb, "B");
    await sleep(1200);

    A = await wsClient(PORTS.A);
    B = await wsClient(PORTS.B);
    const [httpA, httpB] = await Promise.all([
      fetch("http://127.0.0.1:" + PORTS.A + "/"),
      fetch("http://127.0.0.1:" + PORTS.B + "/"),
    ]);
    check("两实例就绪(7781/7782 面板 HTTP 均 200)", httpA.status === 200 && httpB.status === 200, httpA.status + "/" + httpB.status);

    // ============================================================
    // 1. P2P 双向可达:签名 ping(status 前探测)/ presence / message / inbox
    // ============================================================
    const stA = await A.request({ v: 1, type: "team.p2p.status" }, "team.p2p.status.result", 25000);
    const stB = await B.request({ v: 1, type: "team.p2p.status" }, "team.p2p.status.result", 25000);
    const aSeesB = (stA.status.members || []).find((m) => m.username === "member-b");
    const bSeesA = (stB.status.members || []).find((m) => m.username === "member-a");
    check("P2P 双向可达(签名 ping 双端 online)", !!aSeesB && aSeesB.state === "online" && !!bSeesA && bSeesA.state === "online",
      JSON.stringify({ A看B: aSeesB && [aSeesB.state, aSeesB.port, aSeesB.via], B看A: bSeesA && [bSeesA.state, bSeesA.port, bSeesA.via] }));
    check("成员目录共享(两端都看到两成员)", (stA.status.members || []).length === 2 && (stB.status.members || []).length === 2,
      "A=" + (stA.status.members || []).map((m) => m.username).join(",") + " B=" + (stB.status.members || []).map((m) => m.username).join(","));

    // presence:签名请求走通 + 未签名被拒
    const presBody = JSON.stringify({});
    const presOk = await fetch("http://127.0.0.1:" + PORTS.B + "/team/p2p/presence", { method: "POST", body: presBody, headers: signFor("member-a", presBody) });
    const presData = await presOk.json();
    check("签名 presence 可达(返回 B 视角成员表)", presOk.status === 200 && Array.isArray(presData.members) && presData.members.length === 2,
      presOk.status + " " + JSON.stringify(presData).slice(0, 120));
    const presNo = await fetch("http://127.0.0.1:" + PORTS.B + "/team/p2p/presence", { method: "POST", body: presBody, headers: { "content-type": "application/json" } });
    check("未签名 presence 被拒(403 + 原因)", presNo.status === 403, "status=" + presNo.status);

    // A → B 直连消息(同时验证本轮新增的「入站实时推送」:B 客户端不经任何 request 就收到 WS 帧)
    const liveFrames = [];
    const offLive = B.onType((m) => { if (m.type === "team.p2p.message") liveFrames.push(m); });
    const send1 = await A.request({ v: 1, type: "team.p2p.send", to: "member-b", text: "模拟消息-1" }, "team.p2p.message.result", 20000);
    check("A→B 直连投递(via=p2p)", send1.via === "p2p", JSON.stringify(send1));
    for (let i = 0; i < 20 && !liveFrames.length; i++) await sleep(200);
    check("入站消息实时推送(B 未轮询即收到 team.p2p.message 帧)",
      liveFrames.length >= 1 && String((liveFrames[0].message || {}).text || "") === "模拟消息-1",
      JSON.stringify((liveFrames[0] || {}).message || {}).slice(0, 130));
    check("实时帧字段完整(from/to/text/via,非重复)",
      !!liveFrames[0] && liveFrames[0].message.from === "member-a" && liveFrames[0].message.to === "member-b" &&
        liveFrames[0].message.via === "p2p" && liveFrames[0].message.duplicate !== true,
      JSON.stringify((liveFrames[0] || {}).message || {}).slice(0, 130));
    offLive();
    const stB2 = await B.request({ v: 1, type: "team.p2p.status" }, "team.p2p.status.result", 20000);
    check("B 收到消息(status.lastInbound 反映)", !!stB2.status.lastInbound && stB2.status.lastInbound.text === "模拟消息-1",
      JSON.stringify(stB2.status.lastInbound || {}).slice(0, 110));
    const bIn = journalOf("B", "team.p2p", "message");
    check("B journal 有入站消息事件(ns=team.p2p)", bIn.length >= 1, "count=" + bIn.length + " " + JSON.stringify((bIn[0] || {}).payload || {}).slice(0, 120));

    // B → A 反向
    const send2 = await B.request({ v: 1, type: "team.p2p.send", to: "member-a", text: "模拟消息-2" }, "team.p2p.message.result", 20000);
    const aIn = journalOf("A", "team.p2p", "message");
    check("B→A 反向直连可达(双向)", send2.via === "p2p" && aIn.some((e) => e.payload.text === "模拟消息-2"),
      JSON.stringify(send2) + " A journal 入站=" + aIn.length);

    // 事实源隔离(此刻两端都有事件了才断言,否则「文件尚未创建」会被误判):
    // 各自 journal 目录各有文件,且 B 的 journal 里不含 A 的本地入站消息(互不串账)。
    const evA = journalEvents("A");
    const evB = journalEvents("B");
    check("事实源隔离(各写各的 journal,内容不串)",
      evA.length > 0 && evB.length > 0 &&
        evB.some((e) => e.payload && e.payload.text === "模拟消息-1") &&
        !evB.some((e) => e.payload && e.payload.text === "模拟消息-2"),
      "journalA=" + evA.length + " journalB=" + evB.length);

    // inbox:签名向 B 拉取「发给 A 的」消息(消息存 B 侧,收件人=member-a 的槽位)
    const inboxBody = JSON.stringify({});
    const inboxRes = await fetch("http://127.0.0.1:" + PORTS.B + "/team/p2p/inbox", { method: "POST", body: inboxBody, headers: signFor("member-a", inboxBody) });
    const inboxData = await inboxRes.json();
    check("签名 inbox 可拉取本人槽位(未见跨成员越权)", inboxRes.status === 200 && Array.isArray(inboxData.messages),
      "status=" + inboxRes.status + " n=" + ((inboxData.messages || []).length));
    const inboxNo = await fetch("http://127.0.0.1:" + PORTS.B + "/team/p2p/inbox", { method: "POST", body: inboxBody, headers: { "content-type": "application/json" } });
    check("未签名 inbox 被拒(403)", inboxNo.status === 403, "status=" + inboxNo.status);

    // ============================================================
    // 2. 失败面:篡改 body / 未知成员 / 过期时间戳 / 重复消息(全部可观测)
    // ============================================================
    const rejectCountBefore = journalOf("B", "team.p2p", "rejected").length;

    // (a) 篡改 body(签名对 bodyA,实际发 bodyB)→ 签名验证失败
    const bodyReal = JSON.stringify({ id: "tamper-1", to: "member-b", text: "正经正文" });
    const tamperHdr = signFor("member-a", bodyReal);
    const tampered = JSON.stringify({ id: "tamper-1", to: "member-b", text: "被篡改正文" });
    const rTamper = await fetch("http://127.0.0.1:" + PORTS.B + "/team/p2p/message", { method: "POST", body: tampered, headers: tamperHdr });
    const jTamper = await rTamper.json();
    check("篡改 body → 403 签名验证失败", rTamper.status === 403 && String(jTamper.reason).includes("签名"), JSON.stringify(jTamper).slice(0, 90));

    // (b) 未知成员
    const unkBody = JSON.stringify({ id: "unk-1", to: "member-b", text: "x" });
    const rUnk = await fetch("http://127.0.0.1:" + PORTS.B + "/team/p2p/message", { method: "POST", body: unkBody, headers: signFor("member-a", unkBody, { asUser: "eve" }) });
    const jUnk = await rUnk.json();
    check("未知成员 → 403 成员不在目录", rUnk.status === 403 && String(jUnk.reason).includes("目录"), JSON.stringify(jUnk).slice(0, 90));

    // (c) 过期时间戳(对端时钟偏移 -900s;真签名 → 走到时间戳窗口判定)
    const staleBody = JSON.stringify({ id: "stale-1", to: "member-b", text: "迟到的消息" });
    const rStale = await fetch("http://127.0.0.1:" + PORTS.B + "/team/p2p/message", { method: "POST", body: staleBody, headers: signFor("member-a", staleBody, { skewMs: -900_000 }) });
    const jStale = await rStale.json();
    check("过期时间戳(±300s 窗)→ 403 时间戳超窗", rStale.status === 403 && String(jStale.reason).includes("时间戳"), JSON.stringify(jStale).slice(0, 90));

    await sleep(500);
    const rejAll = journalOf("B", "team.p2p", "rejected");
    const reasons = rejAll.map((e) => String(e.payload.reason));
    check("三类拒绝全部进 B journal(可观测,带原因)",
      rejAll.length - rejectCountBefore >= 3 && reasons.some((r) => r.includes("签名")) && reasons.some((r) => r.includes("目录")) && reasons.some((r) => r.includes("时间戳")),
      "新增=" + (rejAll.length - rejectCountBefore) + " reasons=" + JSON.stringify(reasons.slice(-3)));

    // (d) 重复消息:同一 id 真签名连发两次 → 第二次回 duplicate:true 且 inbox 不增
    const inboxBefore = (await B.request({ v: 1, type: "team.p2p.status" }, "team.p2p.status.result", 20000)).status.inbox;
    const dupBody = JSON.stringify({ id: "dup-fixed-1", to: "member-b", text: "重复投递" });
    // 实时帧也要覆盖重复路径:面板据此提示「重复消息已吸收」。
    const dupFrames = [];
    const offDup = B.onType((m) => { if (m.type === "team.p2p.message") dupFrames.push(m); });
    const r1 = await fetch("http://127.0.0.1:" + PORTS.B + "/team/p2p/message", { method: "POST", body: dupBody, headers: signFor("member-a", dupBody) });
    const j1 = await r1.json();
    const r2 = await fetch("http://127.0.0.1:" + PORTS.B + "/team/p2p/message", { method: "POST", body: dupBody, headers: signFor("member-a", dupBody) });
    const j2 = await r2.json();
    for (let i = 0; i < 15 && dupFrames.length < 2; i++) await sleep(200);
    offDup();
    await sleep(400);
    const inboxAfter = (await B.request({ v: 1, type: "team.p2p.status" }, "team.p2p.status.result", 20000)).status.inbox;
    check("同 id 首发正常(200,非 duplicate)", r1.status === 200 && j1.duplicate !== true, JSON.stringify(j1).slice(0, 80));
    check("同 id 重发被吸收(duplicate:true + inbox 不增)", r2.status === 200 && j2.duplicate === true && inboxAfter === inboxBefore + 1,
      JSON.stringify(j2) + " inbox " + inboxBefore + "→" + inboxAfter);
    check("重复投递也推实时帧且标 duplicate(面板可提示已吸收)",
      dupFrames.length >= 2 && dupFrames.some((f) => f.message && f.message.duplicate === true),
      "帧数=" + dupFrames.length + " flags=" + JSON.stringify(dupFrames.map((f) => !!(f.message || {}).duplicate)));
    const dupJ = journalOf("B", "team.p2p", "message").filter((e) => e.payload.duplicate === true);
    check("重复消息进 journal 且标注 duplicate", dupJ.length >= 1, "count=" + dupJ.length);

    // ============================================================
    // 3. 断链降级:停 B → relay 兜底 → 拔 relay → 队列 → B 回来自动补发
    // ============================================================
    writeFileSync(RELAY_FLAG, "on"); // relay 桩就绪
    const pidB = Number(readFileSync(join(SIM, "pid-B"), "utf-8").trim());
    killGroup("B");
    for (let i = 0; i < 40; i++) {
      try { process.kill(pidB, 0); await sleep(200); } catch { break; }
    }
    await sleep(1000);

    const toRelay = await A.request({ v: 1, type: "team.p2p.send", to: "member-b", text: "B停机-relay兜底" }, "team.p2p.message.result", 20000);
    check("B 停机 → relay 兜底(via=relay)", toRelay.via === "relay", JSON.stringify(toRelay));
    await sleep(400);
    const relayPushes = existsSync(RELAY_LOG) ? readFileSync(RELAY_LOG, "utf-8").trim().split("\n").filter(Boolean) : [];
    check("relay 中转确有推送(桩日志)", relayPushes.length >= 1 && relayPushes.some((l) => l.includes("relay.activity.push")), (relayPushes[0] || "").slice(0, 130));
    const fbEvents = journalOf("A", "team.p2p", "fallback");
    check("降级标注进 A journal(via=relay + 原因)", fbEvents.some((e) => e.payload.via === "relay" && String(e.payload.reason || "").length > 0),
      JSON.stringify((fbEvents[fbEvents.length - 1] || {}).payload || {}).slice(0, 130));

    rmSync(RELAY_FLAG, { force: true }); // relay 也缺席
    const toQueue = await A.request({ v: 1, type: "team.p2p.send", to: "member-b", text: "B停机-relay也停" }, "team.p2p.message.result", 20000);
    check("B 停机 + relay 缺席 → 离线队列(via=queued)", toQueue.via === "queued", JSON.stringify(toQueue));
    const stA2 = await A.request({ v: 1, type: "team.p2p.status" }, "team.p2p.status.result", 25000);
    const queuedItem = (stA2.status.offlineQueueItems || []).find((x) => x.text.includes("relay也停"));
    check("队列明细可取证(status.offlineQueueItems)", !!queuedItem && stA2.status.offlineQueue >= 1,
      "queue=" + stA2.status.offlineQueue + " items=" + JSON.stringify((stA2.status.offlineQueueItems || []).slice(-2)));

    // B 重新上线 → 冷却后重探转 online → 自动补发
    const cb2 = spawnInst("B");
    await waitReady(cb2, "B");
    await sleep(1500);
    let flushed = false;
    for (let i = 0; i < 14; i++) {
      await A.request({ v: 1, type: "team.p2p.status" }, "team.p2p.status.result", 25000);
      if (journalOf("B", "team.p2p", "message").some((e) => String(e.payload.text || "").includes("relay也停"))) { flushed = true; break; }
      await sleep(2500);
    }
    check("对端恢复在线 → 离线队列自动补发(消息实投到对端 journal)", flushed,
      "B 入站消息=" + journalOf("B", "team.p2p", "message").length);
    const stA3 = await A.request({ v: 1, type: "team.p2p.status" }, "team.p2p.status.result", 25000);
    check("补发后队列水位归零", stA3.status.offlineQueue === 0, "queue=" + stA3.status.offlineQueue);

    B = await wsClient(PORTS.B);

    // ============================================================
    // 4. issue 全链:创建 → 确认派发 → 双通道 → 终态回写 → 拖拽看板
    // ============================================================
    const projA = ((await A.request({ v: 1, type: "project.list" }, "project.list.result")).projects || [])[0];
    const list1 = await A.request({ v: 1, type: "issue.list", projectId: projA.id }, "issue.list.result", 25000);
    check("issue 通道自动降级(mode=repo + 降级原因可读)", list1.channel.mode === "repo" && String(list1.channel.degradedReason || "").length > 0,
      JSON.stringify(list1.channel).slice(0, 150));
    check("托管甄别到私有 gitlab + 多级命名空间(repo 末两段/fullPath 完整)",
      String(list1.channel.host || "").includes("team-sim.invalid") && String(list1.channel.repo) === "工具/team-tool",
      JSON.stringify(list1.channel).slice(0, 150));

    const created = await A.request({ v: 1, type: "issue.create", projectId: projA.id, title: "团队模拟:修登录闪退", body: "iOS18 冷启动必现", assignee: "member-a" }, "issue.list.result", 25000);
    const issue = (created.issues || []).find((x) => x.title === "团队模拟:修登录闪退");
    check("创建 issue(number 分配 + 列表回包)", !!issue && issue.number >= 1, JSON.stringify(issue || {}).slice(0, 110));
    const issueFile = join(PROJ, ".genie", "issues", "ISSUE-" + (issue ? issue.number : 0) + ".json");
    check("证据①看板文件落盘(.genie/issues/ISSUE-n.json)", existsSync(issueFile), issueFile);
    check("证据②A journal 记 issue 创建", journalOf("A", "team.issue", "create").some((e) => e.payload.number === issue.number),
      "count=" + journalOf("A", "team.issue").length);

    const projB = ((await B.request({ v: 1, type: "project.list" }, "project.list.result")).projects || [])[0];
    const listB = await B.request({ v: 1, type: "issue.list", projectId: projB.id }, "issue.list.result", 25000);
    check("另一成员实例 B 看板可见(共享文件通道)", (listB.issues || []).some((x) => x.number === issue.number),
      "B 看到 " + (listB.issues || []).length + " 条");

    const disp = await A.request({ v: 1, type: "issue.confirm.dispatch", projectId: projA.id, number: issue.number }, "issue.dispatch.result", 25000);
    check("确认后派发成功(taskId 回关联)", disp.ok === true && !!disp.taskId, JSON.stringify(disp).slice(0, 110));
    let doneIssue = null;
    for (let i = 0; i < 30 && !doneIssue; i++) {
      await sleep(600);
      const l = await A.request({ v: 1, type: "issue.list", projectId: projA.id }, "issue.list.result", 25000);
      doneIssue = (l.issues || []).find((x) => x.number === issue.number && x.status === "done" && (x.comments || []).length > 0) || null;
    }
    check("终态自动回写(status=done + 评论摘要)", !!doneIssue, doneIssue ? String((doneIssue.comments || [])[0].body).slice(0, 70) : "30 轮内未见");
    const diskAfter = JSON.parse(readFileSync(issueFile, "utf-8"));
    check("证据③回写落盘(taskId + done + 评论)", diskAfter.status === "done" && !!diskAfter.taskId && diskAfter.comments.length >= 1,
      JSON.stringify({ status: diskAfter.status, taskId: String(diskAfter.taskId || "").slice(0, 8), comments: diskAfter.comments.length }));
    check("A journal 记回写事件(update/comment)", journalOf("A", "team.issue").some((e) => e.payload.number === issue.number && (e.payload.kind === "update" || e.payload.kind === "comment")),
      "该 issue 事件数=" + journalOf("A", "team.issue").filter((e) => e.payload.number === issue.number).length);

    const disp2 = await A.request({ v: 1, type: "issue.confirm.dispatch", projectId: projA.id, number: issue.number }, "issue.dispatch.result", 25000);
    check("已派发 issue 再派被拒(幂等保护)", disp2.ok === false && String(disp2.reason || "").includes("已派发"), JSON.stringify(disp2).slice(0, 100));

    // 拖拽看板状态变更(面板 drop → issue.update)
    const created2 = await A.request({ v: 1, type: "issue.create", projectId: projA.id, title: "拖拽测试卡", body: "todo→doing", assignee: "member-b" }, "issue.list.result", 25000);
    const card2 = (created2.issues || []).find((x) => x.title === "拖拽测试卡");
    let sawChanged = null;
    const offChanged = A.onType((m) => { if (m.type === "issue.changed" && m.number === card2.number) sawChanged = m; });
    A.ws.send(JSON.stringify({ v: 1, type: "issue.update", projectId: projA.id, number: card2.number, status: "doing" }));
    let movedDisk = null;
    for (let i = 0; i < 25; i++) {
      await sleep(400);
      movedDisk = JSON.parse(readFileSync(join(PROJ, ".genie", "issues", "ISSUE-" + card2.number + ".json"), "utf-8"));
      if (movedDisk.status === "doing") break;
    }
    offChanged();
    check("拖拽写回通道(status todo→doing 落盘)", movedDisk.status === "doing", "status=" + movedDisk.status);
    check("拖拽触发 issue.changed 广播(action=update)", !!sawChanged && sawChanged.action === "update", JSON.stringify(sawChanged || {}).slice(0, 100));
    const listB2 = await B.request({ v: 1, type: "issue.list", projectId: projB.id }, "issue.list.result", 25000);
    check("另一成员 B 看到拖拽后状态(跨实例共享)", (listB2.issues || []).some((x) => x.number === card2.number && x.status === "doing"));

    // 原子写证据:多轮 update/comment 之后,目录里只有正式文件,没有 .tmp-* 临时残留。
    const issueDir = join(PROJ, ".genie", "issues");
    const dirFiles = readdirSync(issueDir);
    const tmpLeft = dirFiles.filter((f) => f.includes(".tmp-"));
    check("issue 目录无 .tmp 临时文件残留(原子写)", tmpLeft.length === 0, "文件=" + JSON.stringify(dirFiles) + " 残留=" + JSON.stringify(tmpLeft));

    // ============================================================
    // 5. 汇总
    // ============================================================
    const failed = results.filter((r) => !r.ok).length;
    console.log("SUMMARY team-sim " + (results.length - failed) + "/" + results.length + (failed ? " FAILED" : " ALL-PASS"));
    console.log("EVIDENCE journalA=" + journalEvents("A").length + " journalB=" + journalEvents("B").length +
      " p2pInA=" + journalOf("A", "team.p2p", "message").length +
      " p2pInB=" + journalOf("B", "team.p2p", "message").length +
      " rejectedB=" + journalOf("B", "team.p2p", "rejected").length +
      " fallbackA=" + journalOf("A", "team.p2p", "fallback").length +
      " issueA=" + journalOf("A", "team.issue").length +
      " issueFiles=" + readdirSync(join(PROJ, ".genie", "issues")).length);
    try { A.ws.close(); B.ws.close(); } catch { /* 已关 */ }
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error("TEAM-SIM CRASH", e);
    console.log("SUMMARY team-sim CRASH");
    process.exitCode = 1;
  } finally {
    for (const who of Object.keys(children)) killGroup(who);
    for (const who of ["A", "B"]) {
      const pidFile = join(SIM, "pid-" + who);
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf-8").trim());
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(-pid, "SIGKILL"); } catch { /* 已退 */ }
          try { process.kill(pid, "SIGKILL"); } catch { /* 已退 */ }
        }
      }
    }
    await sleep(800);
    // 端口占用核验(TCP 连得上=还有实例在听):比 ss/netstat 更可靠(容器/最小镜像常缺这两个)。
    const portFree = (port) => new Promise((resolve) => {
      const s = require("node:net").connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(false); });
      s.on("error", () => resolve(true));
      s.setTimeout(1200, () => { s.destroy(); resolve(true); });
    });
    const [freeA, freeB] = await Promise.all([portFree(PORTS.A), portFree(PORTS.B)]);
    console.log("CLEANUP ports-free=" + (freeA && freeB ? "yes" : "NO 7781=" + freeA + " 7782=" + freeB));
    rmSync(SIM, { recursive: true, force: true });
    rmSync(JD.A, { recursive: true, force: true });
    rmSync(JD.B, { recursive: true, force: true });
    console.log("CLEANUP tmp-removed=" + (!existsSync(SIM) && !existsSync(JD.A) && !existsSync(JD.B) ? "yes" : "NO"));
  }
})();