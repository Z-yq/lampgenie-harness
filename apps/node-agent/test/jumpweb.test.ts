import { describe, it, expect } from "vitest";
import { JumpWebSession, JumpWebHost, createJumpWebHandler, FakeDriver, NoopDriver } from "../src/jumpweb";
import { startNodeAgent, type NodeAgentOptions } from "../src/index";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET_PW = "s3cr3t-pw-9x7";
const CREDS: Record<string, string> = {
  BASE: "https://ops.example.local",
  USER: "alice",
  PASS: SECRET_PW,
};

const LOGIN_SCRIPT = [
  { type: "goto", url: "{{cred:BASE}}/login" },
  { type: "fill", selector: "#user", value: "{{cred:USER}}" },
  { type: "fill", selector: "#pass", value: "{{cred:PASS}}" },
  { type: "click", selector: "#submit" },
  { type: "wait", ms: 5 },
  { type: "assert", textContains: "欢迎回来" },
];

/** 无 assert 步的脚本(标记校验只看 content,不受步内断言影响)。 */
const LOGIN_SCRIPT_NO_ASSERT = LOGIN_SCRIPT.slice(0, 5);

/** 本地凭据库替身:缺引用显式抛(fail-visible,不猜)。 */
function makeResolver(creds: Record<string, string>, calls: string[] = []) {
  return (name: string): string => {
    calls.push(name);
    if (!(name in creds)) throw new Error(`本地凭据库无引用 ${name}`);
    return creds[name]!;
  };
}

