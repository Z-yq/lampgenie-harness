#!/usr/bin/env tsx
/**
 * Team Relay 生产入口( §5):每 org 一个,部署在团队可达的共享服务器。
 * 权威数据在 Git 仓;本进程只做实时面(presence/活动流/邀请兑换)——挂了不丢数据。
 * 环境变量:RELAY_PORT(默认 7870)/TEAM_REPO_URL(必填)/RELAY_WORKDIR(默认 ~/.lampgenie-harness/relay)
 */
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { TeamRelay } from "@lampgenie/runtime/team/team-relay";

const port = Number(process.env.RELAY_PORT ?? 7870);
const teamRepoUrl = process.env.TEAM_REPO_URL;
if (!teamRepoUrl) {
  console.error("缺少 TEAM_REPO_URL(团队仓 bare 地址)");
  process.exit(1);
}
const workdir = process.env.RELAY_WORKDIR ?? join(homedir(), ".lampgenie-harness", "relay");

const http = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...relay.snapshot() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const relay = new TeamRelay({
  server: http,
  teamRepoUrl,
  workdir,
 // 上游权威仓(teammate 推送源)+ learnings 分支名——镜像形态时的同步通道。
  ...(process.env.TEAM_UPSTREAM_URL ? { upstreamUrl: process.env.TEAM_UPSTREAM_URL } : {}),
  ...(process.env.TEAM_LEARNINGS_BRANCH ? { learningsBranch: process.env.TEAM_LEARNINGS_BRANCH } : {}),
});
http.listen(port, () => {
  console.log(`[relay] listening :${port} teamRepo=${teamRepoUrl} workdir=${workdir}`);
});
void relay.start();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void relay.close().finally(() => process.exit(0));
  });
}
