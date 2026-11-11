import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { servePanel } from "../src/panel.js";

describe("桌面 Web 面板", () => {
  it("GET / 返回面板 HTML(含任务区与 WS 脚本)", async () => {
    const panel = servePanel(0, () => {});
    // 拿实际端口
    await new Promise((r) => setTimeout(r, 100));
    const port = (panel as unknown as { port?: number }).port;
    // servePanel 不暴露 port——直接用固定端口重试
    panel.close();
    const p2 = servePanel(7895, () => {});
    const res = await fetch("http://127.0.0.1:7895/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("lampgenie-harness");
    expect(html).toContain("task.submit");
    expect(html).toContain("WebSocket");
 // 项目区:添加入口+项目消息族在页面脚本中。
    expect(html).toContain("添加项目");
    expect(html).toContain("project.list.result");
    expect(html).toContain("project.activate");
    // 新用户首启:默认根项目 __harness__ 不渲染成可见项目;项目区空态。
    expect(html).toContain('p.id !== "__harness__"');
    expect(html).toContain("尚未打开项目");
    // 桌面无边框窗口:自绘窗口控制卡片 + 顶部拖拽带(浏览器面板不显示)。
    expect(html).toContain("winControls");
    expect(html).toContain("winDragBar");
    expect(html).toContain("desktop-shell");
 // 斜杠指令:指令面板+目录在页面脚本中。
    expect(html).toContain("slashMenu");
    expect(html).toContain("SLASH_COMMANDS");
    expect(html).toContain("newtask");
    expect(html).toContain("slashExec");
 // 成熟面板件:思考卡/变更条/计时/双 pill/标签页/统计/自动化分栏/快捷键分区。
    expect(html).toContain("think-card");
    expect(html).toContain("diffbar");
    expect(html).toContain("task.diffstat");
    expect(html).toContain("workTimer");
    expect(html).toContain("permPill");
    expect(html).toContain("effortPill");
    expect(html).toContain("reasoningEffort");
    expect(html).toContain("tabbar");
    expect(html).toContain("renderTabs");
    expect(html).toContain("stats.summary");
    expect(html).toContain("statsView");
    expect(html).toContain("heatmap");
    expect(html).toContain("autoScope");
    expect(html).toContain("sec-shortcuts");
    expect(html).toContain("kbd-table");
    expect(html).toContain("已工作");
 // 市场/浏览器/账号/引导/附件/远程。
    expect(html).toContain("mktGrid");
    expect(html).toContain("plugins.install");
    expect(html).toContain("brFrame");
    expect(html).toContain("quotaCards");
    expect(html).toContain("tourMask");
    expect(html).toContain("attBtn");
    expect(html).toContain("upload?sid");
    expect(html).toContain("wizard.gen");
    expect(html).toContain("node.exec");
 // 项目档案。
    expect(html).toContain("profile.get");
    expect(html).toContain("ppGraph");
    expect(html).toContain("ppSearch");
    expect(html).toContain("profile.rebuild");
    expect(html).toContain("/profile?p=");
 // 终端/管理面/新设置项/预设与模型列表。
    expect(html).toContain("term.exec");
    expect(html).toContain("termBody");
    expect(html).toContain("agents.list");
    expect(html).toContain("skills.list");
    expect(html).toContain("commands.upsert");
    expect(html).toContain("hooks.upsert");
    expect(html).toContain("mcp.test");
    expect(html).toContain("memory.view");
    expect(html).toContain("provPresets");
    expect(html).toContain("modelList");
    expect(html).toContain("set-mode");
    expect(html).toContain("set-notify");
    expect(html).toContain("tool-group");
    expect(html).toContain("office-chip");
    expect(html).toContain("cycleTheme");
    expect(html).toContain("zoomStep");
 // 浏览器可见层零 emoji;
    // 白名单=单色排版符号(箭头/勾叉/乘号等)。♥/⚙/⌕/⌄ 是既有 UI 图标;
    // ◇/▶/●/▤/◈/▣ 是 code 板 C4 类型标记;✂ 是截图标注按钮,均为单色排版符号,不是彩色 emoji。
    const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{2300}-\u{23FF}]/u;
    const ALLOW = new Set(["✓", "✗", "✕", "→", "←", "↑", "↓", "↵", "⇤", "⇥", "↳", "⎇", "■", "»", "…", "⚠", "☰", "♥", "⚙", "⌕", "⌄", "◇", "▶", "●", "▤", "◈", "▣", "✂"]);
    const bad = [...html].filter((ch) => EMOJI.test(ch) && !ALLOW.has(ch));
    expect(bad, "页面含 emoji: " + [...new Set(bad)].join(" ")).toEqual([]);
 // 视频四诉:置顶条 sticky(qk 快捷卡移除)/HUD 滚动跟随/响应式/goal sync 静默。
 // 推翻置顶条:顶部那条灰线空着也占位、chips 一多就折行把消息上下顶(周期变两条),
    // 已整块删除——chips 挂 footer .aff-strip(不在滚动容器内、单行 nowrap 不折)。
    expect(html).not.toContain('id="chatTopbar"');    // 会话流顶部置顶条已整块删除
    expect(html).not.toContain("#chatTopbar{position:sticky");
    expect(html).toContain('<div class="aff-strip">');
    expect(html).toMatch(/class="aff-strip"[\s\S]{0,400}id="chatStatusbar"/); // chips 宿主在底部状态条内
    expect(html).toContain("flex-wrap:nowrap");      // 单行不折(折行=消息晃动根因)
    expect(html).not.toContain("qk-exp");           // 快捷卡与侧栏入口重复,按移除
    expect(html).not.toContain("qk-wf");
    expect(html).toContain("@media (max-width:1400px)"); // 响应式:窗口变窄布局收敛
    expect(html).toContain("!m.sync");              // goal.get 同步回包不 toast
    const swRes = await fetch("http://127.0.0.1:7895/assets/status-widget.js");
    expect(swRes.status).toBe(200);
    const swJs = await swRes.text();
    expect(swJs).toContain("scrollTop + 6");        // HUD 视口钉住(absolute top 随滚动回写)
    expect(swJs).toContain('classList.toggle("sw-active"');
 // 视频三诉:命令真执行标识/技能反馈闭环/重启降级
    expect(html).toContain("cmdChip");
    expect(html).toContain("slashTypedMatch");      // 徽标与提交分发同源判定(非装饰)
    expect(html).toContain("cmdChipFlash");         // 真执行闪确认
    expect(html).toContain('kind === "message.system"'); // journal 系统通知渲染进聊天流
 // tips 注入留痕(tip.injected)在消息流可折叠展示,显示类别+第N步+字符数
    expect(html).toContain('kind === "tip.injected"');
    expect(html).toContain('class="tip-line"');
    expect(html).toContain(".tip-line>summary");   // 折叠行样式(与 tips 分支同批落地)
    expect(html).toContain("svcWaitRestart");       // 停机探活等待
    expect(html).toContain('serviceWorker.register("/assets/sw.js")'); // 缓存壳注册
    expect(html).not.toContain("setTimeout(() => location.reload()"); // 盲 reload 已除(裸错误页根因)
    const swr = await fetch("http://127.0.0.1:7895/assets/sw.js");
    expect(swr.status).toBe(200);
    const swTxt = await swr.text();
    expect(swTxt).toContain("network-first");       // 缓存只作停机回退,在线永远最新
    expect(swTxt).toContain("caches.match");
    // 独立窗口页同口径
    const pr = await fetch("http://127.0.0.1:7895/profile?p=x");
    const profileHtml = await pr.text();
    const bad2 = [...profileHtml].filter((ch) => EMOJI.test(ch) && !ALLOW.has(ch));
    expect(bad2, "/profile 含 emoji: " + [...new Set(bad2)].join(" ")).toEqual([]);
 // 全页脚本语法门(补装):并发编辑把 TS 标注(`let x: T | null`)写进页面脚本曾整页 SyntaxError——
    // 内容断言/emoji 门都拦不住。vm.Script 编译即验,主页面与 /profile 两页同口径。
    const { Script } = await import("node:vm");
    for (const [label, pageHtml] of [["主页面", html], ["/profile", profileHtml]] as const) {
      const blocks = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
      expect(blocks.length, label + " 无内联 script 块").toBeGreaterThan(0);
      blocks.forEach((code, i) => {
        expect(() => new Script(code), label + " script#" + i + " 语法错误").not.toThrow();
      });
    }
    await p2.close();
  });
});

