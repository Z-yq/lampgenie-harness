/**
 * chat-render-p1.spec.cjs 的 vitest 规范化 runner(同 slash.spec.test.ts 口径):
 * spec 本体是 node 直跑的 chromium 探针(自带 PASS/FAIL 输出),须子进程 `--import tsx` 跑;
 * 每个 P1 项独立 spawn(ITEM=<id>),断言退出码 0 且 stdout 无 FAIL 行。
 * 无 chrome 环境整文件 skip 并如实标注原因(不伪装通过)。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "/usr/bin/google-chrome";
const hasChrome = existsSync(CHROME);
const maybe = hasChrome ? describe : describe.skip;
const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 已知缺口清单:当前为空 —— P1-8 的 .task-cap 样式缺口(page-css.ts 缺 sticky/z-index)在编写期经验证
 * position=static,随后由 page-css 专职 agent 落地(page-css.ts:3584 .task-cap{position:sticky;z-index:20}),
 * 复跑后 P1-8 全绿,故不放行任何 FAIL。留此机制以便后续同类缺口显式登记而非静默放过。
 */
const KNOWN_GAPS: Record<string, string[]> = {};

function runItem(id: string) {
  let out = "";
  let status = 0;
  try {
    out = execFileSync(process.execPath, ["--import", "tsx", "test/ui/chat-render-p1.spec.cjs"], {
      cwd: gatewayDir,
      timeout: 180_000,
      encoding: "utf8",
      env: { ...process.env, ITEM: id },
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; message: string };
    status = err.status ?? -1;
    out = String(err.stdout ?? "");
    if (!out) throw new Error(`chat-render-p1.spec.cjs(${id}) 无 stdout:status=${status} ${err.message.slice(0, 300)}`);
  }
  const fails = out.split("\n").filter((l) => l.startsWith("FAIL ")).map((l) => l.slice(5).split(" — ")[0].trim());
  const allowed = KNOWN_GAPS[id] ?? [];
  const real = fails.filter((f) => !allowed.includes(f));
  expect(real, `${id} 出现非已知缺口 FAIL:\n${out.slice(-3000)}`).toEqual([]);
 // 退出码:无 FAIL → 0;有 FAIL 且全在已知缺口清单 → 1(探针的 check 失败即 exit 1);其余已在上一条断言炸掉。
  const expected = fails.length === 0 ? 0 : 1;
  expect(status, `${id} 进程退出码:\n${out.slice(-1500)}`).toBe(expected);
  expect(out, `${id} 应至少跑过一条断言`).toMatch(/^(PASS|FAIL) /m);
}

maybe("chat-render-p1.spec.cjs(node --import tsx 直跑 chromium 探针,逐项 ITEM)", () => {
  it("P1-1 侧栏悬停富浮层(单例 #bhHoverCard 出现/内容/等宽/不越视口/离开即隐藏)", () => runItem("P1-1"), 200_000);
  it("P1-2 正文密度(--lh-body 单一定义 + 行高/字距/段间距真实计算值)", () => runItem("P1-2"), 200_000);
  it("P1-3 用户气泡与回复 margin/气泡盒 padding·圆角·最大宽", () => runItem("P1-3"), 200_000);
  it("P1-4 表格整格状态徽标(.md-badge + st-* + 三态异色 + 长句不套 + td code mono)", () => runItem("P1-4"), 200_000);
  it("P1-5 斜杠菜单双行排版/默认选中/ArrowDown/Escape/空态主提示", () => runItem("P1-5"), 200_000);
  it("P1-6 编辑调用聚合(.msg-sum N 个文件 + /- 与逐条求和一致 + 弹窗行数)", () => runItem("P1-6"), 200_000);
  it("P1-7 消息操作栏(.msg-acts 恒在 + HH:MM + 复制/引用真剪贴板)", () => runItem("P1-7"), 200_000);
  it("P1-8 任务级 sticky 胶囊(状态/终态去计时;CSS 规则缺失 3 条为已知缺口)", () => runItem("P1-8"), 200_000);
});