describe("JumpWebSession( §5 跳板机网页登录执行器)", () => {
  it("全脚本 happy path:步骤按序执行,占位只在驱动调用时现场解析,标记全命中=ok", async () => {
    const driver = new FakeDriver("运营平台 · 欢迎回来");
    const calls: string[] = [];
    const session = new JumpWebSession({
      driver,
      resolveCredential: makeResolver(CREDS, calls),
      expectTextContains: ["运营平台"],
    });
    expect(calls).toEqual([]); // 构造时不碰凭证
    const r = await session.run(LOGIN_SCRIPT);

    expect(r.ok).toBe(true);
    expect(driver.calls.map((c) => c.method).join(",")).toBe("goto,fill,fill,click,wait,assert,content");
    expect(driver.calls[0]!.args).toEqual(["https://ops.example.local/login"]);
    expect(driver.calls[1]!.args).toEqual(["#user", "alice"]);
    expect(driver.calls[2]!.args).toEqual(["#pass", SECRET_PW]);
    expect(calls).toEqual(["BASE", "USER", "PASS"]); // 每个引用恰解析一次,按步序
    expect(r.markers).toEqual([{ text: "运营平台", found: true }]);
  });

  it("缺凭证 → jumpweb:cred-missing typed 错误,后续步骤不执行", async () => {
    const driver = new FakeDriver("");
    const calls: string[] = [];
    const session = new JumpWebSession({
      driver,
      resolveCredential: makeResolver({ BASE: CREDS.BASE!, USER: CREDS.USER! }, calls), // 无 PASS
    });
    const r = await session.run(LOGIN_SCRIPT);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("jumpweb:cred-missing");
    expect(driver.calls.map((c) => c.method).join(",")).toBe("goto,fill"); // fill #pass 中止
    expect(calls).toEqual(["BASE", "USER", "PASS"]);
  });

  it("红线:凭证值不出现在日志/输出(日志恒记未解析占位原文)", async () => {
    const driver = new FakeDriver("欢迎回来 alice,您的临时密码是 s3cr3t-pw-9x7,请尽快改密");
    const session = new JumpWebSession({
      driver,
      resolveCredential: makeResolver(CREDS),
      expectTextContains: ["欢迎回来"],
    });
    const r = await session.run(LOGIN_SCRIPT);
    expect(r.ok).toBe(true);
    const everything = JSON.stringify({ logs: r.logs, output: r.output, markers: r.markers, error: r.error });
    expect(everything).not.toContain(SECRET_PW); // 密码值(页面渲染也被擦除)
    expect(everything).not.toContain("https://ops.example.local"); // BASE 值
    expect(r.logs.join("\n")).toContain("{{cred:PASS}}"); // 占位原文可见(可审计)
    // 所有 resolveCredential 解析出的值(USER/PASS/BASE)在输出里一律 ***——红线不分强弱凭据。
    expect(r.output).toBe("欢迎回来 ***,您的临时密码是 ***,请尽快改密");
    expect(r.output).not.toContain(SECRET_PW);
  });

  it("输出回放校验:标记缺失 → ok=false + markers 逐项 found", async () => {
    const driver = new FakeDriver("登录失败:密码错误");
    const session = new JumpWebSession({
      driver,
      resolveCredential: makeResolver(CREDS),
      expectTextContains: ["运营平台", "不存在标记xyz"],
    });
    const r = await session.run(LOGIN_SCRIPT_NO_ASSERT);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("jumpweb:markers-missing");
    expect(r.markers).toEqual([
      { text: "运营平台", found: false },
      { text: "不存在标记xyz", found: false },
    ]);
  });

  it("单步超时 → jumpweb:step-timeout(挂起驱动被 race 切断)", async () => {
    const driver = new FakeDriver("", (_m) => {
      if (_m === "goto") return new Promise<void>(() => {});
    });
    const session = new JumpWebSession({
      driver,
      resolveCredential: makeResolver(CREDS),
      stepTimeoutMs: 100,
    });
    const r = await session.run(LOGIN_SCRIPT);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("jumpweb:step-timeout");
  });

  it("整会话超时 → jumpweb:overall-timeout", async () => {
    const driver = new FakeDriver("");
    const session = new JumpWebSession({
      driver,
      resolveCredential: makeResolver(CREDS),
      overallTimeoutMs: 200,
    });
    const r = await session.run([{ type: "wait", ms: 500 }, { type: "wait", ms: 500 }]);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("jumpweb:overall-timeout");
  });

  it("驱动步抛错 → jumpweb:step-failed;script 非法 → jumpweb:script-invalid;JSON 字符串脚本可用", async () => {
    const boom = new FakeDriver("", (_m) => {
      if (_m === "click") throw new Error("selector not found: #submit");
    });
    const s1 = new JumpWebSession({ driver: boom, resolveCredential: makeResolver(CREDS) });
    const r1 = await s1.run(LOGIN_SCRIPT);
    expect(r1.ok).toBe(false);
    expect(r1.error?.code).toBe("jumpweb:step-failed");

    const s2 = new JumpWebSession({ driver: new NoopDriver(), resolveCredential: makeResolver(CREDS) });
    expect((await s2.run(undefined)).error?.code).toBe("jumpweb:script-invalid");
    expect((await s2.run([{ type: "teleport" }])).error?.code).toBe("jumpweb:script-invalid");
    expect((await s2.run([{ type: "goto" }])).error?.code).toBe("jumpweb:script-invalid");

    const r3 = await s2.run(JSON.stringify([{ type: "wait", ms: 1 }]));
    expect(r3.ok).toBe(true); // 无标记要求=通过
  });

  it("assert 步页面文本不符 → 驱动抛错落 step-failed(FakeDriver 内建文本断言)", async () => {
    const driver = new FakeDriver("登录页(无欢迎语)");
    const session = new JumpWebSession({ driver, resolveCredential: makeResolver(CREDS) });
    const r = await session.run(LOGIN_SCRIPT);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("jumpweb:step-failed");
  });
});

describe("JumpWebHost / createJumpWebHandler(node-agent execute 注入面)", () => {
  it("credRefs 预检:缺引用直接失败,驱动工厂不被触达", async () => {
    let driverBuilt = false;
    const host = new JumpWebHost({
      driver: () => { driverBuilt = true; return new NoopDriver(); },
      resolveCredential: makeResolver({}),
    });
    const r = await host.handle({ instruction: "登录", script: LOGIN_SCRIPT, credRefs: ["PASS"] });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("jumpweb:cred-missing");
    expect(driverBuilt).toBe(false);
  });

  it("驱动未注入 → jumpweb:driver-missing(fail-visible,不伪造成功)", async () => {
    const host = new JumpWebHost({ resolveCredential: makeResolver(CREDS) });
    const r = await host.handle({ instruction: "登录", script: LOGIN_SCRIPT });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("jumpweb:driver-missing");
    expect(r.output).toContain("jumpweb:driver-missing");
  });

  it("createJumpWebHandler 工厂:全链 ok,输出含回放校验后的页面内容", async () => {
    const { handle } = createJumpWebHandler({
      driver: new FakeDriver("运营平台 · 欢迎回来"),
      resolveCredential: makeResolver(CREDS),
      expectTextContains: ["运营平台"],
    });
    const r = await handle({ instruction: "登录运营平台", script: LOGIN_SCRIPT });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("运营平台");
    expect(r.error).toBeUndefined();
  });
});

