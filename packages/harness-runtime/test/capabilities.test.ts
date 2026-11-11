/**
 * 能力协商纯逻辑测试(零 IO;不碰网络/文件/环境)。
 * 覆盖口径:
 * ① 封闭 op 清单与 capabilityOpOf 的边界(空/无点/未知段/非字符串);
 * ② healthBits 只列 true 且顺序固定(确定性);
 * ③ negotiateClientCapabilities 四码(LEGACY/OK/CONTRACT_TOO_OLD/NO_OPS)、交集、未知 op/重复/坏字段丢弃、
 * 未知高版本不放大权限、不可变与确定性;
 * ④ checkDispatch 的 legacy 全放行 / negotiated fail-closed / client 自举通道。
 * 这些用例同时是「真实探针 A–F」的可执行版本(见每例标题)。
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CONTRACT_VERSION,
  DISPATCH_ERROR_CODES,
  LEGACY_NEGOTIATION,
  SERVER_CAPABILITY_OPS,
  capabilityOpOf,
  capabilityOpsOfTypes,
  checkDispatch,
  describeCapabilities,
  healthBits,
  negotiateClientCapabilities,
} from "../src/protocol/capabilities";

const NEG_OPTS = { serverOps: SERVER_CAPABILITY_OPS, currentContractVersion: CAPABILITY_CONTRACT_VERSION } as const;

function negotiate(declared: unknown) {
  return negotiateClientCapabilities(declared, NEG_OPTS);
}

describe("SERVER_CAPABILITY_OPS 封闭清单", () => {
  it("67 个命名空间、无重复、升序,含 client 引导面与本次补齐的既有通道", () => {
    expect(SERVER_CAPABILITY_OPS.length).toBe(67);
    expect(new Set(SERVER_CAPABILITY_OPS).size).toBe(67);
    expect([...SERVER_CAPABILITY_OPS]).toEqual([...SERVER_CAPABILITY_OPS].sort());
    expect(SERVER_CAPABILITY_OPS).toContain("client");
    expect(SERVER_CAPABILITY_OPS).toContain("task");
    expect(SERVER_CAPABILITY_OPS).toContain("cfg");
    expect(SERVER_CAPABILITY_OPS).toContain("rsi");
 // 补齐轮点名的 6 个既有通道(此前未编目 → negotiated 连接 fail-open)
    for (const op of ["voice", "exp", "team", "issue", "browser", "sys"]) {
      expect(SERVER_CAPABILITY_OPS, op).toContain(op);
    }
  });
});

describe("capabilityOpsOfTypes", () => {
  it("取首段、去重、升序,剔除无点/空/非字符串", () => {
    expect(
      [...capabilityOpsOfTypes(["task.submit", "task.rename", "voice.tts", "ping", "", ".x", 3, null, "sys.info"])],
    ).toEqual(["sys", "task", "voice"]);
  });

  it("不过滤未编目段(对拍要能暴露漏项)", () => {
    expect([...capabilityOpsOfTypes(["foo.bar"])]).toEqual(["foo"]);
  });

  it("空输入 → 空数组且冻结", () => {
    const out = capabilityOpsOfTypes([]);
    expect(out).toEqual([]);
    expect(Object.isFrozen(out)).toBe(true);
  });
});

describe("capabilityOpOf", () => {
  it("取第一个 . 前的段", () => {
    expect(capabilityOpOf("task.submit")).toBe("task");
    expect(capabilityOpOf("cfg.set.extra")).toBe("cfg");
  });

  it("清单内每个命名空间都能被自身的典型 type 取到", () => {
    for (const op of SERVER_CAPABILITY_OPS) expect(capabilityOpOf(`${op}.probe`), op).toBe(op);
  });

  it("无点 → null(ping/task_output 不属能力协商面)", () => {
    expect(capabilityOpOf("ping")).toBeNull();
    expect(capabilityOpOf("task_output")).toBeNull();
  });

  it("空串/首段为空 → null", () => {
    expect(capabilityOpOf("")).toBeNull();
    expect(capabilityOpOf(".submit")).toBeNull();
  });

  it("未知段 → null(foo.bar = 未编目命名空间)", () => {
    expect(capabilityOpOf("foo.bar")).toBeNull();
    expect(capabilityOpOf("voicex.tts")).toBeNull();
  });

  it("补齐后的既有通道段可取回(voice/exp/team/issue/browser/sys)", () => {
    expect(capabilityOpOf("voice.tts")).toBe("voice");
    expect(capabilityOpOf("exp.distill")).toBe("exp");
    expect(capabilityOpOf("team.p2p.send")).toBe("team");
    expect(capabilityOpOf("issue.sync")).toBe("issue");
    expect(capabilityOpOf("browser.select")).toBe("browser");
    expect(capabilityOpOf("sys.info")).toBe("sys");
  });

  it("非字符串/空值 → null,不 throw", () => {
    for (const bad of [undefined, null, 1, {}, []]) expect(capabilityOpOf(bad)).toBeNull();
  });
});

describe("healthBits", () => {
  it("只列 true 的位,顺序固定", () => {
    expect(healthBits({ ws: true, journal: true, llm: false, modelScoring: false, terminal: true, memory: false })).toEqual([
      "ws",
      "journal",
      "terminal",
    ]);
  });

  it("全 true 时顺序 = ws/journal/llm/modelScoring/terminal/memory", () => {
    expect(healthBits({ ws: true, journal: true, llm: true, modelScoring: true, terminal: true, memory: true })).toEqual([
      "ws",
      "journal",
      "llm",
      "modelScoring",
      "terminal",
      "memory",
    ]);
  });

  it("空/缺省输入 → 空数组(不臆测能力)", () => {
    expect(healthBits({})).toEqual([]);
    expect(healthBits(undefined)).toEqual([]);
    expect(healthBits(null)).toEqual([]);
  });

  it("返回冻结数组且两次结果确定相等", () => {
    const first = healthBits({ ws: true, memory: true });
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual(healthBits({ ws: true, memory: true }));
  });
});

describe("negotiateClientCapabilities", () => {
  it("探针 A:无声明 → legacy + 服务端全量 + LEGACY", () => {
    const n = negotiate(undefined);
    expect(n.mode).toBe("legacy");
    expect(n.code).toBe("LEGACY");
    expect([...n.acceptedOps]).toEqual([...SERVER_CAPABILITY_OPS]);
    expect(n.rejectedOps).toEqual([]);
    expect(n.droppedKeys).toEqual([]);
  });

  it("缺 supportedOps 的空对象 → legacy", () => {
    const n = negotiate({});
    expect(n.mode).toBe("legacy");
    expect(n.acceptedOps.length).toBe(SERVER_CAPABILITY_OPS.length);
  });

  it("supportedOps=null → 按未声明处理(legacy 全放行,不因空值打死旧客户端)", () => {
    expect(negotiate({ supportedOps: null }).mode).toBe("legacy");
  });

  it("supportedOps 非数组(坏字段)→ legacy + droppedKeys", () => {
    const n = negotiate({ supportedOps: "task" });
    expect(n.mode).toBe("legacy");
    expect(n.droppedKeys).toContain("supportedOps");
  });

  it("探针 B:声明 [task,queue] → 交集,且不含 board", () => {
    const n = negotiate({ supportedOps: ["task", "queue"] });
    expect(n.mode).toBe("negotiated");
    expect(n.code).toBe("OK");
    expect([...n.acceptedOps]).toEqual(["queue", "task"]);
    expect(n.acceptedOps).not.toContain("board");
    expect(n.rejectedOps).toEqual([]);
  });

  it("未知 op 进 rejectedOps 与 droppedKeys(探针 C)", () => {
    const n = negotiate({ supportedOps: ["task", "future.save", "nonsense.op"] });
    expect([...n.acceptedOps]).toEqual(["task"]);
    expect([...n.rejectedOps]).toEqual(["future.save", "nonsense.op"]);
    expect(n.droppedKeys).toEqual(expect.arrayContaining(["future.save", "nonsense.op"]));
    expect(n.code).toBe("OK");
  });

  it("重复 op 只保留一次并记入 droppedKeys", () => {
    const n = negotiate({ supportedOps: ["task", "task", "queue"] });
    expect([...n.acceptedOps]).toEqual(["queue", "task"]);
    expect(n.droppedKeys).toContain("task");
  });

  it("非字符串/空串条目丢弃,task 仍被接受", () => {
    const n = negotiate({ supportedOps: [123, "", "task", null] });
    expect([...n.acceptedOps]).toEqual(["task"]);
    expect(n.droppedKeys).toContain("supportedOps");
  });

  it("探针 D:声明空 supportedOps → NO_OPS,accepted 为空", () => {
    const n = negotiate({ supportedOps: [] });
    expect(n.mode).toBe("negotiated");
    expect(n.code).toBe("NO_OPS");
    expect(n.acceptedOps).toEqual([]);
  });

  it("声明全是未知 op → NO_OPS(交集为空)", () => {
    const n = negotiate({ supportedOps: ["future.op"] });
    expect(n.code).toBe("NO_OPS");
    expect([...n.rejectedOps]).toEqual(["future.op"]);
  });

  it("contractVersion 低于当前 → CONTRACT_TOO_OLD,仍按交集放行基础 op", () => {
    const n = negotiate({ supportedOps: ["task", "cfg"], contractVersion: CAPABILITY_CONTRACT_VERSION - 1 });
    expect(n.code).toBe("CONTRACT_TOO_OLD");
    expect([...n.acceptedOps]).toEqual(["cfg", "task"]);
  });

  it("contractVersion 等于当前 → OK", () => {
    expect(negotiate({ supportedOps: ["task"], contractVersion: CAPABILITY_CONTRACT_VERSION }).code).toBe("OK");
  });

  it("contractVersion 高于当前 → OK 且不放大权限(仍按当前交集)", () => {
    const n = negotiate({ supportedOps: ["task", "future.op"], contractVersion: CAPABILITY_CONTRACT_VERSION + 99 });
    expect(n.code).toBe("OK");
    expect([...n.acceptedOps]).toEqual(["task"]);
    expect(n.acceptedOps).not.toContain("future");
  });

  it("contractVersion 非数字 → 丢弃该键,按未声明版本处理", () => {
    const n = negotiate({ supportedOps: ["task"], contractVersion: "1" });
    expect(n.code).toBe("OK");
    expect(n.droppedKeys).toContain("contractVersion");
  });

  it("未知声明键丢弃且只回报键名", () => {
    const n = negotiate({ supportedOps: ["task"], legacyField: 1, extra: true });
    expect(n.droppedKeys).toEqual(expect.arrayContaining(["extra", "legacyField"]));
    expect([...n.acceptedOps]).toEqual(["task"]);
  });

  it("requiredOps 是已知键,不记入 droppedKeys", () => {
    expect(negotiate({ supportedOps: ["task"], requiredOps: ["task"] }).droppedKeys).toEqual([]);
  });

  it("结果与数组全部冻结,不改入参", () => {
    const declared = { supportedOps: ["task", "task", "future.op"], contractVersion: 1 };
    const snapshot = JSON.stringify(declared);
    const n = negotiate(declared);
    expect(Object.isFrozen(n)).toBe(true);
    expect(Object.isFrozen(n.acceptedOps)).toBe(true);
    expect(Object.isFrozen(n.rejectedOps)).toBe(true);
    expect(Object.isFrozen(n.droppedKeys)).toBe(true);
    expect(JSON.stringify(declared)).toBe(snapshot);
  });

  it("确定性:同一声明两次协商结果逐字相等", () => {
    const declared = { supportedOps: ["queue", "task", "nope.op", "task"] };
    expect(negotiate(declared)).toEqual(negotiate(declared));
  });

  it("LEGACY_NEGOTIATION 是冻结的 legacy 全量缺省值", () => {
    expect(Object.isFrozen(LEGACY_NEGOTIATION)).toBe(true);
    expect(LEGACY_NEGOTIATION.mode).toBe("legacy");
    expect([...LEGACY_NEGOTIATION.acceptedOps]).toEqual([...SERVER_CAPABILITY_OPS]);
  });
});

describe("checkDispatch", () => {
  it("legacy:已知 op 放行(旧客户端零变化)", () => {
    expect(checkDispatch({ type: "task.submit", negotiated: LEGACY_NEGOTIATION }).allow).toBe(true);
    expect(checkDispatch({ type: "cfg.set", negotiated: LEGACY_NEGOTIATION }).allow).toBe(true);
  });

  it("探针 E:未知 type foo.bar → UNKNOWN_METHOD", () => {
    const r = checkDispatch({ type: "foo.bar", negotiated: LEGACY_NEGOTIATION });
    expect(r).toEqual({ allow: false, code: "UNKNOWN_METHOD" });
  });

  it("空 type / 非字符串 / 无点 → UNKNOWN_METHOD", () => {
    expect(checkDispatch({ type: "", negotiated: LEGACY_NEGOTIATION }).code).toBe("UNKNOWN_METHOD");
    expect(checkDispatch({ type: undefined, negotiated: LEGACY_NEGOTIATION }).code).toBe("UNKNOWN_METHOD");
    expect(checkDispatch({ type: "ping", negotiated: LEGACY_NEGOTIATION }).code).toBe("UNKNOWN_METHOD");
  });

  it("negotiated:已声明 op 放行", () => {
    const n = negotiate({ supportedOps: ["task", "queue"] });
    expect(checkDispatch({ type: "task.submit", negotiated: n }).allow).toBe(true);
  });

  it("探针 F:已声明未含 cfg → cfg.set = UNSUPPORTED_OP", () => {
    const n = negotiate({ supportedOps: ["task", "queue"] });
    expect(checkDispatch({ type: "cfg.set", negotiated: n })).toEqual({ allow: false, code: "UNSUPPORTED_OP" });
  });

  it("rsi 命名空间:capabilityOpOf + 协商声明放行 / 未声明拒绝 / legacy 放行", () => {
    expect(capabilityOpOf("rsi.status")).toBe("rsi");
    const declared = negotiate({ supportedOps: ["rsi"] });
    expect([...declared.acceptedOps]).toEqual(["rsi"]);
    expect(checkDispatch({ type: "rsi.status", negotiated: declared })).toEqual({ allow: true, code: "OK" });
    const undeclared = negotiate({ supportedOps: ["task"] });
    expect(checkDispatch({ type: "rsi.status", negotiated: undeclared })).toEqual({ allow: false, code: "UNSUPPORTED_OP" });
    expect(checkDispatch({ type: "rsi.status", negotiated: LEGACY_NEGOTIATION }).allow).toBe(true);
  });

  it("NO_OPS 连接仍可自举 client.*(否则无法再协商回来)", () => {
    const n = negotiate({ supportedOps: [] });
    expect(checkDispatch({ type: "client.capabilities", negotiated: n })).toEqual({ allow: true, code: "OK" });
    expect(checkDispatch({ type: "client.mode", negotiated: n }).allow).toBe(true);
    expect(checkDispatch({ type: "task.submit", negotiated: n }).code).toBe("UNSUPPORTED_OP");
  });

  it("返回对象冻结,且错误码字面量与线上字符串一致", () => {
    const r = checkDispatch({ type: "foo.bar", negotiated: LEGACY_NEGOTIATION });
    expect(Object.isFrozen(r)).toBe(true);
    expect(DISPATCH_ERROR_CODES.unknownMethod).toBe("unknown-method");
    expect(DISPATCH_ERROR_CODES.unsupportedOp).toBe("unsupported-op");
  });
});

describe("describeCapabilities", () => {
  it("一行摘要含协商码且 ≤200 字", () => {
    const text = describeCapabilities(negotiate({ supportedOps: ["task"] }));
    expect(text).toContain("code=OK");
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).not.toContain("\n");
  });

  it("legacy 摘要标注全量放行", () => {
    expect(describeCapabilities(LEGACY_NEGOTIATION)).toContain("legacy");
  });
});
