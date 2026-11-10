/**
 * teamai 门面三件套接线测试(designs/30 §2.3/2.4/2.6):
 * ① 协议契约:teamai.inspect / contribute / remove 已进 ClientMessage 联合(parseClientMessage 实测);
 * ② TeamView 转发面:contribute/remove 在 client ready 时向 relay 发对应帧,未 ready 返回 false;
 * ③ 回包分发:relay.teamai.{contribute,remove}.result 到达时各自监听器被调、参数一致,
 *    且不与 pushListeners 串包(designs/30 三通道分流的回归护栏)。
 * 不涉及真实网络/端口:TeamRelayClient 用 vi.mock 换成最小假 client。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseClientMessage } from "@lampgenie/protocol";

// ---- 假 relay client:记录 wsSend、暴露 ready 开关与 onMessage 触发入口 ----
// vi.mock 工厂被提升到文件顶部,故共享容器走 vi.hoisted;mock 类自身即假 client(业务侧持有同一实例)。
const h = vi.hoisted(() => ({ fakes: [] as unknown[] }));

interface FakeClient {
  ready: boolean;
  sent: Record<string, unknown>[];
  connect(): void;
  close(): void;
  wsSend(msg: Record<string, unknown>): void;
  sendPresence(): void;
  /** 模拟 relay 下行一帧(驱动 TeamView.handle 分发)。 */
  emit(m: Record<string, unknown>): void;
}

vi.mock("@lampgenie/runtime/team/relay-client", () => ({
  TeamRelayClient: class {
    ready = false;
    sent: Record<string, unknown>[] = [];
    private readonly onMessage?: (m: unknown) => void;
    constructor(opts: { onMessage?: (m: unknown) => void }) {
      this.onMessage = opts.onMessage;
      h.fakes.push(this);
    }
    connect(): void { /* 不建连(零网络) */ }
    close(): void { /* noop */ }
    wsSend(msg: Record<string, unknown>): void {
      if (!this.ready) return; // 真实现同样 ready 才发
      this.sent.push(msg);
    }
    sendPresence(): void { /* noop */ }
    emit(m: Record<string, unknown>): void {
      this.onMessage?.({ v: 1, ...m });
    }
  },
}));

/** 取 TeamView 内部为某 url 建的假 client。 */
function fakeAt(i = 0): FakeClient { return h.fakes[i] as FakeClient; }

const RELAY_URL = "sim-relay://local";

async function makeView() {
  const { TeamView } = await import("../src/team-view.js");
  h.fakes.length = 0;
  const view = new TeamView({ urls: [RELAY_URL], identityDir: "/tmp/does-not-matter" });
  view.stop();
  return { view, fake: fakeAt(0) };
}

beforeEach(() => { h.fakes.length = 0; });

describe("① 协议契约:三条门面消息已在 ClientMessage 联合里", () => {
  it("teamai.inspect 无参数即可解析", () => {
    const m = parseClientMessage(JSON.stringify({ v: 1, type: "teamai.inspect" }));
    expect(m?.type).toBe("teamai.inspect");
  });

  it("teamai.contribute 解析出 title/body/tags/project", () => {
    const m = parseClientMessage(JSON.stringify({ v: 1, type: "teamai.contribute", title: "t", body: "b", tags: ["x"], project: "lampgenie-harness" }));
    expect(m).toMatchObject({ type: "teamai.contribute", title: "t", body: "b", tags: ["x"], project: "lampgenie-harness" });
  });

  it("teamai.remove 解析出 kind/ns/name", () => {
    const m = parseClientMessage(JSON.stringify({ v: 1, type: "teamai.remove", kind: "rule", ns: "common", name: "style" }));
    expect(m).toMatchObject({ type: "teamai.remove", kind: "rule", ns: "common", name: "style" });
  });

  it("teamai.push 增 kind 透传,且旧形态(不带 kind)仍合法", () => {
    const withKind = parseClientMessage(JSON.stringify({ v: 1, type: "teamai.push", name: "n", body: "b", kind: "doc" }));
    expect((withKind as { kind?: string } | null)?.kind).toBe("doc");
    const legacy = parseClientMessage(JSON.stringify({ v: 1, type: "teamai.push", name: "n", body: "b" }));
    expect(legacy?.type).toBe("teamai.push");
    expect((legacy as { kind?: string } | null)?.kind).toBeUndefined();
  });

  it("inspect 分支的数据源(runtime 三个门面函数)实测可调用", async () => {
    const b = await import("@lampgenie/runtime/team/teamai-bridge");
    expect(typeof b.teamaiList).toBe("function");
    expect(typeof b.teamaiStatus).toBe("function");
    expect(typeof b.teamaiDoctor).toBe("function");
    const list = b.teamaiList({ skills: [{ ns: "common", name: "debug" }], rules: [{ name: "security" }], docs: ["a.md"], learnings: [{ path: "l.md" }] } as never);
    expect(list).toContainEqual({ kind: "skill", name: "debug", ns: "common" });
    expect(list).toContainEqual({ kind: "rule", name: "security" });
  });
});

