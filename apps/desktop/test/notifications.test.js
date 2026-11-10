const test = require("node:test");
const assert = require("node:assert/strict");
const { createNotificationController, DEDUPE_WINDOW_MS } = require("../notifications");

class FakeNotification {
  static supported = true;
  static instances = [];
  static isSupported() {
    return FakeNotification.supported;
  }
  constructor(opts) {
    this.opts = opts;
    this.listeners = new Map();
    this.shown = 0;
    FakeNotification.instances.push(this);
  }
  once(event, cb) {
    this.listeners.set(event, cb);
  }
  emit(event) {
    const cb = this.listeners.get(event);
    if (cb) cb();
  }
  show() {
    this.shown += 1;
  }
}

function makeController(overrides = {}) {
  FakeNotification.instances = [];
  FakeNotification.supported = true;
  const state = { focused: false, focusedCalls: 0, sent: [] };
  const ctrl = createNotificationController({
    Notification: FakeNotification,
    isWindowFocused: () => state.focused,
    focusWindow: () => { state.focusedCalls += 1; },
    sendToRenderer: (ch, payload) => state.sent.push({ ch, payload }),
    now: () => overrides.now ? overrides.now() : Date.now(),
    log: () => undefined,
    ...overrides,
  });
  return { ctrl, state };
}

test("窗口有焦点时不打扰;失焦时弹原生通知且 silent", () => {
  const { ctrl, state } = makeController();
  state.focused = true;
  assert.equal(ctrl.show({ title: "任务完成", body: "x", taskId: "t1", status: "done" }), false);
  assert.equal(FakeNotification.instances.length, 0);

  state.focused = false;
  assert.equal(ctrl.show({ title: "任务完成", body: "x", taskId: "t1", status: "done" }), true);
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(FakeNotification.instances[0].opts.silent, true);
  assert.equal(FakeNotification.instances[0].shown, 1);
  assert.equal(ctrl.activeCount(), 1);
});

test("3s 去重(同 status+taskId);超窗后允许再次通知", () => {
  let now = 1000;
  const { ctrl, state } = makeController({ now: () => now });
  state.focused = false;
  assert.equal(ctrl.show({ title: "任务完成", body: "x", taskId: "t1", status: "done" }), true);
  now += DEDUPE_WINDOW_MS - 1;
  assert.equal(ctrl.show({ title: "任务完成", body: "x", taskId: "t1", status: "done" }), false);
  now += 2;
  assert.equal(ctrl.show({ title: "任务完成", body: "x", taskId: "t1", status: "done" }), true);
  // 不同任务/状态不受影响
  assert.equal(ctrl.show({ title: "任务失败", body: "x", taskId: "t1", status: "failed" }), true);
  assert.equal(ctrl.show({ title: "任务完成", body: "x", taskId: "t2", status: "done" }), true);
});

test("click:恢复窗口 + 回传渲染进程,并释放持有对象", () => {
  const { ctrl, state } = makeController();
  state.focused = false;
  ctrl.show({ title: "任务完成", body: "x", taskId: "t9", status: "done" });
  const n = FakeNotification.instances[0];
  n.emit("click");
  assert.equal(state.focusedCalls, 1);
  assert.deepEqual(state.sent, [{ ch: "genie:notification-click", payload: { taskId: "t9", status: "done" } }]);
  assert.equal(ctrl.activeCount(), 0);
});

test("空文案/平台不支持/构造失败都返回 false,不抛", () => {
  const { ctrl } = makeController();
  assert.equal(ctrl.show({ title: "", body: "x" }), false);
  assert.equal(ctrl.show({ title: "x", body: "" }), false);
  FakeNotification.supported = false;
  assert.equal(ctrl.show({ title: "x", body: "y" }), false);
  FakeNotification.supported = true;
  const broken = createNotificationController({
    Notification: class { constructor() { throw new Error("boom"); } },
    isWindowFocused: () => false,
  });
  assert.equal(broken.show({ title: "x", body: "y" }), false);
});

test("超过上限丢最旧,活跃集合有界", () => {
  const { ctrl, state } = makeController();
  state.focused = false;
  for (let i = 0; i < 120; i++) {
    ctrl.show({ title: "任务完成", body: "x", taskId: "t" + i, status: "done" });
  }
  assert.ok(ctrl.activeCount() <= 100);
});