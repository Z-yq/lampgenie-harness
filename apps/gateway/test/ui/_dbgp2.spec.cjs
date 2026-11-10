const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:7700");
const pid = process.argv[2];
ws.on("open", () => {
  ws.send(JSON.stringify({ v: 1, type: "profile.get", projectId: pid }));
});
const seen = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "profile.get.result") {
    seen.push("got profile state=" + m.profile.state + " plan=" + JSON.stringify(m.profile.plan));
    ws.send(JSON.stringify({ v: 1, type: "profile.plan.upsert", projectId: pid, item: { id: "probe1", kind: "add-module", createdAt: Date.now(), name: "payments", note: "测试" } }));
  }
  if (m.type === "error") { console.log("ERROR:", m.code, m.message); ws.close(); process.exit(0); }
  if (seen.length >= 2) { console.log(seen.join("\n")); ws.close(); process.exit(0); }
});
setTimeout(() => { console.log("timeout", seen); process.exit(1); }, 15000);
