/**
 * 客户端协议探测与能力协商:wiring 断言(读源码)+ 协议帧纯路径。
 * 为什么不启真网关:本用例要锁的是「接线位置」与「稳定字面量码」——一旦有人把分发门挪到
 * switch 之后、把 client.capabilities 挪到  allowlist 之后,或者把 capabilities 从 hello 摘掉,
 * 真端口测试未必能稳定复现(要看面板时序),源码断言反而逐字可靠。
 * 真实 WS 帧(hello.capabilities)另由探针 G 经验证,legacy 行为由 ws-integration.test.ts 全量回归。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  LEGACY_NEGOTIATION,
  SERVER_CAPABILITY_OPS,
  checkDispatch,
  capabilityOpsOfTypes,
  negotiateClientCapabilities,
} from "@lampgenie/runtime/protocol/capabilities";
import { parseClientMessage, ServerMessage, ErrorCode } from "@lampgenie/protocol";
import { PANEL_CHANNELS } from "../src/client-capabilities.js";

const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const protocolSrc = readFileSync(new URL("../../../packages/protocol/src/index.ts", import.meta.url), "utf8");
const capabilitiesSrc = readFileSync(
  new URL("../../../packages/harness-runtime/src/protocol/capabilities.ts", import.meta.url),
  "utf8",
);

describe("协议帧:hello.capabilities 与 client.capabilities", () => {
  it("hello 帧带 capabilities{contractVersion,ops,health} 可通过协议校验", () => {
    const frame = {
      v: 1,
      type: "hello",
      build: "b1",
      tasks: [],
      capabilities: { contractVersion: 1, ops: [...SERVER_CAPABILITY_OPS], health: ["ws", "journal", "terminal"] },
    };
    expect(ServerMessage.safeParse(frame).success).toBe(true);
  });

  it("hello 不带 capabilities 仍合法(旧服务端/客户端互操作)", () => {
    expect(ServerMessage.safeParse({ v: 1, type: "hello", tasks: [] }).success).toBe(true);
  });

  it("capabilities.result 帧可通过协议校验(协商结论走 result,不走 error)", () => {
    const frame = {
      v: 1,
      type: "capabilities.result",
      ok: true,
      mode: "negotiated",
      code: "OK",
      acceptedOps: ["task"],
      rejectedOps: [],
      droppedKeys: [],
      summary: "x",
    };
    expect(ServerMessage.safeParse(frame).success).toBe(true);
  });

  it("client.capabilities 声明消息可被 parseClientMessage 解析(不再落 invalid-message)", () => {
    const parsed = parseClientMessage(
      JSON.stringify({ v: 1, type: "client.capabilities", supportedOps: ["task"], contractVersion: 1 }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("client.capabilities");
  });

  it("两个新错误码已登记枚举(protocol ErrorCode)且可过 error 帧 schema", () => {
    expect(ErrorCode.UnknownMethod).toBe("unknown-method");
    expect(ErrorCode.UnsupportedOp).toBe("unsupported-op");
    for (const code of [ErrorCode.UnknownMethod, ErrorCode.UnsupportedOp]) {
      expect(ServerMessage.safeParse({ v: 1, type: "error", code, message: "x" }).success).toBe(true);
    }
  });

  it("协议 ErrorCode 枚举已登记三码(值逐字不变,文案单源在 error-text.ts)", () => {
    expect(protocolSrc).toContain('UnsupportedOp: "unsupported-op"');
    expect(protocolSrc).toContain('UnknownMethod: "unknown-method"');
    expect(protocolSrc).toContain('QueueConflict: "queue-conflict"');
  });
});

describe("server.ts 接线(源码断言)", () => {
  it("hello 自报能力位:capabilities + healthBits(接线)", () => {
    const helloIdx = serverSrc.indexOf('type: "hello", build: PANEL_BUILD');
    expect(helloIdx).toBeGreaterThan(0);
    const helloBlock = serverSrc.slice(helloIdx, helloIdx + 900);
    expect(helloBlock).toContain("capabilities:");
    expect(helloBlock).toContain("healthBits({");
    expect(helloBlock).toContain("contractVersion: CAPABILITY_CONTRACT_VERSION");
    expect(helloBlock).toContain("ops: [...SERVER_CAPABILITY_OPS]");
    expect(helloBlock).toContain("llm: !!opts.llm");
    expect(helloBlock).toContain("memory: !!opts.memoryView");
  });

  it("分发门在协议解析之前运行(未知 type 才能拿到稳定码)", () => {
    const gateIdx = serverSrc.indexOf("dispatchDenialOf(peekedType");
    const parseIdx = serverSrc.indexOf("parseClientMessage(rawText)");
    expect(gateIdx).toBeGreaterThan(0);
    expect(parseIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeLessThan(parseIdx);
  });

  it("handleMessage 入口复核:分发门在 switch 之前", () => {
    const hmIdx = serverSrc.indexOf("async function handleMessage(");
    const switchIdx = serverSrc.indexOf("switch (msg.type) {", hmIdx);
    expect(hmIdx).toBeGreaterThan(0);
    expect(switchIdx).toBeGreaterThan(hmIdx);
    expect(serverSrc.slice(hmIdx, switchIdx)).toContain("dispatchDenialOf(");
    expect(serverSrc.slice(hmIdx, switchIdx)).toContain("denyDispatch(");
  });

  it("client.capabilities 协商早于  allowlist(否则声明通道自身被白名单拒)", () => {
    const capIdx = serverSrc.indexOf('if (msg.type === "client.capabilities")');
    const allowIdx = serverSrc.indexOf("if (!isChannelAllowed(clientMode, channel)");
    expect(capIdx).toBeGreaterThan(0);
    expect(allowIdx).toBeGreaterThan(0);
    expect(capIdx).toBeLessThan(allowIdx);
  });

  it("协商结果按连接保存(WeakMap)并回 capabilities.result", () => {
    expect(serverSrc).toContain("const negotiatedCapsByWs = new WeakMap<WebSocket, NegotiatedCapabilities>()");
    expect(serverSrc).toContain("negotiatedCapsByWs.set(ws, negotiatedNext)");
    expect(serverSrc).toContain('type: "capabilities.result"');
    expect(serverSrc).toContain("describeCapabilities(negotiatedNext)");
  });

  it("拒收统一走 unknown-method / unsupported-op(不静默、不落 switch)", () => {
 // 字面量单源在 runtime capabilities.ts;server 回帧用协议枚举(值逐字相同)。
    expect(capabilitiesSrc).toContain('unknownMethod: "unknown-method"');
    expect(capabilitiesSrc).toContain('unsupportedOp: "unsupported-op"');
    expect(serverSrc).toContain("ErrorCode.UnsupportedOp");
    expect(serverSrc).toContain("ErrorCode.UnknownMethod");
    expect(serverSrc).toContain('type: "client.dispatch.denied"');
  });

  it("能力目录来自 runtime 纯逻辑模块,gateway 不自建第二份清单", () => {
    expect(serverSrc).toContain('from "@lampgenie/runtime/protocol/capabilities"');
    expect(serverSrc).not.toContain('const SERVER_CAPABILITY_OPS = [');
  });

  it("源码对拍:server.ts 每个 case 首段都在能力目录内(豁免表仅显式 client)", () => {
    const caseRe = /case\s+"([A-Za-z0-9_.]+)"\s*:/g;
    const literals: string[] = [];
    for (let m = caseRe.exec(serverSrc); m !== null; m = caseRe.exec(serverSrc)) literals.push(m[1]);
    expect(literals.length).toBeGreaterThan(150);

    const namespaces = capabilityOpsOfTypes(literals);
 // 显式豁免表(写死,不许通配):唯一豁免是 client 自举——即便它将来被移出目录,
 // client.capabilities / client.mode 也必须能再协商回来。
    const EXEMPT_NAMESPACES = ["client"];
    const covered = new Set<string>([...SERVER_CAPABILITY_OPS, ...EXEMPT_NAMESPACES]);
    const missing = namespaces.filter((ns) => !covered.has(ns));
    expect(missing, `未编目命名空间(必须并入 SERVER_CAPABILITY_OPS): ${missing.join(", ")}`).toEqual([]);

 // 反向抽查:本轮补齐的既有通道确实出现在源码里(目录不是想当然写的)
    for (const ns of ["voice", "exp", "team", "issue", "browser", "sys", "rsi"]) {
      expect(namespaces, ns).toContain(ns);
    }
 // 无点消息(task_output/ping)不属能力协商面,提取时被剔除
    expect(capabilityOpsOfTypes(["task_output", "ping"])).toEqual([]);
 // 未编目段仍判 UNKNOWN_METHOD(封闭清单,不做前缀通配)
    expect(checkDispatch({ type: "foo.bar", negotiated: LEGACY_NEGOTIATION }).code).toBe("UNKNOWN_METHOD");
  });
});

describe("探针纯路径(与 capabilities.test.ts 同源,这里锁 gateway 侧语义)", () => {
  const opts = { serverOps: SERVER_CAPABILITY_OPS, currentContractVersion: 1 } as const;

  it("探针 A:未声明连接 = legacy 全量放行", () => {
    const n = negotiateClientCapabilities(undefined, opts);
    expect(n.mode).toBe("legacy");
    expect(checkDispatch({ type: "board.save", negotiated: n }).allow).toBe(true);
  });

  it("探针 B:声明 [task,queue] → 交集且 board 被拒", () => {
    const n = negotiateClientCapabilities({ supportedOps: ["task", "queue"] }, opts);
    expect([...n.acceptedOps]).toEqual(["queue", "task"]);
    expect(checkDispatch({ type: "board.save", negotiated: n }).code).toBe("UNSUPPORTED_OP");
  });

  it("探针 D:声明空 supportedOps → NO_OPS,非 client 通道全拒", () => {
    const n = negotiateClientCapabilities({ supportedOps: [] }, opts);
    expect(n.code).toBe("NO_OPS");
    expect(checkDispatch({ type: "task.submit", negotiated: n }).code).toBe("UNSUPPORTED_OP");
  });

  it("探针 E:未知 type 在 legacy 下也是 UNKNOWN_METHOD", () => {
    expect(checkDispatch({ type: "foo.bar", negotiated: LEGACY_NEGOTIATION }).code).toBe("UNKNOWN_METHOD");
  });

  it("探针 F:已声明未含 cfg → cfg.set = UNSUPPORTED_OP", () => {
    const n = negotiateClientCapabilities({ supportedOps: ["task"] }, opts);
    expect(checkDispatch({ type: "cfg.set", negotiated: n }).code).toBe("UNSUPPORTED_OP");
  });

  it("探针 G:rsi.status 声明 rsi → allow;未声明 → UNSUPPORTED_OP;legacy → allow", () => {
    const declared = negotiateClientCapabilities({ supportedOps: ["rsi"] }, opts);
    expect(checkDispatch({ type: "rsi.status", negotiated: declared })).toEqual({ allow: true, code: "OK" });
    const undeclared = negotiateClientCapabilities({ supportedOps: ["task"] }, opts);
    expect(checkDispatch({ type: "rsi.status", negotiated: undeclared })).toEqual({ allow: false, code: "UNSUPPORTED_OP" });
    expect(checkDispatch({ type: "rsi.status", negotiated: LEGACY_NEGOTIATION }).allow).toBe(true);
  });

  it("未编目但已在  白名单的既有通道不被误杀(voice.tts 在 PANEL_CHANNELS 里)", () => {
    expect(PANEL_CHANNELS).toContain("voice.tts");
 // 补齐轮后 voice 已编目:legacy 连接照旧放行(不因编目而收紧旧客户端),
 // 而 negotiated 连接未声明 voice 时必须被 fail-closed 拦下。
    expect(checkDispatch({ type: "voice.tts", negotiated: LEGACY_NEGOTIATION }).code).toBe("OK");
    expect(checkDispatch({ type: "voice.tts", negotiated: LEGACY_NEGOTIATION }).allow).toBe(true);
    const declaredTaskOnly = negotiateClientCapabilities({ supportedOps: ["task"] }, opts);
    expect(checkDispatch({ type: "voice.tts", negotiated: declaredTaskOnly }).code).toBe("UNSUPPORTED_OP");
    expect(checkDispatch({ type: "sys.health", negotiated: declaredTaskOnly }).code).toBe("UNSUPPORTED_OP");
 // 未编目通道仍走 UNKNOWN_METHOD(目录是封闭清单,不是前缀通配)
    expect(checkDispatch({ type: "foo.bar", negotiated: LEGACY_NEGOTIATION }).code).toBe("UNKNOWN_METHOD");
  });
});
