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

  it("④ 浮窗逃逸+伪 chip 收口+选命令保正文(2026-11-12 渲染bug三修)", async () => {
    await withPanel(7899, (html) => {
 // 浮窗逃逸:输入框外 pointerdown 收起面板;面板自身与输入框除外(按下收起会让条目 click 落空)
      expect(html).toContain('t.closest("#slashMenu") || t.closest("#instruction")');
      const upd = extractFn(html, "slashUpdate");
      expect(upd).toContain("} else slashClose();");
 // submit 两处程序化清空都同步收起面板(typed 直发路径 + finishSubmit 统一收尾)——
 // 否则「/xxx 已有text」空态面板开着时发送,输入清空后面板永留(注意截图路径)
      const fin = extractFn(html, "finishSubmit");
      expect(fin).toContain('$("instruction").value = "";');
      expect(fin).toContain("slashClose();");
 // 选命令不再清空已有正文:「/cmd rest」首空格后文本进 chip 参数(ui 纯动作保留 rest)
      const ex = extractFn(html, "slashExec");
      expect(ex).toContain("chipMount(c, ck, rest)");
      expect(ex).toContain("v0.slice(sp3 + 1).trim()");
 // 伪 chip :userSlashHtml 先按注册表/自定义命令解析,未知名字回落纯文本渲染(不再吞整段首行)
      const us = extractFn(html, "userSlashHtml");
      expect(us).toContain("knownSlash");
      expect(us).toContain("customCommands.find((x) => x.name.toLowerCase() === nm0)");
 // 面板过滤只取命令名段(首空格前):带参数过滤不再闪「无匹配命令」
      const sf = extractFn(html, "slashFilter");
      expect(sf).toContain("t.slice(0, sp0)");
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
 // ① 头部文案模板(源码字面量出现在页面脚本里; 起与健康一屏同一分类,含「关注」)
      expect(html).toContain('· 正常 " + ok + " · 关注 " + warn + " · 未启用 " + unavailable + " · 异常 " + errors');
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
      expect(html).toContain('kind === "ok" ? "正常" : kind === "warn" ? "关注" : (kind === "idle" ? "未启用" : "异常")');
    });
  });
});

