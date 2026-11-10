/**
 * 窗口状态持久化(设计参考 ZCode 项目,致谢;本仓独立实现)。
 *
 * 为什么需要:桌面壳固定 1440×900,用户每次调过的尺寸/位置/最大化状态/页面缩放,重启就丢。
 * ZCode 的两条关键约束原样保留:
 *   ① 最大化时持久化必须读 getNormalBounds(),否则会把「最后一次手动尺寸」覆盖成整块工作区;
 *   ② resize 高频触发(Windows/Linux 拖拽),防抖 250ms 再落盘,避免每次拖拽都写文件。
 *
 * 纯逻辑 + 只有一个 JSON 小文件;不 require electron(可 node --test 单测)。
 */
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const DEFAULT_WINDOW_WIDTH = 1440;
const DEFAULT_WINDOW_HEIGHT = 900;
const MIN_WINDOW_WIDTH = 960;
const MIN_WINDOW_HEIGHT = 640;
const ZOOM_MIN_LEVEL = -3;
const ZOOM_MAX_LEVEL = 5;
const PERSIST_DEBOUNCE_MS = 250;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampZoomLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(ZOOM_MAX_LEVEL, Math.max(ZOOM_MIN_LEVEL, Math.round(n)));
}

/**
 * 解析持久化状态并按当前显示器工作区夹取。
 * workArea 可缺省(拿不到显示器信息时只做最小尺寸/缩放夹取)。
 */
function resolveWindowState(persisted, workArea) {
  const p = persisted && typeof persisted === "object" ? persisted : {};
  const maxW = workArea && Number.isFinite(Number(workArea.width)) ? Number(workArea.width) : Number.POSITIVE_INFINITY;
  const maxH = workArea && Number.isFinite(Number(workArea.height)) ? Number(workArea.height) : Number.POSITIVE_INFINITY;
  return {
    width: Math.min(maxW, clampNumber(p.width, MIN_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, maxW), DEFAULT_WINDOW_WIDTH)),
    height: Math.min(maxH, clampNumber(p.height, MIN_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, maxH), DEFAULT_WINDOW_HEIGHT)),
    maximized: p.maximized === true,
    zoomLevel: clampZoomLevel(p.zoomLevel),
  };
}

function readWindowState(file) {
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 原子写(tmp+rename);任何失败静默(窗口状态不值得让启动链报错)。 */
function writeWindowState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${Date.now()}-${process.pid}.window-state.tmp`);
    writeFileSync(tmp, JSON.stringify(state), "utf-8");
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 挂持久化监听:resize 防抖,最大化/还原/关闭立即落盘。
 * getZoomLevel 由调用方提供(页面缩放级别不在 BrowserWindow 上,单一事实源留在 main.js)。
 * 返回 { persistNow, dispose } 供退出前同步落盘。
 */
function attachWindowStatePersistence(win, opts = {}) {
  const file = opts.file;
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : PERSIST_DEBOUNCE_MS;
  const getZoomLevel = typeof opts.getZoomLevel === "function" ? opts.getZoomLevel : () => 0;
  const onError = typeof opts.onError === "function" ? opts.onError : () => {};
  let timer = null;
  let disposed = false;

  function snapshot() {
    if (!win || win.isDestroyed()) return null;
    const b = win.getNormalBounds();
    return {
      width: Math.max(MIN_WINDOW_WIDTH, Math.floor(b.width)),
      height: Math.max(MIN_WINDOW_HEIGHT, Math.floor(b.height)),
      maximized: win.isMaximized(),
      zoomLevel: clampZoomLevel(getZoomLevel()),
    };
  }

  function save() {
    const state = snapshot();
    if (!state) return;
    try {
      if (!writeWindowState(file, state)) onError(new Error("write window-state failed"));
    } catch (err) {
      onError(err);
    }
  }

  function persistNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    save();
  }

  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; save(); }, debounceMs);
  };

  if (win && typeof win.on === "function") {
    win.on("resize", schedule);
    win.on("maximize", persistNow);
    win.on("unmaximize", persistNow);
    win.on("close", persistNow);
  }

  return {
    persistNow,
    dispose() {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

module.exports = {
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  ZOOM_MIN_LEVEL,
  ZOOM_MAX_LEVEL,
  resolveWindowState,
  readWindowState,
  writeWindowState,
  attachWindowStatePersistence,
};