describe("WSL 连接面(2026-10-27:Windows 桌面壳)", () => {
  it("目录选择器锚点:服务端下发 WSL 发行版,面板按平台方言拼接并渲染", async () => {
    await withPanel(7904, (html) => {
      // 目录选择器:本地选择器保持 Windows 路径语义;WSL 指路到连接向导(不再从本地选择器加 WSL)
      expect(html).toContain("anchors.rootLabel");
      expect(html).toContain("WSL 项目请用「远程连接 → WSL」");
      // 子项拼接按方言(Windows UNC/盘符用反斜杠)
      expect(html).toContain('cur.replace(/[/\\\\]+$/, "")');
      expect(html).toContain('base.indexOf("\\\\") >= 0');
 // 连接向导:先连接 → 连接中装工作区服务 → 服务返回目录 → 选目录添加
      expect(html).toContain("srvPlatform");
      expect(html).toContain('srvPlatform === "win32"');
      expect(html).toContain("工作区服务");
      expect(html).toContain("~/.genie");
      expect(html).toContain('type: "wsl.list"');
      expect(html).toContain('type: "wsl.test"');
      expect(html).toContain('type: "wsl.browse"');
      expect(html).toContain('type: "ssh.browse"');
      expect(html).toContain("ensureServer: true");
      expect(html).toContain("function prWslConnect(");
      expect(html).toContain("function prShowBrowser(");
      expect(html).toContain("function prBrowseGo(");
      expect(html).toContain("function prPickProject(");
      expect(html).toContain('return "remote:wsl:" + distro + ":/" + tail;');
      expect(html).toContain('"remote:wsl:" + f.distro + ":" + f.path');
      // UNC → remote:wsl 身份匹配(粘贴 UNC 的兼容捷径仍按 identity 去重)
      expect(html).toContain("function wslUncIdentity(");
      expect(html).toContain("function projPathMatches(");
      // hello 平台落库
      expect(html).toContain("if (m.platform) srvPlatform = String(m.platform);");
    });
  });
});

// ---- n3/n4/n8/n9:斜杠命令面板与命令使用细节(照 ZCode 打磨) ----
/** 从面板 HTML 里切出顶层函数源码(花括号配平,与 panel-board-live.test.ts 同构)。 */
function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 纯静态:不接 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

