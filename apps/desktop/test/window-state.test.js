const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  resolveWindowState,
  readWindowState,
  writeWindowState,
  attachWindowStatePersistence,
  ZOOM_MIN_LEVEL,
  ZOOM_MAX_LEVEL,
} = require("../window-state");

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "ws-"));
}

test("resolveWindowState:无持久化 → 默认尺寸/未最大化/缩放 0", () => {
  const s = resolveWindowState(null, { width: 1920, height: 1080 });
  assert.deepStrictEqual(s, { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT, maximized: false, zoomLevel: 0 });
});

test("resolveWindowState:小于最小尺寸 → 夹到最小;超过工作区 → 夹到工作区", () => {
  const small = resolveWindowState({ width: 300, height: 200 }, { width: 1920, height: 1080 });
  assert.strictEqual(small.width, 960);
  assert.strictEqual(small.height, 640);
  const big = resolveWindowState({ width: 3000, height: 2000 }, { width: 1280, height: 720 });
  assert.strictEqual(big.width, 1280);
  assert.strictEqual(big.height, 720);
});

test("resolveWindowState:非法值走兜底,工作区缺省只夹最小", () => {
  const s = resolveWindowState({ width: "abc", height: NaN, zoomLevel: "x" }, null);
  assert.strictEqual(s.width, DEFAULT_WINDOW_WIDTH);
  assert.strictEqual(s.height, DEFAULT_WINDOW_HEIGHT);
  assert.strictEqual(s.zoomLevel, 0);
});

test("resolveWindowState:缩放级别夹取 [-3,5] 并四舍五入", () => {
  assert.strictEqual(resolveWindowState({ zoomLevel: 99 }).zoomLevel, ZOOM_MAX_LEVEL);
  assert.strictEqual(resolveWindowState({ zoomLevel: -99 }).zoomLevel, ZOOM_MIN_LEVEL);
  assert.strictEqual(resolveWindowState({ zoomLevel: 2.6 }).zoomLevel, 3);
});

test("readWindowState/writeWindowState:原子写 + 损坏文件返回 null", () => {
  const dir = tmpDir();
  try {
    const f = join(dir, "sub", "window-state.json");
    assert.strictEqual(writeWindowState(f, { width: 1200, height: 800, maximized: true, zoomLevel: 2 }), true);
    assert.deepStrictEqual(readWindowState(f), { width: 1200, height: 800, maximized: true, zoomLevel: 2 });
    writeFileSync(f, "{broken", "utf-8");
    assert.strictEqual(readWindowState(f), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeWindow({ bounds = { width: 1100, height: 800 }, maximized = false } = {}) {
  const w = new EventEmitter();
  w.destroyed = false;
  w.isDestroyed = () => w.destroyed;
  w.getNormalBounds = () => ({ x: 0, y: 0, ...bounds });
  w.isMaximized = () => maximized;
  return w;
}

test("attach:最大化时保存的是 normal bounds,不是工作区尺寸", () => {
  const dir = tmpDir();
  try {
    const f = join(dir, "w.json");
    const win = fakeWindow({ bounds: { width: 1100, height: 760 }, maximized: true });
    const h = attachWindowStatePersistence(win, { file: f, debounceMs: 5, getZoomLevel: () => 3 });
    win.emit("maximize");
    const saved = JSON.parse(readFileSync(f, "utf-8"));
    assert.deepStrictEqual(saved, { width: 1100, height: 760, maximized: true, zoomLevel: 3 });
    h.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attach:resize 防抖只落一次;persistNow 立即写;销毁后不再写", async () => {
  const dir = tmpDir();
  try {
    const f = join(dir, "w.json");
    const win = fakeWindow();
    const h = attachWindowStatePersistence(win, { file: f, debounceMs: 15 });
    win.emit("resize");
    win.emit("resize");
    win.emit("resize");
    await new Promise((r) => setTimeout(r, 60));
    const first = JSON.parse(readFileSync(f, "utf-8"));
    assert.strictEqual(first.width, 1100);
    win.destroyed = true;
    h.persistNow();
    assert.deepStrictEqual(JSON.parse(readFileSync(f, "utf-8")), first);
    h.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});