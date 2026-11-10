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
      expect(html).toContain('CanvasShell.setMode("canvas")');
      // composer 药丸:形态联动文案 + 高亮态
      expect(html).toContain('inCanvas ? "经典模式" : "画布模式"');
      expect(html).toContain('btn.classList.toggle("on", inCanvas)');
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