describe("斜杠命令面板(n8/n9:内置补齐 + teamai 注册 + 新建入口)", () => {
  it("① SLASH_COMMANDS 含 help/skill/model/new/resume/teamai,各自带 desc 与中英 kw", async () => {
    await withPanel(7896, (html) => {
      // 注册表源码切片(从 const SLASH_COMMANDS 到行首闭合 "];")——只在这里断言条目细节,避免误伤别处同名串。
      // 注意:命令 desc 里可能含 "];"(如 resume 的 [sessionId];…),故按「行首 ];」定位结尾。
      const start = html.indexOf("const SLASH_COMMANDS = [");
      expect(start).toBeGreaterThan(0);
      const end = html.indexOf(String.fromCharCode(10) + "];", start);
      expect(end).toBeGreaterThan(start);
      const reg = html.slice(start, end);
      // r3:补 rewind/fork/mode(全部复用既有通道:checkpoint 流/session.fork 两段式/cfg.set)
      for (const name of ["help", "skill", "model", "new", "resume", "teamai", "rewind", "fork", "mode"]) {
        expect(reg, "缺命令 " + name).toContain('{ value: "' + name + '"');
        // 每条都要 desc + kw(中英各至少一个)
        const i = reg.indexOf('{ value: "' + name + '"');
        const row = reg.slice(i, reg.indexOf("}", i) + 1);
        expect(row, name + " 缺 desc").toContain("desc:");
        expect(row, name + " 缺 kw").toContain("kw: [");
        expect(row, name + " 缺 kw 中英双语").toMatch(/kw: \[[^\]]*[\u4e00-\u9fa5][^\]]*[a-z]{2,}/);
      }
      // teamai 的 run 指向已存在的 builtinTeamai("")
      const ti = reg.indexOf('{ value: "teamai"');
      expect(reg.slice(ti, reg.indexOf("}", ti) + 1)).toContain('run: () => builtinTeamai("")');
      // 参数类命令进 CHIP_PARAM_NAMES(skill/model/resume/teamai + r3 rewind/fork/mode)
      expect(html).toContain('const CHIP_PARAM_NAMES = ["goal", "workflow", "compact", "init", "plan", "team", "skill", "model", "resume", "teamai", "rewind", "fork", "mode"]');
      // 实现函数在场
      for (const fn of ["builtinHelp", "builtinSkillCmd", "builtinModelCmd", "builtinResumeCmd", "builtinTeamai", "builtinRewind", "builtinFork", "builtinMode"]) {
        expect(html).toContain("function " + fn + "(");
      }
      // skill 的降级实现口径(无 skill_view 通道 → 拼任务消息)
      expect(extractFn(html, "builtinSkillCmd")).toContain("全文并按其执行");
      // model 有参走既有 per-session 通道
      expect(extractFn(html, "builtinModelCmd")).toContain("pillPickModel");
      // resume 无参=会话列表(命令中心 # 作用域),有参=openSession
      const rs = extractFn(html, "builtinResumeCmd");
      expect(rs).toContain("ccOpen()");
      expect(rs).toContain("openSession");
    });
  });

  it("② cmdExpand / splitCmdArgs 存在且语义照 ZCode($ARGUMENTS / $N / User arguments)", async () => {
    await withPanel(7897, (html) => {
      expect(html).toContain("function cmdExpand(");
      expect(html).toContain("function splitCmdArgs(");
      const src = extractFn(html, "cmdExpand");
      expect(src).toContain("$ARGUMENTS");
      expect(src).toContain("User arguments:");
      // 真跑一遍(源码片段编译执行,MVP 行为断言)
      const fn = new Function("const CMD_BS = String.fromCharCode(92);" + extractFn(html, "splitCmdArgs") + extractFn(html, "cmdExpand") + "; return { splitCmdArgs: splitCmdArgs, cmdExpand: cmdExpand };")() as {
        splitCmdArgs: (s: string) => string[];
        cmdExpand: (t: string, a: string) => string;
      };
      const NL2 = String.fromCharCode(10);
      // splitCmdArgs:双引号内空格不切、反斜杠转义空格
      expect(fn.splitCmdArgs('deploy "a b" c')).toEqual(["deploy", "a b", "c"]);
      expect(fn.splitCmdArgs("a\\ b c")).toEqual(["a b", "c"]);
      // $ARGUMENTS → 全量
      expect(fn.cmdExpand("tpl:$ARGUMENTS", "x y")).toBe("tpl:x y");
      // $1..$N 位置参数,缺则空串
      expect(fn.cmdExpand("$1-$2-$3", "a b")).toBe("a-b-");
      // 无占位符 + args 非空 → 追加 User arguments 段
      expect(fn.cmdExpand("body", "arg")).toBe("body" + NL2 + NL2 + "User arguments:" + NL2 + "arg");
      // args 为空 → 模板原样
      expect(fn.cmdExpand("body $ARGUMENTS", "")).toBe("body ");
      // 防膨胀剥离函数在场
      expect(html).toContain("function cmdStripTail(");
    });
  });

  it("②b r3:rewind/fork/mode 全部复用既有通道(零新对话框/零新协议)", async () => {
    await withPanel(7903, (html) => {
      // /rewind:走既有 pendingRewind + checkpoint.preview(回包确认流不新写)
      const rw = extractFn(html, "builtinRewind");
      expect(rw).toContain("pendingRewind = tid");
      expect(rw).toContain('"checkpoint.preview"');
      expect(rw).not.toContain("uiConfirm("); // 确认清单复用 checkpoint.preview.result 处理器
      expect(rw).toContain('"task.list"');    // 无任务时先刷列表
      // /fork:两段式抽成 forkSessionAndSubmit(src, instruction)(原 forkTask 调用点改用它)
      const fk = extractFn(html, "builtinFork");
      expect(fk).toContain("forkSessionAndSubmit");
      const core = extractFn(html, "forkSessionAndSubmit");
      expect(core).toContain('"session.fork"');
      expect(core).toContain('"task.submit"');
      expect(core).toContain('"task.rename"');
      expect(extractFn(html, "forkTask")).toContain("forkSessionAndSubmit"); // 原调用点复用
      // /mode:cfg.set permissions.mode(与 permPill 同通道);无参 toast 当前模式
      const md = extractFn(html, "builtinMode");
      expect(md).toContain("PERM_MODES.some((x) => x.v === a)"); // 枚举校验 ask|auto|readonly|plan
      expect(md).toContain("pillSendPerm()");                     // 既有 cfg.set 通道,不新写发送格式
      expect(md).toContain("toast");                              // 无参=toast 当前模式
      // typed 分派同源(chip 态之外 "/mode auto" 直发也执行)
      expect(html).toContain('if (c && c.value === "mode") { builtinMode(args); return true; }');
    });
  });

  it("③ slashFilter 用 ZCode 评分(200/250/450),上限 12,空态文案在场", async () => {
    await withPanel(7898, (html) => {
      const f = extractFn(html, "slashFilter");
      const sc = extractFn(html, "slashItemScore");
      // 评分档位常量(值域与 ZCode scorePromptInputSuggestion 对齐)
      expect(sc).toContain("+ 250");
      expect(sc).toContain("+ 450");
      const score = extractFn(html, "slashScore");
      expect(score).toContain("200 + at");           // 子串命中=200+位置代价(前缀命中 0)
      expect(score).toContain("return 0");
      // 旧实现的对称匹配已移除
      expect(f).not.toContain("needle.includes(");
      expect(sc).not.toContain("needle.includes(");
      // 上限 12(旧硬编码 slice(0, 9) 已除)
      expect(html).toContain("const SLASH_RENDER_LIMIT = 12;");
      expect(f).toContain("slice(0, SLASH_RENDER_LIMIT)");
      expect(f).not.toContain("slice(0, 9)");
      // 空态文案 + 不再 display:none
      expect(html).toContain("无匹配命令(试试 /help)");
      const rnd = extractFn(html, "slashRender");
      expect(rnd).toContain("sc-empty");
      expect(rnd).toContain("SLASH_EMPTY_TEXT");
      expect(rnd.indexOf("if (!slashOpen)")).toBeGreaterThan(-1); // 仅 slashOpen=false 时隐藏(空结果仍显示)
      // n4②分组头 + n4③hint 前缀 + n9 新建命令行
      expect(rnd).toContain("自定义命令");
      expect(rnd).toContain("内置命令");
      expect(rnd).toContain("sc-group");
      expect(rnd).toContain("sc-hint");
      expect(rnd).toContain("＋ 新建命令");
      expect(rnd).toContain("slashNewCommand");
      const nw = extractFn(html, "slashNewCommand");
      expect(nw).toContain('switchView("sys")');
      expect(nw).toContain('setSection("cmds")');
      expect(nw).toContain("cmdForm");
    });
  });

  it("画布/经典切换入口常驻:侧栏按钮 + CanvasShell HUD + composer 文案联动", async () => {
    const panel = servePanel(7896, () => {});
    try {
      const res = await fetch("http://127.0.0.1:7896/");
      const html = await res.text();
      // 经典模式:侧栏品牌下的常驻入口(不再只靠 composer 里 41px 的小药丸)
      expect(html).toContain('id="cvModeBtn"');
      expect(html).toContain("画布模式");
 // 双态常驻:CANVAS-ENTRY 修复——不再被 body.cv-shell 隐藏(画布形态下也能看到/点它回经典)
      expect(html).not.toContain("body.cv-shell .sb-mode-btn{display:none}");
      expect(html).toContain(".sb-mode-btn{display:flex;");
 // 侧栏按钮点击=toggle(与 composer 药丸/HUD「经典」同语义),不再固定 setMode("canvas")
      expect(html).toContain("CanvasShell.toggleMode()");
      expect(html).not.toContain('CanvasShell.setMode("canvas")');
      // composer 药丸:形态联动文案 + 高亮态
      expect(html).toContain('inCanvas ? "经典模式" : "画布模式"');
      expect(html).toContain('btn.classList.toggle("on", inCanvas)');
 // 侧栏按钮也随 cv-mode 联动:图标/文案双态 + 保留 kbd 子元素(用 children[1] 写文案)
      expect(html).toContain('sbtn.children[0].textContent = inCanvas ? "▣" : "▦"');
      expect(html).toContain('sbtn.children[1].textContent = inCanvas ? "经典模式" : "画布模式"');
      expect(html).toContain('sbtn.title = inCanvas ? titleOn : titleOff');
      // 画布模式:CanvasShell HUD 提供「经典」退出按钮
      const cv = readFileSync(new URL("../src/assets/canvas-shell.js", import.meta.url), "utf8");
      expect(cv).toContain('data-act="classic"');
      expect(cv).toContain('act === "classic"');
      expect(cv).toContain('setMode("classic")');
    } finally {
      panel.close();
    }
  });
});

