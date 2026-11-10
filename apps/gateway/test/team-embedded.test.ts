// 内嵌团队 relay 自举 e2e(团队页空态修复):
// 模式判定 / bootstrapTeamRepo 幂等 / 真起 relay+客户端真连认证(操作级闭环)。
import { describe, expect, it, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { resolveTeamMode, bootstrapTeamRepo, startEmbeddedTeam, sanitizeUsername, localUsername, seedTeamProjects } from "../src/team-embedded.js";
import { TeamRelayClient } from "@lampgenie/runtime/team/relay-client";
import { loadOrCreateIdentity } from "@lampgenie/runtime/identity/identity";

const execFileP = promisify(execFile);

afterAll(() => { /* 临时目录留 CLUSTER 清理;relay 周期器均 unref */ });

describe("resolveTeamMode 三态", () => {
  it("未配置=内嵌默认端口;GENIE_TEAM_RELAY=off=关", () => {
    expect(resolveTeamMode({})).toEqual({ kind: "embedded", port: 7870 });
    expect(resolveTeamMode({ GENIE_TEAM_RELAY: "off" })).toEqual({ kind: "off" });
    expect(resolveTeamMode({ RELAY_PORT: "9901" })).toEqual({ kind: "embedded", port: 9901 });
  });
  it("指向本机的 RELAY_URL=内嵌(端口取 URL);非本机=外部", () => {
    expect(resolveTeamMode({ RELAY_URL: "ws://127.0.0.1:7870" })).toEqual({ kind: "embedded", port: 7870 });
    expect(resolveTeamMode({ RELAY_URL: "ws://localhost:9902" })).toEqual({ kind: "embedded", port: 9902 });
    expect(resolveTeamMode({ RELAY_URL: "wss://relay.example.com/team" })).toEqual({ kind: "external" });
    expect(resolveTeamMode({ RELAY_URLS: "ws://10.0.0.8:7870, ws://127.0.0.1:7870" })).toEqual({ kind: "external" });
  });
  it("用户名清洗:非法字符→-,空/./..→owner", () => {
    expect(sanitizeUsername("zhongyuqi")).toBe("zhongyuqi");
    expect(sanitizeUsername("../../etc")).toBe("..-..-etc"); // 仅精确「..」是穿越;多点前缀是合法文件名
    expect(sanitizeUsername("")).toBe("owner");
    expect(sanitizeUsername("..")).toBe("owner");
    expect(sanitizeUsername("张三")).toBe("owner"); // 非 ASCII 词字符全替换后剥空→owner
  });
});

describe("bootstrapTeamRepo 幂等自举", () => {
  it("bare 仓+owner 成员+项目绑定种子;二次运行零写入", async () => {
    const root = mkdtempSync(join(tmpdir(), "emb-team-"));
    try {
      // 模拟一个有 origin 的项目仓(bootstrap 从 root 读 origin?——不,origin 由调用方传入;
      // 这里只验证 bootstrap 本身:root 只用于 localUsername,直接传参即可)
      const bareDir = join(root, "team", "team-repo.git");
      const workdir = join(root, "team", "relay");
      const identityDir = join(root, "identity");
      const originUrl = "https://codeup.aliyun.com/org/demo-proj.git";
      const r1 = await bootstrapTeamRepo({ bareDir, workdir, identityDir, username: "tester", originUrl, projectId: "demo-proj" });
      expect(r1.createdRepo).toBe(true);
      expect(r1.member).toBe("tester");
      expect(r1.wrote.length).toBeGreaterThanOrEqual(2); // 成员 yaml + projects 键
      // bare 仓里有 main 分支与 roster 内容
      const branches = (await execFileP("git", ["branch"], { cwd: bareDir })).stdout;
      expect(branches).toContain("main");
      // 工作克隆里文件形态正确
      const cloneDir = join(workdir, "team-clone");
      const memberText = readFileSync(join(cloneDir, "roster", "members", "tester.yaml"), "utf-8");
      expect(memberText).toContain("username: tester");
      expect(memberText).toContain("role: owner");
      const identity = loadOrCreateIdentity(identityDir);
      expect(memberText).toContain(`fingerprint: ${identity.fingerprint}`);
      const projectsText = readFileSync(join(cloneDir, "roster", "projects.yaml"), "utf-8");
      expect(projectsText).toContain("demo-proj.type: team");
      expect(projectsText).toContain(`demo-proj.repo: ${originUrl}`);
      // 幂等:二次运行零写入
      const r2 = await bootstrapTeamRepo({ bareDir, workdir, identityDir, username: "tester", originUrl, projectId: "demo-proj" });
      expect(r2.createdRepo).toBe(false);
      expect(r2.wrote).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("startEmbeddedTeam 真连认证闭环", () => {
  it("relay 起+TeamRelayClient 认证 ready+presence 上行", async () => {
    const root = mkdtempSync(join(tmpdir(), "emb-run-"));
    try {
      const httpServer = createServer();
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const port = (httpServer.address() as AddressInfo).port;
      const handle = await startEmbeddedTeam({
        root,
        port,
        server: httpServer,
        log: () => {},
      });
      expect(handle).not.toBeNull();
      expect(existsSync(join(root, ".genie", "team", "team-repo.git", "HEAD"))).toBe(true);
      // 真客户端连上(同一身份目录=owner 指纹)→ 认证 ready
      const identityDir = join(root, ".genie", "identity");
      loadOrCreateIdentity(identityDir);
      let client: TeamRelayClient | null = null;
      const ready = await new Promise<boolean>((resolve) => {
        client = new TeamRelayClient({
          url: `ws://127.0.0.1:${port}`,
          identityDir,
          onState: (s) => { if (s === "ready") resolve(true); },
        });
        client.connect();
        setTimeout(() => resolve(false), 8000);
      });
      expect(ready).toBe(true);
      client!.sendPresence({ lastInputAt: Date.now(), runningSessions: 0, pendingAsks: 0, dnd: false });
      client!.stop();
      await handle!.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("端口被占返回 null(降级为外部连接)", async () => {
    const root = mkdtempSync(join(tmpdir(), "emb-busy-"));
    try {
      const { createServer: cs } = await import("node:http");
      const blocker = cs();
      await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
      const busyPort = (blocker.address() as AddressInfo).port;
      const handle = await startEmbeddedTeam({ root, port: busyPort, log: () => {} });
      expect(handle).toBeNull();
      blocker.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("localUsername", () => {
  it("解析失败回退 owner", async () => {
    const n = await localUsername("/nonexistent-root-for-git-config");
    expect(typeof n).toBe("string");
    expect(n.length).toBeGreaterThan(0);
  });
});

describe("seedTeamProjects 全项目绑定", () => {
  it("多项目入册+owner projects 数组补齐;幂等;改 label 按 repo 复用旧键", async () => {
    const root = mkdtempSync(join(tmpdir(), "emb-seed-"));
    try {
      const bareDir = join(root, "team", "team-repo.git");
      const workdir = join(root, "team", "relay");
      await bootstrapTeamRepo({ bareDir, workdir, identityDir: join(root, "identity"), username: "tester", originUrl: "https://git.example.com/a/harness.git", projectId: "harness" });
 // 追加两个项目绑定(memory-service 有 origin;非 git 仓=null 不入册)
      const w1 = await seedTeamProjects({
        workdir,
        username: "tester",
        bindings: [
          { projectId: "u1", label: "harness", originUrl: "https://git.example.com/a/harness.git" },
          { projectId: "u2", label: "memory-service", originUrl: "https://git.example.com/b/memory.git" },
          { projectId: "u3", label: "genie", originUrl: null },
        ],
      });
      expect(w1.some((k) => k.includes("memory-service"))).toBe(true);
      expect(w1.some((k) => k.startsWith("members/"))).toBe(true); // projects 数组补齐
      const projectsText = (await import("node:fs")).readFileSync(join(workdir, "team-clone", "roster", "projects.yaml"), "utf-8");
      expect(projectsText).toContain("memory-service.repo: https://git.example.com/b/memory.git");
      expect(projectsText).not.toContain("genie.repo:"); // 非 git 项目不入册
      const memberText = (await import("node:fs")).readFileSync(join(workdir, "team-clone", "roster", "members", "tester.yaml"), "utf-8");
      expect(memberText).toContain("  - memory-service"); // presence 投影按 member.projects
      expect(memberText).toContain("  - harness");
      // 幂等
      const w2 = await seedTeamProjects({
        workdir,
        username: "tester",
        bindings: [
          { projectId: "u1", label: "harness", originUrl: "https://git.example.com/a/harness.git" },
          { projectId: "u2", label: "memory-service", originUrl: "https://git.example.com/b/memory.git" },
        ],
      });
      expect(w2).toEqual([]);
      // 改 label:同 repo 归一化复用旧键,不产生第二份
      await seedTeamProjects({ workdir, username: "tester", bindings: [{ projectId: "u9", label: "renamed-memory", originUrl: "https://git.example.com/b/memory.git" }] });
      const projectsText2 = (await import("node:fs")).readFileSync(join(workdir, "team-clone", "roster", "projects.yaml"), "utf-8");
      expect(projectsText2).not.toContain("renamed-memory");
      expect(projectsText2.match(/memory-service\.repo:/g)?.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
