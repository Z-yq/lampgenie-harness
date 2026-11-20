/**
 * popover-lifecycle.spec.cjs 的 vitest 规范化 runner(浮窗生命周期治理四态语义)。
 * 形态同 panel-chat-render-p0.test.ts:spec 本体是 node 直跑的 chromium 探针(自带 PASS/FAIL 输出),
 * `require("../../src/panel.ts")` 是 TS——node 直跑必须 `--import tsx`。这里逐项子进程直跑(ITEM 选一项),
 * 断言退出码 0 且 stdout 无 "FAIL "。无 headless chrome → 整文件 skip 并如实标注;
 * 另附 vm 层兜底(不依赖 chrome:直接断言源码治理接线齐全——注册表函数与 5 个浮窗的接入点都在生成 JS 里)。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "/usr/bin/google-chrome";
const hasChrome = existsSync(CHROME);
const maybe = hasChrome ? describe : describe.skip;

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // apps/gateway

function runSpec(item: string): string {
  let out = "";
  try {
    out = execFileSync(process.execPath, ["--import", "tsx", "test/ui/popover-lifecycle.spec.cjs"], {
      cwd: gatewayDir,
      timeout: 150_000,
      encoding: "utf8",
      env: { ...process.env, ITEM: item },
    });
  } catch (e) {
    const err = e as { status?: number; signal?: string; stdout?: string; stderr?: string; message: string };
    throw new Error(
      `${item} 探针失败:status=${err.status} signal=${err.signal}\n` +
        `stdout 尾部:\n${String(err.stdout ?? "").slice(-3000)}\n` +
        `stderr 尾部:\n${String(err.stderr ?? "").slice(-1500)}\nmessage:${err.message.slice(0, 300)}`,
    );
  }
  return out;
}

const CASES = ["ctx", "task", "sel", "mention", "slash"] as const;

maybe("popover-lifecycle.spec.cjs(node --import tsx 直跑 chromium 探针,逐项)", () => {
  for (const item of CASES) {
    it(`${item} 四态语义探针退出码 0 且无 FAIL`, () => {
      const out = runSpec(item);
      expect(out, `${item} stdout 应至少有一条 PASS:\n` + out.slice(-2000)).toContain("PASS ");
      expect(out, `${item} stdout 应无 FAIL 行,实际:\n` + out.slice(-3000)).not.toContain("FAIL ");
    }, 180_000);
  }
});

/** vm 层兜底(chrome 缺席也跑):治理接线齐全性——集中注册表 + 5 个浮窗接入点都真实落在生成页面脚本里。
 * 这不证明行为(行为由 chromium 探针证明),只证明接线没有被拼接/转义环节丢掉。 */
describe("popover 治理接线(vm 层源码兜底,无 chrome 依赖)", () => {
  const panelDir = join(gatewayDir, "src", "panel");
  const read = (f: string) => readFileSync(join(panelDir, f), "utf8");
  const dialogs = read("script-dialogs.ts");
  const views = read("script-views.ts");
  const iconsSidebar = read("script-icons-sidebar.ts");
  const submit = read("script-submit.ts");
  const voiceCite = read("script-voice-cite.ts");
  const commands = read("script-commands.ts");

  it("集中注册表:doc pointerdown 外点 + keydown Esc + 开新收旧 + stale 剪枝都在", () => {
    expect(dialogs).toContain("function popoverOpen(key, close, keep, el, carrier)");
    expect(dialogs).toContain("popoverCloseAll(except)"); // 开新收旧
    expect(dialogs).toContain('document.addEventListener("pointerdown"');
    expect(dialogs).toContain('document.addEventListener("keydown"'); // doc 级 Esc
    expect(dialogs).toContain("function popoverPrune()"); // 内部通道关掉后清 stale 条目
    expect(dialogs).toContain('"taskMenu", "selMenu", "mentionMenu", "slashMenu", "ctxPill"');
  });

  it("ctxPill:二点 toggle 守卫 + popoverOpen 接入(不叠实例)", () => {
    expect(views).toContain('if (pillMenuEl) { pillMenuClose(); return; } // 二点=收起');
    expect(views).toContain('popoverOpen("ctxPill"');
  });

  it("taskMenu/selMenu:打开点登记 + 旧外点通道改为注销登记", () => {
    expect(iconsSidebar).toContain('popoverSyncEl("taskMenu", true, "#taskMenu")');
    expect(iconsSidebar).toContain('popoverSyncEl("taskMenu", false, "#taskMenu")');
    expect(submit).toContain('popoverSyncEl("selMenu", true, "#selMenu")');
    expect(submit).toContain('popoverSyncEl("selMenu", false, "#selMenu")');
  });

  it("mentionMenu/slashMenu:开合双向同步(外点即关,输入框豁免)", () => {
    expect(voiceCite).toContain('popoverSyncEl("mentionMenu", true, "#instruction")');
    expect(voiceCite).toContain('popoverSyncEl("mentionMenu", false, "#mentionMenu")');
    expect(commands).toContain("function slashSyncPop()");
    expect(commands).toContain("slashSyncPop();");
  });

  it("模板层坑守卫:治理代码不引入反引号/模板插值(拼接进 PAGE 模板会炸生成 JS)", () => {
    for (const [name, src] of [["script-dialogs.ts", dialogs], ["script-views.ts", views], ["script-icons-sidebar.ts", iconsSidebar], ["script-submit.ts", submit], ["script-voice-cite.ts", voiceCite], ["script-commands.ts", commands]] as const) {
 // 只查本轮新增治理段(从 popover 基建标记到文件尾的第一个 popoverOpen/popoverSyncEl 调用行),整文件历史代码有自己的豁免注释。
      for (const line of src.split("\n")) {
        if (line.indexOf("popover") >= 0 || line.indexOf("POPOVER") >= 0) {
          expect(line.includes("`") || line.includes("${"), `${name} 治理行混入模板语法: ${line.trim().slice(0, 90)}`).toBeFalsy();
        }
      }
    }
  });
});