// RSI-DASH-UX:未启用(无 store→UNAVAILABLE)与异常分离,空态不伪装成降级。
describe("RSI 看板三分状态语义(未启用≠异常)", () => {
  it("头部模板为「正常/未启用/异常」三分,UNAVAILABLE 单独归类,空态为「暂无 RSI 数据」", async () => {
    await withPanel(7901, (html) => {
 // ① 头部文案模板(源码字面量出现在页面脚本里)
      expect(html).toContain('· 正常 " + ok + " · 未启用 " + unavailable + " · 异常 " + errors');
 // ② 旧的「正常 X / 降级 Y」硬编码不再出现
      expect(html).not.toContain('正常 " + ok + " / 降级 ');
 // ③ UNAVAILABLE 归类分支明确存在于面板源码
      expect(html).toContain("function rsiStateKind");
      expect(html).toContain('=== "UNAVAILABLE" ? "unavailable" : "error"');
 // ④ 空态:无数据如实显示,不报错
      expect(html).toContain("暂无 RSI 数据");
 // ⑤ 卡片:未启用用中性灰点 + 提示文案;异常仍走红色
      expect(html).toContain(".rsi-tone-idle .rsi-dot");
      expect(html).toContain("未产生数据（运行对应 RSI 任务后自动更新）");
      expect(html).toContain('kind === "ok" ? "正常" : (kind === "unavailable" ? "未启用" : "异常")');
    });
  });
});