// RSI-PLACE:RSI 看板=全局治理面,从团队第四子标签迁到指挥台视图第二子标签(画布复用指挥台卡)。
describe(" super 指挥台 IDE 三栏布局(活动栏/侧栏/中栏+右缘聊天窗)", () => {
  it("侧栏有 act-rsi,团队无 RSI 子标签,super=IDE 三栏(活动栏/侧栏两区/中栏+聊天窗右缘),画布映射指回 super", async () => {
    await withPanel(7930, (html) => {
 // ① 侧栏入口(做梦视图直达)
      expect(html).toContain('id="act-rsi"');
      expect(html).toContain('$("act-rsi")');
 // ② 团队视图不再有 RSI 子标签/面板
      expect(html).not.toContain("teamTabRsi");
      expect(html).not.toContain('id="teamPaneRsi"');
      expect(html).not.toContain("#view-team.tab-rsi");
 // ③ super 视图:IDE 三栏骨架(活动栏/侧栏两区/中栏)+聊天窗右缘叠层(容器 id 全 superIde* 前缀)
      const superStart = html.indexOf('id="view-super"');
      expect(superStart).toBeGreaterThan(0);
      const superScope = html.slice(superStart, superStart + 7600); // 待办区/聊天头/协作链加入后骨架变长
      expect(superScope).toContain('id="superIdeWrap"'); // 三栏 grid 骨架
      expect(superScope).toContain('id="superIdeAct"'); // 活动栏(任务/做梦)
      expect(superScope).toContain('id="superIdeSide"'); // 侧栏(两区列表)
      expect(superScope).toContain('id="superIdeMain"'); // 中栏(结果呈现)
      expect(superScope).toContain('id="superIdeChat"'); // 聊天窗(右缘叠层)
      expect(superScope).toContain('id="superSbTaskList"'); // 任务区:派发任务列表
      expect(superScope).toContain('id="superSbDreamList"'); // 做梦区:机制列表
      expect(superScope).toContain('id="superMainWelcome"'); // 中栏欢迎空态
      expect(superScope).toContain('id="superMainTask"'); // 中栏任务详情
      expect(superScope).toContain('id="superMainDream"'); // 中栏做梦报告
 // 做梦报告沿用 RSI 机制卡(rsiCards 迁入中栏)+ rsi 会话流(RSI-SESSION 沿用)
      expect(superScope).toContain('id="rsiCards"');
      expect(superScope).toContain('id="rsiStream"');
      expect(superScope).toContain('id="rsiStreamBody"');
      expect(superScope).toContain('id="rsiRunAll"'); // 全量运行按钮(逐个 startMechanismRun;防重入禁用)
 // 聊天窗:superChatBody/superComposer 原样迁入右栏容器(DOM 移动不重建)
      expect(superScope).toContain('id="superChatBody"');
      expect(superScope).toContain('id="superComposer"');
      expect(superScope).toContain('id="superSbGrip"'); // 左栏拖拽手柄
      expect(superScope).toContain('id="superChatGrip"'); // 聊天窗拖拽手柄
      expect(superScope).toContain('id="superResultFeed"'); // Coding Agent 结果流(中栏)
      expect(superScope).not.toContain('id="superIdeChatFold"'); // 聊天窗不可折叠
 // 三栏 CSS:grid 列规格 + 聊天窗右缘叠层 + 折叠态 + 窄屏退化(全部 spide-* 包 #view-super)
 // 中栏下限 minmax(420px,1fr) + 卡宽 1400(三栏在全宽下中栏≥500 的两道保险)
      expect(html).toContain("#superIdeWrap{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:56px var(--superSb,280px) minmax(420px,1fr)");
      expect(html).toContain(".spide-chat{position:absolute;top:0;right:0;bottom:0;width:var(--superChatW,360px)");
      expect(html).toContain(".spide-grip{position:absolute");
      expect(html).toContain(".spide-chat-grip{position:absolute");
      expect(html).toContain("@media (max-width:1200px)");
      expect(html).toContain("@media (max-width:900px)");
      expect(html).toContain(".spide-act");
 // ④ 画布映射:做梦视图复用指挥台卡片,托盘可定位
      expect(html).toContain('m.rsi = "super"');
      expect(html).toContain('issues: "team", rsi: "super" }');
      expect(html).toContain('rsi: "act-rsi"');
 // ⑤ 视图名:指挥台 · 做梦 / 指挥台 · 任务(别名保留)
      expect(html).toContain('rsi: "指挥台 · 做梦"');
      expect(html).toContain('task: "指挥台 · 任务"');
 // ⑥ 旧结构退役:三段导航按钮/tab-rsi/tab-rsichat/切换 pane 壳不再存在
      expect(html).not.toContain('id="superSegChat"');
      expect(html).not.toContain('id="superSegTask"');
      expect(html).not.toContain('id="superSegDream"');
      expect(html).not.toContain('id="superPaneChat"');
      expect(html).not.toContain('id="superPaneRsi"');
      expect(html).not.toContain('id="superPaneTask"');
      expect(html).not.toContain("tab-dream");
      expect(html).not.toContain("tab-task");
      expect(html).not.toContain("tab-rsichat");
      expect(html).not.toContain('id="superPaneRsiChat"');
      expect(html).not.toContain('id="superChatTab"');
      expect(html).not.toContain('id="superTabRsi"');
      expect(html).not.toContain('id="superTabChat"');
    });
  });
});

