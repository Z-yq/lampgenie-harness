import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// 追踪 Trace 轮询存活守卫(用户用户反馈:「任务都完成了,但追踪 trace 看板的数据却没有」)。
// 根因两条,都在 panel.ts 的 trackLiveTick / trackRender:
// ①在场判定用 elv.classList.contains("on")——画布形态下视图节点恒可见且从不挂 .on
//   (canvas-shell 用 `body.cv-shell .cv-card-body>.view{display:flex!important}` 覆盖显隐),
//   第一次 tick 就 return → 轮询彻底停摆,卡停在首拉快照(截图:turn 只到「02 规划」,
//   03 实施/04 验收/05 完成 全显示「未声明」,而任务早已 done)。
// ②不可见时 return 终止轮询链(不续约)→ 之后即使回到卡上也不自愈。
// 本测试把 trackLiveTick 抽出来在 vm 里真跑:画布形态(视图无 .on)下必须仍发 track.view,
// 不可见时必须续约(下个 tick 仍会触发),且脚本语法合法。

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/panel.ts"), "utf-8");

/** 从源码里按括号配平抽出一个顶层函数体(panel.ts 是单文件内嵌脚本,索引不可见,只能源码切)。 */
function extractFn(code: string, name: string): string {
  const start = code.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`未找到 function ${name}`);
  let i = code.indexOf("{", start);
  let depth = 0;
  for (; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} 括号不配平`);
}

const tickSrc = extractFn(src, "trackLiveTick");

type Sandbox = Record<string, unknown>;
/** 在隔离沙箱里跑一次 trackLiveTick 设定的 setTimeout 回调,返回本次是否发起了 trackPull 与是否续约。
 *  续约判据=回调返回后排期次数增加(函数内递归调用 trackLiveTick 会再排一次;若 return 掉就不排)。 */
function runOneTick(opts: { live: boolean | "throw"; hasOnClass: boolean }): { pulled: number; rescheduled: boolean } {
  const pulls: number[] = [];
  let scheduleCount = 0;
  let firstTick: ((...a: unknown[]) => void) | null = null;
  const el = { classList: { contains: (c: string) => opts.hasOnClass && c === "on" } };
  const sandbox: Sandbox = {
    trackTimer: null,
    trackPull: () => { pulls.push(Date.now()); },
    $: (id: string) => (id === "view-track" ? el : null),
    viewLive: (n: string) => {
      if (opts.live === "throw") throw new Error("CanvasShell 未加载");
      return n === "track" ? opts.live : false;
    },
    setTimeout: (fn: () => void) => {
      scheduleCount++;
      if (!firstTick) firstTick = fn;
      return 1;
    },
    clearTimeout: () => { /* noop */ },
    console: { warn: () => { /* noop */ } },
  };
  const script = new Script(`(function(){ ${tickSrc}\n trackLiveTick(); })()`);
  script.runInNewContext(sandbox);
  expect(firstTick, "trackLiveTick 未排期 tick").not.toBeNull();
  const before = scheduleCount;
  (firstTick as unknown as () => void)();
  return { pulled: pulls.length, rescheduled: scheduleCount > before };
}

describe("追踪 Trace:轮询存活守卫", () => {
  it("画布形态(视图节点没有 .on 类,但 viewLive=true)仍必须拉取并续约", () => {
    const r = runOneTick({ live: true, hasOnClass: false });
    expect(r.pulled, "画布形态下没发 track.view——轮询停摆回归").toBe(1);
    expect(r.rescheduled, "拉取后没有续约,轮询链断了").toBe(true);
  });

  it("经典形态(.on 在场)照旧拉取", () => {
    const r = runOneTick({ live: true, hasOnClass: true });
    expect(r.pulled).toBe(1);
    expect(r.rescheduled).toBe(true);
  });

  it("不可见时跳过拉取但不终止轮询(必须续约,回到卡上能自愈)", () => {
    const r = runOneTick({ live: false, hasOnClass: false });
    expect(r.pulled, "不可见时不该拉取").toBe(0);
    expect(r.rescheduled, "不可见时 return 不续约=永久停摆").toBe(true);
  });

  it("viewLive 抛错(画布资产未加载)时回落经典判定,不炸", () => {
    const r = runOneTick({ live: "throw", hasOnClass: true });
    expect(r.pulled).toBe(1);
    expect(r.rescheduled).toBe(true);
  });

  it("trackRender 的轮询续约在 noSession early-return 之前(首拉无会话也能自愈)", () => {
    const renderSrc = extractFn(src, "trackRender");
    const noSessionAt = renderSrc.indexOf("m.noSession");
    const tickAt = renderSrc.indexOf("trackLiveTick()");
    expect(noSessionAt, "trackRender 里找不到 noSession 分支").toBeGreaterThan(-1);
    expect(tickAt, "trackRender 里找不到 trackLiveTick 调用").toBeGreaterThan(-1);
    expect(tickAt, "trackLiveTick 必须在 noSession 分支之前调用,否则无会话首拉后轮询永不启动").toBeLessThan(noSessionAt);
  });

  it("B2 auto-advanced:task.phase(auto:true) 的 note 渲染为「自动推进」正常态标记,不算 skip", () => {
 // B2:板含内容节点→phase 自动置 plan。消费面契约:trackRender 三级节点对
    // auto:true 显示「自动推进」徽标(正常流转),与 skipped(跳过,灰斜体)互斥;
    // 五阶段轨迹条(phStrip)对 auto 显示「自」字。此处 vm 真跑 trackRender 断言 DOM。
    const renderSrc = extractFn(src, "trackRender");
    const captured: string[] = [];
    const el = { set innerHTML(v: string) { captured.push(v); }, get innerHTML() { return captured[captured.length - 1] ?? ""; } };
    const sandbox: Sandbox = {
      $: (id: string) => (id === "track-body" ? el : null),
      trackLiveTick: () => { /* noop */ },
      trackFilter: "all",
      trackListSkipped: 0,
      esc: (s: unknown) => String(s ?? ""),
      clip: (s: unknown) => String(s ?? ""),
      PHASE_CN: { understand: "理解", plan: "规划", implement: "实施", verify: "验收", close: "完成" },
    };
    const msg = {
      turns: [{
        turn: 1, no: 1, at: 1, userText: "做个功能", taskId: "t1", reasons: [],
        phases: {
          understand: [{ note: "摸边界", at: 1, skipped: false }],
          plan: [{ note: "板含内容节点,自动置规划", at: 2, skipped: false, auto: true }],
        },
      }],
      taskStates: { t1: "done" },
    };
    const script = new Script(`(function(){ ${renderSrc}\n trackRender(m); })()`);
    const ctx = { ...sandbox, m: msg };
    script.runInNewContext(ctx);
    const html = captured[captured.length - 1] ?? "";
    expect(html, "trackRender 未渲染").toContain("任务");
    expect(html, "auto note 必须带自动推进徽标").toContain("自动推进");
    expect(html, "auto note 不得标成跳过样式").not.toContain("tk-note-skip\">板含内容节点");
    // 五阶段 hint:plan 阶段 1 条任务(不因 auto 计为跳过)
    expect(html).toContain("1 条任务");
  });
});