// RSI-PLACE:RSI 看板=全局治理面,从团队第四子标签迁到指挥台视图第二子标签(画布复用指挥台卡)。
describe("RSI 看板归位:指挥台第二子标签(团队视图不再承载)", () => {
  it("侧栏有 act-rsi,团队无 RSI 子标签,指挥台含两子标签与 RSI 面板,画布映射指回 super", async () => {
    await withPanel(7930, (html) => {
 // ① 侧栏新入口(位于指挥台下方)
      expect(html).toContain('id="act-rsi"');
      expect(html).toContain('$("act-rsi")');
 // ② 团队视图不再有 RSI 子标签/面板
      expect(html).not.toContain("teamTabRsi");
      expect(html).not.toContain('id="teamPaneRsi"');
      expect(html).not.toContain("#view-team.tab-rsi");
 // ③ 指挥台视图:两子标签 + RSI 面板 + 类驱动显隐 CSS
      const superStart = html.indexOf('id="view-super"');
      expect(superStart).toBeGreaterThan(0);
      const superScope = html.slice(superStart, superStart + 4000);
      expect(superScope).toContain('id="superTabChat"');
      expect(superScope).toContain('id="superTabRsi"');
      expect(superScope).toContain('id="superPaneChat"');
      expect(superScope).toContain('id="superPaneRsi"');
      expect(superScope).toContain('id="rsiCards"');
 // RSI-SESSION:固定会话窗——RSI 面板改为左卡右流双栏,内嵌会话 rsi 的工作流
      expect(superScope).toContain('id="rsiStream"');
      expect(superScope).toContain('id="rsiStreamBody"');
      expect(html).toContain("#view-super.tab-rsi #superPaneRsi{display:grid;");
      expect(html).toContain('#rsiStream{');
 // ④ 画布映射:RSI 看板复用指挥台卡片,托盘可定位
      expect(html).toContain('m.rsi = "super"');
      expect(html).toContain('issues: "team", rsi: "super" }');
      expect(html).toContain('rsi: "act-rsi"');
 // ⑤ 视图名:指挥台 · RSI 看板
      expect(html).toContain('rsi: "指挥台 · RSI 看板"');
    });
  });
});