// ---- node-agent 分派集成:GENIE_NODE_JUMPWEB=1 注册 "jumpweb" kind;未设置=缺省行为不变 ----

/** 一次性假网关:node.register 到达即下发 dispatch,回传首个 node.task.result。 */
async function dispatchOnce(
  agentOpts: Omit<NodeAgentOptions, "gatewayUrl">,
  dispatchMsg: Record<string, unknown>,
  envValue: string | undefined): Promise<Record<string, unknown>> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const addr = wss.address() as AddressInfo;
  const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("10s 未收到 node.task.result")), 10_000);
    wss.on("connection", (socket) => {
      socket.on("message", (raw: Buffer) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
        if (msg.type === "node.register") {
          socket.send(JSON.stringify({ v: 1, type: "node.task.dispatch", ...dispatchMsg }));
        } else if (msg.type === "node.task.result") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
  });

  const prev = process.env.GENIE_NODE_JUMPWEB;
  if (envValue === undefined) delete process.env.GENIE_NODE_JUMPWEB;
  else process.env.GENIE_NODE_JUMPWEB = envValue;
  const agent = startNodeAgent({ ...agentOpts, gatewayUrl: `ws://127.0.0.1:${addr.port}` });
  try {
    return await resultPromise;
  } finally {
    agent.close();
    await new Promise<void>((r) => wss.close(() => r()));
    if (prev === undefined) delete process.env.GENIE_NODE_JUMPWEB;
    else process.env.GENIE_NODE_JUMPWEB = prev;
  }
}

describe("node-agent jumpweb 分派集成(GENIE_NODE_JUMPWEB 门控)", () => {
  const credsDir = mkdtempSync(join(tmpdir(), "jumpweb-test-"));
  const credsFile = join(credsDir, "creds.json");
  writeFileSync(credsFile, JSON.stringify(CREDS));

  const baseOpts = {
    nodeId: "jw-node",
    kind: "jump" as const,
    capabilities: ["jumpweb"],
    reachability: ["lan"],
    credentialsFile: credsFile,
  };

  it("env=1 + 驱动工厂:kind=jumpweb 走网页链路,ok 且回传不含凭证值", async () => {
    const result = await dispatchOnce(
      { ...baseOpts, jumpwebDriverFactory: () => new FakeDriver("运营平台 · 欢迎回来") },
      { taskId: "jw-1", instruction: "登录运营平台", kind: "jumpweb", script: LOGIN_SCRIPT, credRefs: ["PASS"] },
      "1",
    );
    expect(result.type).toBe("node.task.result");
    expect(result.ok).toBe(true);
    const payload = JSON.stringify(result);
    expect(payload).toContain("运营平台");
    expect(payload).not.toContain(SECRET_PW);
  }, 15_000);

  it("env 未设置(缺省):同 kind=jumpweb 任务落缺省执行器,行为与旧版一致", async () => {
    const result = await dispatchOnce(
      baseOpts,
      { taskId: "jw-2", instruction: "登录运营平台", kind: "jumpweb", script: LOGIN_SCRIPT },
      undefined);
    expect(result.ok).toBe(true);
    expect(String(result.output)).toContain("executed"); // 缺省 echo 执行器回执
  }, 15_000);

  it("env=1 但无驱动工厂:jumpweb 任务 typed 失败(jumpweb:driver-missing),不崩节点", async () => {
    const result = await dispatchOnce(
      baseOpts,
      { taskId: "jw-3", instruction: "登录运营平台", kind: "jumpweb", script: LOGIN_SCRIPT },
      "1",
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("jumpweb:driver-missing");
  }, 15_000);

  it("env=1:缺凭证引用的任务 → jumpweb:cred-missing 回流(值不过网关)", async () => {
    const result = await dispatchOnce(
      { ...baseOpts, jumpwebDriverFactory: () => new FakeDriver("运营平台") },
      { taskId: "jw-4", instruction: "登录", kind: "jumpweb", script: LOGIN_SCRIPT, credRefs: ["NOPE"] },
      "1",
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("jumpweb:cred-missing");
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(SECRET_PW);
  }, 15_000);
});
