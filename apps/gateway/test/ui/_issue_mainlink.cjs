/** fixD 主链路(7858/7859 双实例,两进程):P2P 互 ping/presence → issue 实例 A 建、实例 B 可见(共享仓)→
 * 确认派发 → 任务跑完 → issue 评论回写 + 状态 done → 停 B → 消息降级(relay 缺席=离线队列标记)。
 * 跑法:cd apps/gateway && npx tsx test/ui/_issue_mainlink.cjs
 * 纪律:kill 只按 spawn 时落盘的 PID;真实仓 .genie/{team/members.json,secrets.json} 恢复原样。 */
if (!String(process.env.NODE_OPTIONS || "").includes("--conditions=development")) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("npx", ["tsx", __filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : "") + "--conditions=development" },
  });
  process.exit(r.status ?? 1);
}
const { spawn, execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const WebSocket = require("ws");

const REPO_ROOT = resolve(__dirname, "../../..");
const SNAP = ["team/members.json", "secrets.json"].map((rel) => {
  const p = join(REPO_ROOT, ".genie", rel);
  return { p, existed: existsSync(p), bytes: existsSync(p) ? readFileSync(p) : null };
});
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsClient(port) {
  const pending = [];
  const handlers = new Set();
  const ws = new WebSocket("ws://127.0.0.1:" + port);
  const obj = {
    ws,
    onType: (fn) => { handlers.add(fn); return () => handlers.delete(fn); },
    request: (msg, want, timeoutMs = 15000) => new Promise((resolveP, rejectP) => {
      const off = obj.onType((m) => { if (m.type === want) { off(); clearTimeout(t); resolveP(m); } });
      const t = setTimeout(() => { off(); rejectP(new Error("timeout 等 " + want)); }, timeoutMs);
      ws.send(JSON.stringify(msg));
    }),
  };
  ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); for (const h of [...handlers]) { try { h(m); } catch (e) { /* 监听者异常不拦 */ } } });
  void pending;
  return new Promise((res, rej) => { ws.on("open", () => res(obj)); ws.on("error", rej); });
}