// SUPER-CHAT:super 页第三子标签「会话Chat」——rsi 会话满渲染(主聊天同款卡片)+底部输入框。
describe("会话Chat 子标签(rsi 会话满渲染工作区)", () => {
  it("① 容器/页签/输入:第三子标签按钮 + 独立 pane + composer + 类驱动显隐 CSS", async () => {
    await withPanel(7933, (html) => {
      const superStart = html.indexOf('id="view-super"');
      expect(superStart).toBeGreaterThan(0);
      const superScope = html.slice(superStart, superStart + 6000);
      expect(superScope).toContain('id="superChatTab"');
      expect(superScope).toContain('id="superPaneRsiChat"');
      expect(superScope).toContain('id="rsiChatBody"');
      expect(superScope).toContain('id="rsiChatComposer"');
      expect(superScope).toContain('id="rsiChatInput"');
      expect(superScope).toContain('id="rsiChatSend"');
      expect(superScope).toContain('id="rsiChatMech"'); // 头部「机制」按钮切回 RSI
 // 类驱动显隐(沿 tab-rsi 约定):tab-rsichat 时其余两 pane 隐藏、本 pane 显示
      expect(html).toContain("#view-super.tab-rsichat #superPaneRsiChat{display:flex}");
      expect(html).toContain("#view-super.tab-rsichat #superPaneChat,");
      expect(html).toContain("#view-super.tab-rsichat #superPaneRsi{display:none}");
 // 视图名
      expect(html).toContain('rsichat: "指挥台 · 会话Chat"');
 // 无内联 onclick(模板段)
      const paneStart = superScope.indexOf('id="superPaneRsiChat"');
      const paneEnd = superScope.indexOf("</div>", superScope.indexOf('id="rsiChatComposer"'));
      const paneHtml = paneStart >= 0 && paneEnd > paneStart ? superScope.slice(paneStart, paneEnd) : "";
      expect(paneHtml).not.toContain("onclick=");
    });
  });
  it("② 渲染复用=主聊天同款卡片构造(薄壳):rsiChatRender 调 replyBlockHtml/toolCallCard/toolResultCard", async () => {
    await withPanel(7934, (html) => {
      const start = html.indexOf("function rsiChatRender");
      expect(start).toBeGreaterThan(0);
      const body = html.slice(start, start + 9000);
      expect(body).toContain("replyBlockHtml(e, \"\")"); // assistant 正文 markdown(主聊天同款)
      expect(body).toContain("toolCallCard(c, \"\""); // 工具调用+结果合并卡(主聊天同款)
      expect(body).toContain("toolResultCard("); // 孤儿结果卡(主聊天同款)
      expect(body).toContain('class="user-line"'); // 用户气泡类名同款
      expect(body).toContain("userSlashHtml"); // slash/chip 渲染同款
 // 三态:加载(rsiEvReady 未就绪)/空(引导去 RSI)/错误(可重试)
      expect(body).toContain("读 取 会 话 …");
      expect(body).toContain("去 RSI 看板运行机制");
      expect(body).toContain('data-rsichat-act="retry"');
      expect(body).toContain('data-rsichat-act="goMech"');
    });
  });
  it("③ 单次拉取双消费:rsiEvOnHist 尾部挂满渲染;不新增第二条 rsi 轮询", async () => {
    await withPanel(7935, (html) => {
 // 双消费挂点:同一份回包既喂紧凑流又喂满渲染
      const hStart = html.indexOf("function rsiEvOnHist");
      expect(hStart).toBeGreaterThan(0);
      const hBody = html.slice(hStart, hStart + 2200);
      expect(hBody).toContain("rsiEvRender();");
      expect(hBody).toContain("rsiChatRender();");
 // 负面断言:rsiEv 定时器/拉取只有一处(sessionId="rsi" 的 session.history 请求只出自 rsiEvPull)
      expect((html.match(/setInterval\(rsiEvPull/g) || []).length).toBe(1);
      expect((html.match(/rsiEvTimer = setInterval/g) || []).length).toBe(1);
      expect((html.match(/sessionId: RSI_EV_SID/g) || []).length).toBe(2); // 首屏+增量两条请求形态,与基线一致
      expect(html).not.toContain("rsiChatTimer"); // 会话Chat 无自有轮询
      expect(html).not.toContain("rsiChatPoll"); // 会话Chat 无自有拉取函数
    });
  });
  it("④ 输入通道:super.turn 同款 wsSafeSend(不扩协议),本地气泡+页顶说明", async () => {
    await withPanel(7936, (html) => {
      const sStart = html.indexOf("function rsiChatSend");
      expect(sStart).toBeGreaterThan(0);
      const sBody = html.slice(sStart, sStart + 3000);
      expect(sBody).toContain('type: "super.turn", text'); // 与 supSend 同款载荷(无 sessionId,协议零扩)
      expect(sBody).not.toContain("sessionId"); // 不私带 sessionId
      expect(sBody).toContain("已发往指挥台"); // 本地气泡诚实标注
      expect(sBody).toContain('toast("连接未就绪", true)'); // WS 未就绪守卫
      expect(html).toContain('id="rsiChatNotice"'); // 页顶说明
      expect(html).toContain("发出的消息进 super 日卷");
 // Enter 发送接线
      expect(html).toContain('$("rsiChatInput").addEventListener("keydown"');
      expect(html).toContain('$("rsiChatSend").onclick');
    });
  });
  it("⑤ 互跳:机制卡运行后切会话Chat;会话Chat 头部切回 RSI;轮询启停含 rsichat", async () => {
    await withPanel(7937, (html) => {
 // 机制卡「运行」→ 自动跳会话Chat
      const rStart = html.indexOf('if (act === "run")');
      expect(rStart).toBeGreaterThan(0);
      expect(html.slice(rStart, rStart + 400)).toContain('switchView("rsichat")');
 // 页签/头部按钮互跳
      expect(html).toContain('$("superChatTab").onclick');
      expect(html).toContain('switchView("rsichat")');
      expect(html).toContain('$("rsiChatMech").onclick');
      expect(html).toContain('switchView("rsi"); // 会话Chat 头部「机制」按钮切回 RSI 看板');
 // rsiPollSync:rsichat 也启动 rsi 会话轮询;离开两者都停
      const pStart = html.indexOf("function rsiPollSync");
      const pBody = html.slice(pStart, pStart + 900);
      expect(pBody).toContain('name !== "rsi" && name !== "rsichat"');
      expect(pBody).toContain("rsiEvStart()");
 // applyViewChrome 点亮三页签互斥
      expect(html).toContain('$("superChatTab").classList.toggle("on", name === "rsichat")');
 // 断连错误态挂点 + 重连清错
      expect(html).toContain("rsiChatNoteErr()");
      expect(html).toContain('rsiChatErr = ""; rsiChatErrAt = 0');
    });
  });
  it("⑥ 空态/输入模板零内联 onclick,交互全走事件委托", async () => {
    await withPanel(7938, (html) => {
      const start = html.indexOf('id="superPaneRsiChat"');
      const end = html.indexOf('id="rsiChatInput"');
      expect(start).toBeGreaterThan(0);
      const seg = html.slice(start, end + 400);
      expect(seg).not.toContain("onclick=");
      expect(seg).not.toContain("onload=");
 // 委托挂点存在
      expect(html).toContain('$("rsiChatBody").addEventListener("click", rsiChatClick)');
    });
  });
});

// RSI-CTRL:每机制可开关/切驱动/运行,结果条目可改可删(协议五条 + 事件委托 + 零内联 onclick)。
describe("RSI 机制交互(开关/驱动/运行/条目改删)", () => {
  it("① 模板与回包分支齐全,新交互全走 #rsiCards 事件委托(无内联 onclick)", async () => {
    await withPanel(7940, (html) => {
 // ① 卡头三控件类名 + 结果条目区类名
      for (const cls of ["rsi-sw", "rsi-run", "rsi-items", "rsi-drv"]) expect(html).toContain(cls);
      expect(html).toContain('data-act="toggle"');
      expect(html).toContain('aria-pressed="');
 // ② 出站四类消息 + 入站三条回包分支
      for (const t of ["rsi.mechanism.set", "rsi.mechanism.run", "rsi.item.update", "rsi.item.delete"]) {
        expect(html, "缺出站消息 " + t).toContain('type: "' + t + '"');
      }
      for (const t of ["rsi.mechanism.set.result", "rsi.mechanism.run.result", "rsi.item.result"]) {
        expect(html, "缺回包分支 " + t).toContain('if (m.type === "' + t + '")');
      }
 // ③ 三条回包成功后各拉一拍 rsiStatusPull 刷新(不整页重载)
      for (const t of ["rsi.mechanism.set.result", "rsi.mechanism.run.result", "rsi.item.result"]) {
        const i = html.indexOf('if (m.type === "' + t + '")');
        const seg = html.slice(i, i + 600);
        expect(seg, t + " 未拉刷新").toContain("rsiStatusPull()");
        expect(seg, t + " 不应整页重载").not.toContain("location.reload");
      }
 // ④ 事件委托:唯一入口 #rsiCards 上的 click/change,RSI 交互区零内联 onclick 属性
      expect(html).toContain('box.addEventListener("click", rsiOnClick)');
      expect(html).toContain('box.addEventListener("change", rsiOnChange)');
      const rs = html.slice(html.indexOf("function rsiSecId("), html.indexOf("function applyViewChrome("));
      expect(rs.length).toBeGreaterThan(2000);
      expect(rs).not.toContain("onclick=");
 // ⑤ 关闭态/展开/二次确认/运行态样式与文案在场
      for (const s of [".rsi-card-off", ".rsi-item-detail", ".rsi-arm", "上次运行:", "机制已关闭,不再自动运行", "确认删", "运行中…"]) {
        expect(html, "缺 " + s).toContain(s);
      }
 // ⑥ 头部三分统计后追加「已启用 x/N」
      expect(html).toContain('· 异常 " + errors + " · 已启用 " + on + "/" + secs.length');
 // ⑦ 乐观态闭环:点击开关/切驱动写入 rsiOpt,rsiRender 经 rsiOptMerge 合并后才播种/渲染
 // (缺失则 rerender 立刻用旧 payload 覆盖,rsi-sw 点击瞬间回弹)
      expect(html).toContain("rsiOpt[mid] = { en: next");
      expect(html).toContain("rsiOpt[mid] = { drv: drv");
      expect(html).toContain("merged.push(rsiOptMerge(");
      expect(html).toContain("var enabled = merged[i].en, drv = merged[i].drv;");
      expect(html).toContain("if (merged[i].en) on++;");
    });
  });

  it("①b 固定会话窗:拉 rsi 会话历史 + 回包前置分流 + 离开停表 + 事件种类", async () => {
    await withPanel(7931, (html) => {
      expect(html).toContain('var RSI_EV_SID = "rsi"');
      expect(html).toContain('type: "session.history", sessionId: RSI_EV_SID');
 // 回包分流必须在主会话 session.history.result 分支之前(否则全局 histEvents 被污染)
      const split = html.indexOf('m.sessionId === RSI_EV_SID) { rsiEvOnHist(m); return; }');
      const main = html.indexOf('if (m.type === "session.history.result") {\n    const evs = m.events || [];');
      expect(split).toBeGreaterThan(0);
      expect(main).toBeGreaterThan(split);
      expect(html).toContain("rsiEvStart();");
      expect(html).toContain("rsiEvStop();");
      expect(html).toContain("rsiEv.length > 600");
      for (const k of ["rsi-ev-task", "rsi-ev-agent", "rsi-ev-tool", "rsi-ev-res", "rsi-ev-warn"]) expect(html).toContain(k);
    });
  });

  it("② 控件/条目渲染函数可执行:esc 转义、运行中禁用、改删按钮、空态与关闭态文案", async () => {
    await withPanel(7941, (html) => {
      const src =
        extractFn(html, "rsiCut") + extractFn(html, "rsiTextTone") + extractFn(html, "rsiCtrlHtml") +
        extractFn(html, "rsiItemHtml") + extractFn(html, "rsiItemsHtml");
 // script 段语法门(与主测试的 vm.Script 同口径,这里再对新函数拼接编译一次)
      const escT = (s: unknown) =>
        String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
      const api = new Function(
        "esc", "rsiHms",
        'var rsiEditKey = "", rsiArmKey = "", rsiOpen = {}, rsiOrig = {};' + src +
          "; return { ctrl: rsiCtrlHtml, item: rsiItemHtml, items: rsiItemsHtml, tone: rsiTextTone };",
      )(escT, () => "00:00:00") as {
        ctrl: (sid: string, en: boolean, drv: string, running: boolean) => string;
        item: (mid: string, iid: string, o: Record<string, unknown>, key: string) => string;
        items: (sec: Record<string, unknown>, mid: string, en: boolean) => string;
        tone: (v: unknown) => string;
      };
 // 开关/驱动/运行:on 态 + code 选中 + 运行按钮
      const c0 = api.ctrl("nightly", true, "code", false);
      expect(c0).toContain('class="rsi-sw on"');
      expect(c0).toContain('aria-pressed="true"');
      expect(c0).toContain("已启用");
      expect(c0).toContain('<option value="code" selected');
      expect(c0).toContain('data-act="toggle" data-id="nightly"');
      expect(c0).toContain('data-act="run" data-id="nightly"');
 // 关闭态 + 运行中:文案与 disabled
      const c1 = api.ctrl("nightly", false, "agent", true);
      expect(c1).toContain('class="rsi-sw off"');
      expect(c1).toContain('aria-pressed="false"');
      expect(c1).toContain("已关闭");
      expect(c1).toContain("disabled");
      expect(c1).toContain("运行中…");
 // 条目行:服务端文本与 id 全过 esc,有 detail 才有展开/详情块
      const i0 = api.item("nightly", 'a"b', { title: "<b>t</b>", summary: "s1", detail: "d1", status: "bad" }, 'nightly|a"b');
      expect(i0).toContain('data-item="a&quot;b"');
      expect(i0).toContain("&lt;b&gt;t&lt;/b&gt;");
      expect(i0).toContain('data-act="edit"');
      expect(i0).toContain('data-act="del"');
      expect(i0).toContain("rsi-item-detail");
      expect(i0).toContain("rsi-tone-bad");
      const i1 = api.item("m", "x", { title: "只有标题" }, "m|x");
      expect(i1).not.toContain("rsi-item-detail");
      expect(i1).toContain("只有标题");
 // 状态映射:ok/warn/bad/其余
      expect(api.tone("ok")).toBe("ok");
      expect(api.tone("warn")).toBe("warn");
      expect(api.tone("bad")).toBe("bad");
      expect(api.tone("info")).toBe("idle");
 // 空态 / 未启用态
      expect(api.items({ items: [] }, "m", true)).toContain("暂无结果条目(点「运行」让 agent 产出)");
      expect(api.items({ items: [] }, "m", false)).toContain("机制已关闭,不再自动运行");
      expect(api.items({ items: [{ id: "i1", title: "t" }] }, "m", false)).toContain('data-item="i1"');
    });
  });

  it("③ 运行成本与已分析会话:金额·token·项目计数渲染,单价缺失绝不显示 ¥0", async () => {
    await withPanel(7942, (html) => {
 // 静态接线:运行头两行 + 卡片体小块(纯服务端数值,无内联 onclick)
      expect(html).toContain("runHead += rsiCostHead(run) + rsiAnalysisHead(run);");
      expect(html).toContain('id="rsiCostLine"');
      expect(html).toContain('data-run-cost="1"');
      expect(html).toContain('data-run-analysis="1"');
      const src =
        extractFn(html, "rsiTok") + extractFn(html, "rsiMoney") + extractFn(html, "rsiCostHead") +
        extractFn(html, "rsiAnalysisHead") + extractFn(html, "rsiCostBody");
      const escT = (s: unknown) =>
        String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
      const api = new Function(
        "esc",
        src + "; return { tok: rsiTok, money: rsiMoney, head: rsiCostHead, analysis: rsiAnalysisHead, body: rsiCostBody };",
      )(escT) as {
        tok: (n: unknown) => string;
        money: (a: unknown) => string;
        head: (run: unknown) => string;
        analysis: (run: unknown) => string;
        body: (run: unknown) => string;
      };
 // 数字口径:千位缩写、金额位数、缺价 → 「单价缺失」(不是 ¥0)
      expect(api.tok(12345)).toBe("12.3k");
      expect(api.tok(800)).toBe("800");
      expect(api.tok(undefined)).toBe("0");
      expect(api.money(0.1234)).toBe("¥0.1234");
      expect(api.money(1.5)).toBe("¥1.50");
      expect(api.money(null)).toBe("单价缺失");
      expect(api.money(undefined)).toBe("单价缺失");
 // 运行头:金额 · token(输入/缓存/输出) + 模型 title
      const h0 = api.head({ cost: { amountCny: 0.1234, totalTokens: 12345, inputTokens: 8000, cachedTokens: 3000, outputTokens: 1345, model: "gpt-x", missing: [] } });
      expect(h0).toContain("¥0.1234 · 12.3k tokens(输入 8.0k / 缓存 3.0k / 输出 1.3k)");
      expect(h0).toContain('title="模型 gpt-x"');
      expect(h0).toContain('data-run-cost="1"');
      expect(h0).not.toContain("缺单价段");
 // 缺单价:只写「单价缺失」+ 缺价段名,不出现 ¥0
      const h1 = api.head({ cost: { amountCny: null, totalTokens: 100, inputTokens: 0, cachedTokens: 0, outputTokens: 100, missing: ["output"] } });
      expect(h1).toContain("单价缺失");
      expect(h1).toContain("缺单价段 output");
      expect(h1).not.toContain("¥0");
      expect(h1).toContain("模型未上报");
 // 无成本记录 → 不渲染假账
      expect(api.head({})).toBe("");
      expect(api.analysis({})).toBe("");
 // 分析头:会话数 + 按项目计数(按已认账会话)
      const a0 = api.analysis({
        analysis: {
          windowDays: 3,
          candidates: [{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: "s3" }],
          analyzed: [{ sessionId: "s1", projectId: "__harness__" }, { sessionId: "s2", projectId: "__harness__" }, { sessionId: "s3", projectId: "genie" }],
        },
      });
      expect(a0).toContain("分析 3 会话 · __harness__ 2 / genie 1 · 候选 3");
 // 卡片体:候选/已分析逐行 + esc + 不在候选的标注
      const b0 = api.body({
        analysis: {
          windowDays: 3,
          candidates: [{ sessionId: 's"1', projectId: "genie" }, { sessionId: "s2" }],
          analyzed: [{ sessionId: 's"1', projectId: "genie" }, { sessionId: "sX" }],
        },
      });
      expect(b0).toContain('id="rsiCostLine"');
      expect(b0).toContain("s&quot;1 (genie) · 已分析");
      expect(b0).toContain("s2 (未绑定) · 候选");
      expect(b0).toContain("sX (未绑定) · 已分析(不在本次候选)");
      expect(b0).not.toContain("<script");
 // 空态
      expect(api.body({ analysis: { windowDays: 3, candidates: [], analyzed: [] } })).toContain("本次未涉及会话");
      expect(api.body({})).toBe("");
    });
  });
});