// 聊天窗主线:super 固定会话(sessionId="super")+主聊天卡片薄壳+派发卡/做梦卡+三态。
describe(" 聊天窗主线(super 固定会话+主聊天卡片薄壳+派发卡/做梦卡)", () => {
  it("① 输入带 sessionId=\"super\":supSend 走 super.turn 显式固定会话", async () => {
    await withPanel(7933, (html) => {
      const sStart = html.indexOf("function supSend");
      expect(sStart).toBeGreaterThan(0);
      const sBody = html.slice(sStart, sStart + 1200);
      expect(sBody).toContain('type: "super.turn", text, sessionId: "super"'); // 显式固定会话
      expect(sBody).toContain('toast("连接未就绪", true)'); // WS 未就绪守卫
 // superViewLoad:supDayLabel=固定会话 "super"(旧按天日卷退役)
      const dStart = html.indexOf("function supDayLabel");
      expect(html.slice(dStart, dStart + 200)).toContain('return "super"');
    });
  });
  it("② 渲染复用=主聊天同款卡片构造(薄壳):supRenderChat 调 replyBlockHtml/toolCallCard/userSlashHtml", async () => {
    await withPanel(7934, (html) => {
      const start = html.indexOf("function supRenderChat");
      expect(start).toBeGreaterThan(0);
      const body = html.slice(start, start + 6000);
      expect(body).toContain("replyBlockHtml("); // assistant 正文 markdown(主聊天同款构造)
      expect(body).toContain("toolCallCard("); // 工具调用+结果合并卡(主聊天同款)
      expect(body).toContain('class="user-line"'); // 用户气泡类名同款
      expect(body).toContain("userSlashHtml"); // slash/chip 渲染同款
      expect(body).toContain("think-card"); // 思考卡(主聊天同款,settings.thinking=on 且非 office)
 // 空态:欢迎语+示例
      expect(body).toContain("还没有对话");
      expect(body).toContain("示例:");
 // 粘底跟随(主聊天同款 60px 容差)
      expect(body).toContain("wasBottom");
 // 指挥状态条:工具动词人话 + 委托/调度阶段
      expect(html).toContain('id="superRunBar"');
      expect(html).toContain("function supToolVerb");
      expect(html).toContain("function supRunBarRender");
      expect(html).toContain('"spawn_task" ? "委托中" : "调度中"');
    });
  });
  it("③ 历史回放含做梦卡+工具结果回填;旧 rsi 满渲染双消费退役", async () => {
    await withPanel(7935, (html) => {
      const hStart = html.indexOf("function supApplyHistory");
      expect(hStart).toBeGreaterThan(0);
      const hBody = html.slice(hStart, hStart + 3000);
      expect(hBody).toContain('kind === "super.dream"'); // 做梦卡回放
      expect(hBody).toContain('kind: "dream"');
      expect(hBody).toContain("toolRes"); // 工具结果收集回填(fixH12 同语义)
 // 播报轮输入(系统通知/转接)不得回放成「你」的聊天消息:通知→紧凑系统行,转接→super.relay 行
      expect(hBody).toContain("播报轮的输入是系统通知/转接");
      expect(hBody).toContain("结果见中栏");
 // 负面断言:rsi 会话满渲染退役(rsiEvOnHist 不再双消费;rsiChat 函数族删除)
      const eStart = html.indexOf("function rsiEvOnHist");
      const eBody = html.slice(eStart, eStart + 2000);
      expect(eBody).not.toContain("rsiChatRender();");
      expect(html).not.toContain("function rsiChatSend");
      expect(html).not.toContain("function rsiChatClick");
 // rsiEv 轮询仍只一处(sessionId="rsi" 供做梦视图 rsiStream 消费)
      expect((html.match(/setInterval\(rsiEvPull/g) || []).length).toBe(1);
    });
  });
  it("④ 派发卡:task 实时帧按 submittedBy=super 过滤,排队→运行→完成,点卡跳目标 session", async () => {
    await withPanel(7936, (html) => {
      const tStart = html.indexOf("function supTrackDispatch");
      expect(tStart).toBeGreaterThan(0);
      const tBody = html.slice(tStart, tStart + 1600);
      expect(tBody).toContain('!== "super"'); // 只跟 super 派出的任务
      expect(tBody).toContain('kind: "task"');
 // task.submitted/task.changed 通用分支挂 supTrackDispatch
      const gStart = html.indexOf('m.type === "task.submitted" || m.type === "task.changed"');
      expect(html.slice(gStart, gStart + 900)).toContain("supTrackDispatch(m);");
 // 派发卡构造:状态徽章+摘要+点卡跳 session(data-supact="open" data-sid)
      const cStart = html.indexOf("function supDispatchCardHtml");
      const cBody = html.slice(cStart, cStart + 2000);
      expect(cBody).toContain('data-supact="open"');
      expect(cBody).toContain("data-sid");
 // supRenderChat 渲染 dispatch/dream 两类卡
      const rStart = html.indexOf("function supRenderChat");
      expect(html.slice(rStart, rStart + 6000)).not.toContain('t.kind === "dispatch"');
      expect(html).toContain("function supRenderResults"); // 结果流渲染器
      expect(html).toContain("function pushSuperResult"); // 结果入流(不写聊天 entries)
    });
  });
 // 派发卡时间:运行中「已运行 X 分钟」(now-createdAt),终态「用时 X 分钟」(updatedAt-createdAt),<1 分钟「刚刚」
  it("④b 派发卡时间:运行中→已运行,终态→用时,不足 1 分钟→刚刚", async () => {
    await withPanel(7946, (html) => {
      const src = extractFn(html, "supDurText") + String.fromCharCode(10) + extractFn(html, "supTaskElapsedText");
      const run = new Function("supState", src + String.fromCharCode(10) + "return { supDurText, supTaskElapsedText };") as
        (s: unknown) => { supDurText: (ms: unknown) => string; supTaskElapsedText: (r: Record<string, unknown>) => string };
      const f = run({ dispatch: {} });
      const now = Date.now();
 // 运行中:从 createdAt 起到现在,分钟向下取整
      expect(f.supTaskElapsedText({ taskId: "t1", state: "running", createdAt: now - 5 * 60000 - 20000 })).toBe("已运行 5 分钟");
      expect(f.supTaskElapsedText({ taskId: "t1", state: "queued", createdAt: now - 90000 })).toBe("已运行 1 分钟");
 // 终态:createdAt → updatedAt
      const c0 = now - 60 * 60000;
      expect(f.supTaskElapsedText({ taskId: "t2", state: "done", createdAt: c0, updatedAt: c0 + 12 * 60000 })).toBe("用时 12 分钟");
      expect(f.supTaskElapsedText({ taskId: "t3", state: "failed", createdAt: c0, updatedAt: c0 + 3 * 60000 + 40000 })).toBe("用时 3 分钟");
      expect(f.supTaskElapsedText({ taskId: "t3", state: "cancelled", createdAt: c0, updatedAt: c0 + 2 * 60000 })).toBe("用时 2 分钟");
 // 不足 1 分钟:只显示「刚刚」,不出现「0 分钟」;缺时间字段不编数
      expect(f.supTaskElapsedText({ taskId: "t4", state: "running", createdAt: now - 40000 })).toBe("刚刚");
      expect(f.supTaskElapsedText({ taskId: "t4", state: "done", createdAt: now - 30000, updatedAt: now })).toBe("刚刚");
      expect(f.supTaskElapsedText({ taskId: "t5", state: "running" })).toBe("");
      expect(f.supDurText(5.9 * 60000)).toBe("5 分钟"); // 向下取整
 // 条目缺 createdAt/updatedAt 时回退 supState.dispatch 同 taskId
      const g = run({ dispatch: { t9: { state: "done", createdAt: c0, updatedAt: c0 + 7 * 60000 } } });
      expect(g.supTaskElapsedText({ taskId: "t9" })).toBe("用时 7 分钟");
 // 卡头真的渲染出来(.srf-dur + 运行中/终态两种色调)
      const cardSrc = extractFn(html, "supTaskCardHtml");
      expect(cardSrc).toContain("srf-dur");
      expect(cardSrc).toContain('dur.indexOf("已运行") === 0 ? "run" : "ok"');
 // 透传面:supTrackDispatch 的载荷带 createdAt/updatedAt;索引帧 merge 不覆盖正文/noticeAt;终态补拉
      const tBody = html.slice(html.indexOf("function supTrackDispatch"), html.indexOf("function supTrackDispatch") + 2600);
      expect(tBody).toContain("createdAt: merged.createdAt");
      expect(tBody).toContain("updatedAt: merged.updatedAt");
      expect(tBody).toContain("Object.assign({}, prev || {}, t)");
      expect(tBody).toContain("terminalNow && asked !== stateNow");
    });
  });
  it("⑤ 做梦卡:super.dream 广播进结果流;结果卡=条数/待关注+成本", async () => {
    await withPanel(7937, (html) => {
 // superOnMsg 挂 super.dream 分支
      const mStart = html.indexOf("function superOnMsg");
      expect(mStart).toBeGreaterThan(0);
      const mBody = html.slice(mStart, mStart + 3500);
      expect(mBody).toContain('m.type === "super.dream"');
      expect(mBody).toContain('kind: "dream"');
 // turn.done 实时帧不带 toolCalls:回拉一次 history,让工具卡/派发关系条立即出现
      expect(mBody).toContain('m.type === "super.turn.done"');
      expect(mBody).toContain('type: "super.history", sinceSeq: 0');
 // 结果卡:点卡进机制报告 + 「几条结果/几条待关注」+ 成本(缺价如实标注)
      const dStart = html.indexOf("function supDreamCardHtml");
      const dBody = html.slice(dStart, dStart + 2500);
      expect(dBody).toContain('data-idedetail="dream"');
      expect(dBody).toContain("待关注");
      expect(dBody).toContain("amountCny"); // ¥(缺价=如实标注,不按 0 冒充)
      expect(dBody).toContain("totalTokens"); // tokens
      expect(dBody).toContain("未计价"); // 缺价词
    });
  });
  it("⑥ 三栏联动+全量运行;rsiPollSync 跟随 super;模板零内联 onclick", async () => {
    await withPanel(7938, (html) => {
 // 机制卡「运行」→ 回 super 视图(做梦卡注入 super 会话)
      const rStart = html.indexOf('if (act === "run")');
      expect(rStart).toBeGreaterThan(0);
      expect(html.slice(rStart, rStart + 400)).toContain('switchView("super")');
 // 三栏交互绑定:活动栏/侧栏/中栏/聊天流详情/聊天窗折叠
      expect(html).toContain('document.getElementById("superIdeAct").addEventListener');
      expect(html).toContain('document.getElementById("superIdeSide").addEventListener');
      expect(html).toContain('document.getElementById("superIdeMain").addEventListener');
      expect(html).toContain('document.getElementById("superChatBody").addEventListener');
      expect(html).toContain("superLayoutInit()");
      expect(html).toContain('superLayoutGrip($("superSbGrip"), "sb")');
      expect(html).toContain('superLayoutGrip($("superChatGrip"), "chat")');
      expect(html).toContain("superIdeZoneSet");
      expect(html).toContain("function superIdeOpen");
      expect(html).toContain('data-idedetail="task"'); // 派发卡「详情→」
      expect(html).toContain('data-idedetail="dream"'); // 做梦完成卡「查看报告→」
      expect(html).toContain('superIdeZoneSet("health")'); // 初始区=健康一屏(默认首屏)
      expect(html).toContain("function superHealthRender"); // 健康一屏渲染器(缺失即页面首屏 ReferenceError)
      expect(html).toContain("function rsiHealthAgg");
      expect(html).toContain("function renderMechCards");
      expect(html).toContain("spide-mcard"); // 12 机制体检卡
      expect(html).toContain('data-health-act="runall"'); // 空态引导按钮
      expect(html).toContain('data-health-act="refresh"'); // 加载/错误态重试入口
      expect(html).toContain("spide-health-loading"); // 从未收到 rsi.status 时=加载中,不伪装"无数据"
      expect(html).toContain("rsi-card-focus"); // 体检卡→机制卡聚焦高亮
      expect(html).toContain('$("rsiRunAll").onclick');
 // 全量运行:只发已启用机制 + 防重入 + 发出后停留 super 视图
      const aStart = html.indexOf("function rsiRunAllFire");
      const aBody = html.slice(aStart, aStart + 1800);
      expect(aBody).toContain("if (!id || !en) continue");
      expect(aBody).toContain("btn.disabled");
      expect(aBody).toContain('type: "rsi.mechanism.run", id');
      expect(aBody).toContain('switchView("super")');
 // rsiRender:运行中态同步禁用全量运行按钮
      expect(html).toContain("allBtn.disabled = anyRunning");
 // rsiPollSync:跟随 super(做梦区轮询不停摆);离开指挥台停表
      const pStart = html.indexOf("function rsiPollSync");
      const pBody = html.slice(pStart, pStart + 900);
      expect(pBody).toContain('name !== "rsi" && name !== "dream" && name !== "super"');
      expect(pBody).toContain("rsiEvStart()");
      expect(pBody).not.toContain("rsichat");
 // applyViewChrome:rsi/dream/task 别名收敛为 super 单视图(旧三段互斥点亮退役)
      expect(html).toContain('if (name === "rsi" || name === "dream" || name === "task") name = "super";');
      expect(html).not.toContain('classList.toggle("tab-dream"');
      expect(html).not.toContain('classList.toggle("tab-task"');
 // super pane 模板段零内联 onclick
      const segStart = html.indexOf('id="view-super"');
      const seg = html.slice(segStart, html.indexOf('id="view-nodes"'));
      expect(seg).not.toContain("onclick=");
      expect(seg).not.toContain("onload=");
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

// nav-to-sidebar(用户):「新建任务/指挥台/RSI 看板」三入口从底部条迁左侧栏顶部块。
// markup/id 逐字保留(onclick 绑定零改),底部条只留其余入口不重复保留。
describe(" 三入口迁左侧栏(新建任务/指挥台/RSI 看板)", () => {
  it("侧栏 #sbNav 含三入口;底部条 .sb-acts 内无三入口(act-new/super/rsi 各只出现在侧栏)", async () => {
    await withPanel(7931, (html) => {
 // ① 侧栏顶部块:容器标记 + 三入口 markup 在块内
      expect(html).toContain('<nav class="sb-nav" id="sbNav" data-nav="sb-nav"');
      const navStart = html.indexOf('id="sbNav"');
      expect(navStart).toBeGreaterThan(0);
      const navScope = html.slice(navStart, navStart + 1500);
      expect(navScope).toContain('id="act-new"');
      expect(navScope).toContain('id="act-super"');
      expect(navScope).toContain('id="act-rsi"');
 // ② 点击处理复用既有绑定(零内联 onclick,事件在 script-2 的 $.onclick)
      expect(html).toContain('$("act-super").onclick = () => { superOpen(); superIdeZoneSet("health"); superIdeOpen("health"); }');
      expect(html).toContain('$("act-rsi").onclick = () => { switchView("rsi"); superIdeZoneSet("dream"); superIdeOpen("dream", ""); }');
      expect(html).toContain('$("act-new").onclick = newDraft');
 // ③ 底部条 .sb-acts 里不再有三入口:三 id 各只在全文出现一次(即侧栏处)
      for (const id of ["act-new", "act-super", "act-rsi"]) {
        const hits = html.split(`id="${id}"`).length - 1;
        expect(hits).toBe(1);
      }
 // 底部条容器仍在(其余入口不动),且其起始点在侧栏块之后
      const actsStart = html.indexOf('<div class="sb-acts">');
      expect(actsStart).toBeGreaterThan(navStart);
      const actsScope = html.slice(actsStart, actsStart + 6000);
      expect(actsScope).not.toContain('id="act-new"');
      expect(actsScope).not.toContain('id="act-super"');
      expect(actsScope).not.toContain('id="act-rsi"');
 // ④ 窄屏塌折:侧栏三入口随 860px 图标条规则收成纯图标(不额外做悬浮)
      expect(html).toContain(".sb-nav .sb-act{justify-content:center;gap:0;font-size:0;padding:9px 6px}");
    });
  });
});