(async () => {
  const proj = mkdtempSync(join(tmpdir(), "mlproj-"));
  execFileSync("git", ["init", "-q", proj]);
  execFileSync("git", ["remote", "add", "origin", "https://gitlab.localhost.invalid/acme/widgets.git"], { cwd: proj });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init", "-q"], { cwd: proj });

  const NODE_ENV_BASE = { ...process.env, ISSUE_PROJ_DIR: proj, GENIE_CHECKPOINT: "off" };
  const spawnInst = (port, user) => {
    // detached+进程组:收尾按 -pgid SIGKILL(npx 包装层 SIGTERM 不传递,曾留实例占端口串跑)。
    const child = spawn("npx", ["tsx", join(__dirname, "_issue_inst.cjs")], {
      env: { ...NODE_ENV_BASE, SELF_PORT: String(port), GENIE_P2P_USER: user },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.on("data", (d) => { const s = String(d); if (s.includes("READY")) child.emit("ready"); process.stdout.write("[inst" + port + "] " + s); });
    child.stderr.on("data", (d) => process.stderr.write("[inst" + port + " err] " + d));
    writeFileSync(join(tmpdir(), "genie-issue-inst-" + port + ".pid"), String(child.pid));
    return child;
  };
  const killGroup = (child) => { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { /* 已退 */ } try { child.kill("SIGKILL"); } catch (e) { /* 已退 */ } };
  const a = spawnInst(7858, "tester-a");
  await new Promise((res, rej) => { a.once("ready", res); setTimeout(() => rej(new Error("A 未就绪")), 25000); });
  await sleep(1500); // 成员目录读改写错峰(两实例共享 members.json)
  const b = spawnInst(7859, "tester-b");
  await new Promise((res, rej) => { b.once("ready", res); setTimeout(() => rej(new Error("B 未就绪")), 25000); });
  await sleep(1000);

  try {
    const pa = (await wsClient(7858)).request.bind(null);
    const A = await wsClient(7858);
    const B = await wsClient(7859);
    void pa;

    // 1. P2P 互 ping:A 的 status 应答前探未知成员 → tester-b online(签名 ping 经 HTTP)。
    const st = await A.request({ v: 1, type: "team.p2p.status" }, "team.p2p.status.result", 12000);
    const members = ((st.status || {}).members) || [];
    const tb = members.find((m) => m.username === "tester-b");
    check("P2P 互 ping(A 探 B=online,签名验真通过)", tb && tb.state === "online", JSON.stringify(members.map((m) => [m.username, m.state, m.port, m.err || ""])));

    // 2. issue 实例 A 建 → 实例 B(同仓目录)看板数据可见(共享 .genie/issues 文件)。
    const bp = ((await B.request({ v: 1, type: "project.list" }, "project.list.result")).projects || [])[0];
    const listB = async () => (await B.request({ v: 1, type: "issue.list", projectId: bp.id }, "issue.list.result", 12000)).issues || [];
    const ap = ((await A.request({ v: 1, type: "project.list" }, "project.list.result")).projects || [])[0];
    await A.request({ v: 1, type: "issue.create", projectId: ap.id, title: "双实例共享 issue", body: "A 建 B 可见", assignee: "tester-a" }, "issue.list.result", 12000);
    const seen = await listB();
    check("issue 在 A 建、B 看板可见(同仓文件共享)", seen.some((i) => i.title === "双实例共享 issue"), JSON.stringify(seen.map((i) => i.title)));

    // 3. 确认派发 → 任务跑完(echo)→ 终态自动回写 issue 评论 + 状态 done。
    const disp = await A.request({ v: 1, type: "issue.confirm.dispatch", projectId: ap.id, number: seen[0].number }, "issue.dispatch.result", 12000);
    check("确认派发 ok(taskId 回关联)", disp.ok === true, JSON.stringify(disp).slice(0, 80));
    let doneIssue = null;
    for (let i = 0; i < 20 && !doneIssue; i++) {
      await sleep(800);
      const list = await A.request({ v: 1, type: "issue.list", projectId: ap.id }, "issue.list.result", 12000);
      doneIssue = (list.issues || []).find((x) => x.number === seen[0].number && x.status === "done" && ((x.comments || []).length) > 0) || null;
      if (i === 6 && !doneIssue) {
        const tl = await A.request({ v: 1, type: "task.list" }, "task.list", 8000);
        console.log("[dbg] tasks=" + JSON.stringify((tl.tasks || []).map((t) => [String(t.id).slice(0, 8), t.state])));
      }
    }
    check("任务终态回写(评论 ✅ + 状态 done)", !!doneIssue, doneIssue ? String(doneIssue.comments[0].body).slice(0, 60) : "15s 内未见");

    // 4. P2P 直发消息(B 在):via=p2p(签名 message 投递 B 收件箱)。
    const m1 = await A.request({ v: 1, type: "team.p2p.send", to: "tester-b", text: "ping-b" }, "team.p2p.message.result", 12000);
    check("P2P 直发消息 via=p2p", m1.via === "p2p", JSON.stringify(m1));

    // 5. 停 B(进程组 SIGKILL)→ A 再发 → 直连不可达,relay 缺席 → 离线队列(via=queued,标记降级)。
    killGroup(b);
    await sleep(1500);
    const m2 = await A.request({ v: 1, type: "team.p2p.send", to: "tester-b", text: "after-down" }, "team.p2p.message.result", 12000);
    check("B 停后消息降级(不可达+无 relay=离线队列 via=queued)", m2.via === "queued", JSON.stringify(m2));

    const failed = results.filter((r) => !r.ok).length;
    console.log("SUMMARY issue-mainlink " + (results.length - failed) + "/" + results.length + (failed ? " FAILED" : " ALL-PASS"));
    A.ws.close(); B.ws.close();
    killGroup(a);
    process.exitCode = failed ? 1 : 0; // 不 process.exit:让 finally 清理跑完再自然退出
  } catch (e) {
    console.error("MAINLINK CRASH", e);
    console.log("SUMMARY issue-mainlink CRASH");
    killGroup(a); killGroup(b);
    process.exitCode = 1;
  } finally {
    try { rmSync(proj, { recursive: true, force: true }); } catch (e) { /* 尽力 */ }
    for (const s of SNAP) {
      try {
        if (s.existed) writeFileSync(s.p, s.bytes);
        else if (existsSync(s.p)) rmSync(s.p, { force: true });
      } catch (e) { /* 恢复尽力 */ }
    }
  }
})();