describe("② TeamView 转发:ready 才发帧,未 ready 返回 false", () => {
  it("teamaiContribute:ready 时发 relay.teamai.contribute", async () => {
    const { view, fake } = await makeView();
    expect(view.teamaiContribute(RELAY_URL, { title: "t", body: "b", tags: ["a"] })).toBe(false); // 未 ready

    fake.ready = true;
    expect(view.teamaiContribute(RELAY_URL, { title: "t", body: "b", tags: ["a"] })).toBe(true);
    expect(fake.sent.at(-1)).toEqual({ v: 1, type: "relay.teamai.contribute", title: "t", body: "b", tags: ["a"] });
  });

  it("teamaiRemove:ready 时发 relay.teamai.remove", async () => {
    const { view, fake } = await makeView();
    expect(view.teamaiRemove(RELAY_URL, { kind: "skill", ns: "common", name: "debug" })).toBe(false);

    fake.ready = true;
    expect(view.teamaiRemove(RELAY_URL, { kind: "skill", ns: "common", name: "debug" })).toBe(true);
    expect(fake.sent.at(-1)).toEqual({ v: 1, type: "relay.teamai.remove", kind: "skill", ns: "common", name: "debug" });
  });

  it("未知 org = false(不误发到别的 org)", async () => {
    const { view } = await makeView();
    expect(view.teamaiContribute("sim-relay://other", { title: "t", body: "b" })).toBe(false);
    expect(view.teamaiRemove("sim-relay://other", { kind: "doc", name: "x" })).toBe(false);
  });

  it("teamaiPush 透传 kind(向后兼容:不给 kind 时不带该字段)", async () => {
    const { view, fake } = await makeView();
    fake.ready = true;
    view.teamaiPush(RELAY_URL, { ns: "common", name: "n", description: "", body: "b", kind: "rule" });
    expect(fake.sent.at(-1)).toMatchObject({ type: "relay.teamai.push", kind: "rule" });
    view.teamaiPush(RELAY_URL, { ns: "common", name: "n", description: "", body: "b" });
    expect(fake.sent.at(-1)).not.toHaveProperty("kind");
  });
});

describe("③ 回包分发:三条结果通道互不串包", () => {
  it("relay.teamai.contribute.result → contributeListeners,参数一致", async () => {
    const { view, fake } = await makeView();
    const onC = vi.fn();
    const onP = vi.fn();
    view.onContributeResult(onC);
    view.onPushResult(onP);

    fake.emit({ type: "relay.teamai.contribute.result", ok: true, branch: "learnings/u/1", path: "learnings/u/1.md" });
    expect(onC).toHaveBeenCalledTimes(1);
    expect(onC.mock.calls[0]![0]).toMatchObject({ ok: true, branch: "learnings/u/1", path: "learnings/u/1.md" });
    expect(onP).not.toHaveBeenCalled(); // push 通道不受影响

    view.offContributeResult(onC);
    fake.emit({ type: "relay.teamai.contribute.result", ok: false, reason: "invalid" });
    expect(onC).toHaveBeenCalledTimes(1); // 已退订
    view.stop();
  });

  it("relay.teamai.remove.result → removeListeners,参数一致", async () => {
    const { view, fake } = await makeView();
    const onR = vi.fn();
    const onC = vi.fn();
    view.onRemoveResult(onR);
    view.onContributeResult(onC);

    fake.emit({ type: "relay.teamai.remove.result", ok: true, path: "rules/common/style.md" });
    expect(onR).toHaveBeenCalledTimes(1);
    expect(onR.mock.calls[0]![0]).toMatchObject({ ok: true, path: "rules/common/style.md" });
    expect(onC).not.toHaveBeenCalled();

    view.offRemoveResult(onR);
    fake.emit({ type: "relay.teamai.remove.result", ok: false, reason: "not-found" });
    expect(onR).toHaveBeenCalledTimes(1);
    view.stop();
  });

  it("push 结果仍只到 pushListeners(新增通道未抢既有分发)", async () => {
    const { view, fake } = await makeView();
    const onP = vi.fn();
    const onR = vi.fn();
    view.onPushResult(onP);
    view.onRemoveResult(onR);
    fake.emit({ type: "relay.teamai.push.result", ok: true, branch: "teamai/push/u/1" });
    expect(onP).toHaveBeenCalledTimes(1);
    expect(onR).not.toHaveBeenCalled();
    view.stop();
  });
});
