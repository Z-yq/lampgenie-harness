/**
 * IDE 深化(VSCode P0 核心编辑体验)契约测试 —— PAGE 源码字符串断言。
 * 覆盖:①面包屑 #ideCrumb ②命令面板(Ctrl+Shift+P,含转到文件/IDE 命令) ③查找替换(Monaco find
 * options + addCommand + 全项目 fs.grep 侧栏面板) ④IDE 域 7 条快捷键进 KEY_DEFAULTS ⑤文件树
 * oncontextmenu 分支与 fs.mkdir/fs.remove/fs.rename 发包 ⑥状态栏 Ln/Col 等分段渲染
 * ⑦IDE 域拦截守卫(dataset.view !== "ide")≥3 处。
 * 风格照抄 panel-canvas-fixes.test.ts:servePanel 取真实面板 HTML,再做字符串/函数体断言
 * (零构建链,页面 JS 是单 HTML 里的内联脚本)。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** 从面板 HTML 里切出顶层函数源码(花括号配平),用于断言函数体内行为。 */
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
  const srv = servePanel(port, () => { /* 不需要 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

describe("IDE 深化 P0(VSCode 编辑体验)", () => {
  it("①面包屑 #ideCrumb:骨架插在 #ideTabs 与 #ideBody 之间,分段可点 + 右侧语言/行列", async () => {
    await withPanel(7896, (html) => {
      expect(html).toContain('id="ideCrumb"');
      // DOM 顺序:标签条 → 面包屑 → 编辑体(骨架只重写 #ideBody.innerHTML,兄弟节点安全)
      const iTabs = html.indexOf('id="ideTabs"');
      const iCrumb = html.indexOf('id="ideCrumb"');
      const iBody = html.indexOf('id="ideBody"');
      expect(iTabs).toBeGreaterThan(0);
      expect(iCrumb).toBeGreaterThan(iTabs);
      expect(iBody).toBeGreaterThan(iCrumb);
      // 面包屑渲染:项目名首段 + 路径分段可点 + 末段(文件)不可跳目录 + 右侧语言与行列
      const crumb = extractFn(html, "ideCrumbRender");
      expect(crumb).toContain('data-cb-abs="');
      expect(crumb).toContain('data-cb-file="');
      expect(crumb).toContain("cb-seg last");
      expect(crumb).toContain("ideLangOf(t.path)");
      expect(crumb).toContain("Ln ");
      // 目录段点击=展开并滚到树行
      const goto = extractFn(html, "ideCrumbGotoDir");
      expect(goto).toContain("ideExpanded.add(");
      expect(goto).toContain("scrollIntoView");
    });
  }, 30_000);

  it("②命令面板 Ctrl+Shift+P:独立 #ideCmd + 转到文件/IDE 命令清单 + ↑↓ Enter Esc", async () => {
    await withPanel(7897, (html) => {
      // 独立面板(不污染 #cc 的命令中心域判定)
      expect(html).toContain('id="ideCmd"');
      expect(html).toContain('id="ideCmdQ"');
      expect(html).toContain("#ideCmdList");
      expect(html).toContain(".ide-cmd-item");
      // 命令清单:转到文件 + 保存/另存为/关闭(其他)标签/新建文件/新建文件夹/重命名/删除/刷新树/
      // 换行/minimap/主题/查找/替换/全项目搜索
      expect(html).toContain("const IDE_COMMANDS = [");
      for (const t of ["转到文件", "保存当前文件", "另存为", "关闭当前标签", "关闭其他标签", "新建文件",
        "新建文件夹", "重命名当前文件", "删除当前文件", "刷新文件树", "切换自动换行", "切换 minimap",
        "在当前文件查找", "在当前文件替换", "全项目搜索"]) {
        expect(html, "IDE_COMMANDS 缺少 " + t).toContain(t);
      }
      // 转到文件:树缓存模糊匹配 + files.search 兜底(懒加载的深层文件也能命中)
      const render = extractFn(html, "ideCmdRender");
      expect(render).toContain("ideFileList()");
      expect(render).toContain("ideFuzzy(");
      expect(render).toContain("ideGotoFallback(");
      expect(extractFn(html, "ideGotoFallback")).toContain('type: "files.search"');
      // 键盘:↑↓ 移动 hot、Enter 执行、Esc 关闭
      expect(html).toContain("ideCmdHot = (ideCmdHot + (e.key === \"ArrowDown\" ? 1 : ideCmdItems.length - 1)) % ideCmdItems.length");
      expect(html).toContain("ideCmdExec(ideCmdHot)");
      // 点击执行 + 执行后关闭
      expect(html).toContain("el.onclick = () => ideCmdExec(Number(el.dataset.ci))");
      expect(extractFn(html, "ideCmdExec")).toContain("ideCmdClose()");
    });
  }, 30_000);

  it("③查找替换:Monaco find options + addCommand(Ctrl+F/Ctrl+H)+ 全项目 fs.grep 侧栏面板", async () => {
    await withPanel(7898, (html) => {
      // 单文件:find widget 预填选区 + 多行选区范围内查找
      expect(html).toContain("find: { seedSearchStringFromSelection: \"always\", autoFindInSelection: \"multiline\" }");
      // Ctrl+F / Ctrl+H 交给 Monaco 自己的 find widget(不被面板 keydown 吞)
      expect(html).toContain("ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF");
      expect(html).toContain("ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH");
      expect(html).toContain('getAction("actions.find")');
      expect(html).toContain('getAction("editor.action.startFindReplaceAction")');
      // 全项目搜索面板:侧栏 #ideFind + fs.grep 发包 + 文件:行:片段 + 点击定位
      expect(html).toContain('id="ideFind"');
      expect(html).toContain('id="ideFindQ"');
      expect(html).toContain('id="ideFindRes"');
      expect(extractFn(html, "ideFindSearch")).toContain('type: "fs.grep"');
      const fres = extractFn(html, "ideFindRender");
      expect(fres).toContain("ide-find-hit");
      expect(fres).toContain("data-fp=");
      expect(fres).toContain("data-fl=");
      expect(fres).toContain("ideOpenFile(el.dataset.fp, { line: Number(el.dataset.fl) })");
      // 点击命中 → revealLineInCenter + setSelection + 整行高亮
      const reveal = extractFn(html, "ideRevealLine");
      expect(reveal).toContain("revealLineInCenter");
      expect(reveal).toContain("setSelection");
      expect(reveal).toContain("deltaDecorations");
      expect(html).toContain(".ide-hit-line");
    });
  }, 30_000);

  it("④IDE 7 条快捷键进 KEY_DEFAULTS 且全部在 IDE 域内消费", async () => {
    await withPanel(7899, (html) => {
      // 键位登记(仅追加,不改既有 8 条)
      expect(html).toContain('"ide-command-palette": "ctrl+shift+p"');
      expect(html).toContain('"ide-goto-file": "ctrl+p"');
      expect(html).toContain('"ide-search": "ctrl+shift+f"');
      expect(html).toContain('"ide-rename": "f2"');
      expect(html).toContain('"ide-new-file": "ctrl+shift+n"');
      expect(html).toContain('"ide-close-tab": "ctrl+w"');
      expect(html).toContain('"ide-wordwrap": "alt+z"');
      // 既有 8 条零改(回归锚点)
      expect(html).toContain('"open-search": "ctrl+k"');
      expect(html).toContain('"model-menu": "ctrl+m"');
      // 动作全部由 hitKey 消费(IDE 域监听内)
      for (const id of ["ide-command-palette", "ide-goto-file", "ide-search", "ide-rename", "ide-new-file", "ide-close-tab", "ide-wordwrap"]) {
        expect(html, "未消费快捷键 " + id).toContain('hitKey(e, "' + id + '")');
      }
      // KEY_ACTIONS 描述齐备(设置页可自定义/可恢复默认)
      for (const id of ["ide-command-palette", "ide-goto-file", "ide-search", "ide-rename", "ide-new-file", "ide-close-tab", "ide-wordwrap"]) {
        expect(html).toContain('{ id: "' + id + '", desc: "IDE:');
      }
    });
  }, 30_000);

  it("⑤文件树右键分支 + 新建/重命名/删除发包(fs.mkdir / fs.write / fs.rename / fs.remove)", async () => {
    await withPanel(7900, (html) => {
      // 目录/文件两类行都绑 oncontextmenu → ideRowMenu(原实现只有 onclick)
      expect(html).toContain('el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); ideRowMenu(el.dataset.abs, ideRel(el.dataset.abs), true, e.clientX, e.clientY); };');
      expect(html).toContain('el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); ideRowMenu(el.dataset.abs, el.dataset.rel, false, e.clientX, e.clientY); };');
      // 菜单项:目录=新建文件/新建文件夹/重命名/删除/刷新此目录;文件=打开/重命名/删除/复制路径
      const menu = extractFn(html, "ideRowMenu");
      for (const label of ["新建文件…", "新建文件夹…", "重命名…", "删除目录", "刷新此目录", "打开", "删除", "复制路径"]) {
        expect(menu, "右键菜单缺少 " + label).toContain(label);
      }
      // 侧栏头部「＋文件 / ＋文件夹」按钮
      expect(html).toContain('id="ideNewFile"');
      expect(html).toContain('id="ideNewDir"');
      // 三通道发包
      expect(extractFn(html, "ideNewDir")).toContain('type: "fs.mkdir"');
      expect(extractFn(html, "ideRename")).toContain('type: "fs.rename"');
      expect(extractFn(html, "ideDelete")).toContain('type: "fs.remove"');
      expect(extractFn(html, "ideDelete")).toContain("recursive: true"); // 目录递归须显式传
      expect(extractFn(html, "ideNewFile")).toContain('type: "file.write"'); // 新建文件=空内容写
      // 脏标签处理:重命名跟随(path/model 重建)、删除先确认再关标签
      const ren = extractFn(html, "ideRenameTabs");
      expect(ren).toContain("t.model.dispose()");
      expect(ren).toContain('t.name = t.path.split("/").pop()');
      expect(html).toContain("function ideCloseTabsUnder(");
      expect(extractFn(html, "ideDelete")).toContain("uiConfirm(");
      // 成功后失效 dirCache 并重渲树
      expect(extractFn(html, "ideInvalidate")).toContain("dirCache.delete(");
      expect(extractFn(html, "ideInvalidate")).toContain("ideTreeRender()");
      expect(extractFn(html, "ideFsResult")).toContain("ideInvalidateParent(");
    });
  }, 30_000);

  it("⑥状态栏分段:Ln/Col、选区、语言、缩进、编码、EOL、脏态、行数", async () => {
    await withPanel(7901, (html) => {
      for (const id of ["ideStMain", "ideStPos", "ideStSel", "ideStLang", "ideStIndent", "ideStEnc", "ideStEol", "ideStDirty", "ideStCount"]) {
        expect(html, "状态栏缺少分段 " + id).toContain('id="' + id + '"');
      }
      const st = extractFn(html, "ideStatusSet");
      expect(st).toContain('"Ln " + ideCursor.line + ", Col " + ideCursor.col');
      expect(st).toContain('"已选 "');
      expect(st).toContain('"UTF-8"');
      expect(st).toContain('"CRLF"');
      expect(st).toContain("行 · ");
      // 光标位置来自 Monaco 事件
      expect(html).toContain("ed.onDidChangeCursorPosition(");
      expect(extractFn(html, "ideStatusSet")).toContain("ideCrumbRender()");
      // 旧 ideStatus(t) 单文本写入仍可用(兼容)
      expect(extractFn(html, "ideStatus")).toContain('$("ideStMain")');
    });
  }, 30_000);

  it("⑦IDE 域拦截守卫 ≥3 处(dataset.view !== \"ide\")", async () => {
    await withPanel(7902, (html) => {
      const n = (html.match(/dataset\.view !== "ide"/g) || []).length;
      expect(n).toBeGreaterThanOrEqual(3);
      // 命令面板键盘 / IDE 动作键 / 搜索面板键盘 三个监听器各自带守卫
      expect(html).toContain("① 命令面板键盘域守卫");
      expect(html).toContain("② IDE 动作快捷键域守卫");
      expect(html).toContain("③ 全项目搜索面板键盘域守卫");
      // 非 IDE 视图的既有语义零改(Ctrl+Shift+P=ccOpen / Ctrl+Shift+F=fitAll 原分支仍在)
      expect(html).toContain('if (ctrl && e.shiftKey && key === "p")');
      expect(html).toContain('if (ctrl && e.shiftKey && key === "f")');
    });
  }, 30_000);
});

describe("IDE 第二批(VSCode 对齐:活动栏/SCM/Diff/问题/终端/大纲)", () => {
  it("①活动栏:左缘竖条 5 图标(tree/scm/problems/terminal/outline)+ 点击互斥切换与记忆", async () => {
    await withPanel(7903, (html) => {
      expect(html).toContain('id="ideActBar"');
      for (const a of ["tree", "scm", "problems", "terminal", "outline"]) {
        expect(html, "活动栏缺图标 " + a).toContain('data-act="' + a + '"');
      }
      const sw = extractFn(html, "ideActSwitch");
      expect(sw).toContain('localStorage.setItem("zh:ide-act"');
      expect(sw).toContain("ideTree");
      expect(sw).toContain('act : "tree"');
      // terminal=底部抽屉开关,不占侧栏互斥
      expect(html).toContain('el.dataset.act; if (a === "terminal") ideTermToggle(); else ideActSwitch(a);');
      expect(sw).toContain('ideScmRefresh()'); // 进 SCM 即拉状态
    });
  }, 30_000);

  it("②四面板容器:#ideScm/#ideProblems/#ideOutline 与 #ideTree 并列(默认 display:none)", async () => {
    await withPanel(7904, (html) => {
      for (const id of ["ideScm", "ideProblems", "ideOutline"]) {
        expect(html, "缺面板容器 " + id).toContain('id="' + id + '"');
        expect(html, id + " 应默认隐藏").toContain('id="' + id + '" style="display:none"');
      }
      expect(html).toContain('class="ide-tree" id="ideTree"'); // 树仍常驻,零破坏
    });
  }, 30_000);

  it("③SCM:status 缓存→改动列表;commit 空信息前端拒;树徽标 M/U/D", async () => {
    await withPanel(7905, (html) => {
      expect(html).toContain('id="ideScmList"');
      expect(html).toContain('id="ideScmMsg"');
      expect(html).toContain('id="ideScmCommit"');
      const onStatus = extractFn(html, "ideScmOnStatus");
      expect(onStatus).toContain("m.changes");
      expect(onStatus).toContain("ideScmChanged = new Set(");
      expect(onStatus).toContain("ideTreeRender()");
      // commit:空 message 前端拒 + 发 git.commit(message)
      const commitIdx = html.indexOf('$("ideScmCommit").onclick');
      expect(commitIdx, "ideScmCommit 绑定在场").toBeGreaterThan(0);
      const commitSlice = html.slice(commitIdx, commitIdx + 700);
      expect(commitSlice).toContain("提交信息不能为空");
      expect(commitSlice).toContain('"git.commit"');
      expect(commitSlice).toContain("message: msg");
      // 树徽标:ideScmLetter 收敛 M/U/D + ideTreeRender 命中渲染角标
      const letter = extractFn(html, "ideScmLetter");
      expect(letter).toContain('k === "A" ? "U" : k');
      expect(extractFn(html, "ideTreeRender")).toContain("ideScmChanged.has(openRel)");
      expect(extractFn(html, "ideTreeRender")).toContain("ft-badge");
    });
  }, 30_000);

  it("④Diff 双路:createDiffEditor 懒建复用 + LCS 回退着色;原文=git.show HEAD / 修改=磁盘", async () => {
    await withPanel(7906, (html) => {
      const ensure = extractFn(html, "ideDiffEnsure");
      expect(ensure).toContain("createDiffEditor");
      expect(ensure).toContain("if (ideDiffEditor) return ideDiffEditor;"); // 懒建一次复用
      const lcs = extractFn(html, "ideDiffLcs");
      expect(lcs).toContain("d-del");
      expect(lcs).toContain("d-add");
      const open = extractFn(html, "ideDiffOpen");
      expect(open).toContain('"git.show"');
      expect(open).toContain('"HEAD"');
      expect(open).toContain('mode: "diff"');
      const render = extractFn(html, "ideDiffRender");
      expect(render).toContain("ideDiffEnsure()");
      expect(render).toContain("ideDiffLcs(");
    });
  }, 30_000);

  it("⑤问题面板:lsp.diagnostics 发包 + setModelMarkers(owner=ide)+ 点击定位 + 关标签清标记", async () => {
    await withPanel(7907, (html) => {
      const req = extractFn(html, "ideDiagRequest");
      expect(req).toContain('"lsp.diagnostics"');
      expect(req).toContain("paths: list");
      expect(req).toContain("projectId");
      const markers = extractFn(html, "ideProbMarkers");
      expect(markers).toContain("setModelMarkers");
      expect(markers).toContain('"ide"');
      const render = extractFn(html, "ideProbRender");
      expect(render).toContain("data-p");
      expect(render).toContain("ideOpenFile");
      const close = extractFn(html, "ideClose");
      expect(close).toContain('setModelMarkers(t.model, "ide", [])');
      expect(close).toContain("ideProbAll[t.path] = []");
    });
  }, 30_000);

  it("⑥终端:term.session 四消息 + 500ms 轮询 + 隐藏停轮询 + ANSI 剥离 + 无假回显", async () => {
    await withPanel(7908, (html) => {
      expect(html).toContain('id="ideTerm"');
      expect(html).toContain('id="ideTermIn"');
      expect(html).toContain('id="ideTermOut"');
      expect(extractFn(html, "ideTermEnsure")).toContain('"term.session.open"');
      const poll = extractFn(html, "ideTermPollStart");
      expect(poll).toContain("500");
      expect(extractFn(html, "ideTermPollStop")).toContain("clearInterval");
      expect(extractFn(html, "ideTermAnsi")).toContain("x1b");
      expect(html).toContain('"term.session.send"');
      expect(html).toContain("data: line + ");
      expect(html).toContain("未连接,忽略输入"); // 禁止假回显
      expect(extractFn(html, "ideTermToggle")).toContain("ideTermPollStop()"); // 隐藏停轮询
      expect(html).toContain('"term.session.close"');
      expect(extractFn(html, "ideTermToggle")).toContain("force");
    });
  }, 30_000);

  it("⑦大纲:TS/JS(含 tsx/jsx/mts/cts)符号抽取;其它语言禁用态;Ctrl+Shift+O 双路", async () => {
    await withPanel(7909, (html) => {
      expect(html).toContain('id="ideOutlineList"');
      expect(html).toContain('id="ideOutlineQ"');
      const ext = html.match(/IDE_OUTLINE_EXT = new Set\(\[([^\]]*)\]/);
      expect(ext, "IDE_OUTLINE_EXT 集合在场").toBeTruthy();
      for (const e of ['"ts"', '"tsx"', '"js"', '"jsx"', '"mts"', '"cts"']) {
        expect(ext && ext[1], "大纲扩展名缺 " + e).toContain(e);
      }
      expect(extractFn(html, "ideOutlineRender")).toContain("大纲仅支持 TS/JS");
      const quick = extractFn(html, "ideOutlineQuick");
      expect(quick).toContain("editor.action.quickOutline");
      expect(quick).toContain('ideActSwitch("outline")');
    });
  }, 30_000);

  it("⑧KEY_DEFAULTS 新 2 条 + IDE_COMMANDS 新 5 条视图直达(全真 run)", async () => {
    await withPanel(7910, (html) => {
      const kd = html.match(/const KEY_DEFAULTS = \{[\s\S]*?\n\};/);
      expect(kd, "KEY_DEFAULTS 块在场").toBeTruthy();
      expect(kd && kd[0]).toContain('"ide-terminal": "ctrl+`"');
      expect(kd && kd[0]).toContain('"ide-outline": "ctrl+shift+o"');
      expect(html).toContain('hitKey(e, "ide-terminal")');
      expect(html).toContain('hitKey(e, "ide-outline")');
      const cmds = html.slice(html.indexOf("const IDE_COMMANDS = ["), html.indexOf("];", html.indexOf("const IDE_COMMANDS = [")));
      for (const c of ["view-tree", "view-scm", "view-problems", "view-terminal", "view-outline"]) {
        expect(cmds, "IDE_COMMANDS 缺 " + c).toContain('id: "' + c + '"');
      }
      expect(cmds).toContain('ideActSwitch("tree")');
      expect(cmds).toContain('ideActSwitch("scm")');
      expect(cmds).toContain('ideActSwitch("problems")');
      expect(cmds).toContain('ideActSwitch("outline")');
      expect(cmds).toContain("ideTermToggle()");
    });
  }, 30_000);

  it("⑩ HTML 预览:IDE_COMMANDS 含 ide.preview + 双态切换/保存刷新接线", async () => {
    await withPanel(7912, (html) => {
      const cmds = html.slice(html.indexOf("const IDE_COMMANDS = ["), html.indexOf("];", html.indexOf("const IDE_COMMANDS = [")));
      expect(cmds, "IDE_COMMANDS 缺 ide.preview").toContain('id: "ide.preview"');
      expect(cmds).toContain("预览当前 HTML");
      // 双态:头部 seg 钮 + idePvSet 切换 + 预览层 iframe 直连 /ide/preview/<pid>/<rel>
      expect(html).toContain('id="idePvSeg"');
      expect(extractFn(html, "idePvSet")).toContain("pvView");
      const render = extractFn(html, "idePreviewRender");
      expect(render).toContain('"/ide/preview/"');
      expect(render).toContain("encodeURIComponent");
      // 保存刷新联动:file.write 回包 ok → idePreviewKick 换 r=Date.now() 重载
      expect(extractFn(html, "ideSaveResult")).toContain("idePreviewKick(t)");
      expect(extractFn(html, "idePreviewKick")).toContain("Date.now()");
    });
  }, 30_000);

  it("⑨IDE 域守卫 ≥3 回归:新键位消费位于 ② 动作键守卫监听器内(非 IDE 视图零劫持)", async () => {
    await withPanel(7911, (html) => {
      const n = (html.match(/dataset\.view !== "ide"/g) || []).length;
      expect(n).toBeGreaterThanOrEqual(3);
      const g = html.indexOf("② IDE 动作快捷键域守卫");
      const t = html.indexOf('hitKey(e, "ide-terminal")');
      const o = html.indexOf('hitKey(e, "ide-outline")');
      expect(g).toBeGreaterThan(0);
      expect(t).toBeGreaterThan(g);
      expect(o).toBeGreaterThan(g);
    });
  }, 30_000);

  it("⑩requestId 路由与 diff 标签接管 file.read(git.show/term.session 兜底 type 回包)", async () => {
    await withPanel(7912, (html) => {
      expect(html).toContain("ideReqMap");
      expect(html).toContain("ideReqMap.has(m.requestId)");
      expect(html).toContain('m.type === "git.show.result"');
      expect(html).toContain('m.type === "term.session.open.result"');
      expect(extractFn(html, "ideRenderRead")).toContain('mode === "diff"');
    });
  }, 30_000);
});

describe("IDE Markdown 预览媒体链接(图/视频/相对链接渲染)", () => {
  it("①mdInlineScan io 通道:img/media/link 回调钩子在场,默认 /uploads? 白名单保留(零变)", async () => {
    await withPanel(7913, (html) => {
      const fn = extractFn(html, "mdInlineScan");
      expect(fn).toContain('typeof io.media === "function"');
      expect(fn).toContain('typeof io.img === "function"');
      expect(fn).toContain('typeof io.link === "function"');
      expect(fn, "默认图片白名单必须保留").toContain('src.indexOf("/uploads?") === 0');
      expect(fn, "默认链接白名单必须保留").toContain('url.indexOf("http") === 0');
      expect(fn).toContain("mdInlineScan(inner, depth + 1, io)"); // 嵌套递归穿 io
      const head = extractFn(html, "mdInline");
      expect(head).toContain("mdInlineScan(esc(t), 0, io)");
    });
  }, 30_000);

  it("②mdToHtml 既有调用零改:wiki 等仍两参,仅 md 预览分支传第 3 参", async () => {
    await withPanel(7914, (html) => {
      const body = extractFn(html, "ideBodyRender");
      expect(body).toContain('mdToHtml(t.content, "", ideMdIo(t))'); // 预览分支接线
      const wiki = extractFn(html, "wikiRenderMarkdown"); // wiki 侧仍两参(默认通道零变)
      expect(wiki).toContain('mdToHtml(md || "", "")');
    });
  }, 30_000);

  it("③ideMdIo:相对路径重写 /ide/asset(折叠 ../、越根拒绝)、视频 <video>、.md 链接 data-ide-mdlink", async () => {
    await withPanel(7915, (html) => {
      const io = extractFn(html, "ideMdIo");
      expect(io).toContain("<video");
      expect(io).toContain("data-ide-mdlink");
      expect(io).toContain("ideMdAssetUrl"); // 媒体/图统一走 asset 重写
      const url = extractFn(html, "ideMdAssetUrl");
      expect(url).toContain('"/ide/asset?path=" + encodeURIComponent(p)');
      expect(url, "2026-11-06:带 from=md 相对路径(服务端按 md 同目录优先解析)").toContain('"&from=" + encodeURIComponent(from)');
      expect(url).toContain('"&pid=" + encodeURIComponent(ideRoot ? ideRoot.pid : "")');
      const relFn = extractFn(html, "ideMdRelPath");
      expect(relFn).toContain('if (p === "..")'); // 折叠 ..;越根拒绝
      expect(relFn).toContain("return st.length ? st.join"); // 越根返回 null
      expect(relFn, "链接同样按 md 目录解析").toContain("mdPath");
    });
  }, 30_000);

  it("③b阅读密度:令牌放大 + 表格包裹 + 段落成 <p>(不再逐行 <br>)", async () => {
    await withPanel(7917, (html) => {
      expect(html, "--gap-block 8→12px").toContain("--gap-block:12px");
      expect(html, "--indent-1 14→22px").toContain("--indent-1:22px");
      expect(html, "--gap-head 标题上间距").toContain("--gap-head:22px");
      const md = extractFn(html, "mdToHtml");
      expect(md).toContain("flushPara");               // 段落聚合
      expect(md).toContain('"<p>" + paraBuf.join("<br>") + "</p>"');
      expect(md).toContain('class="md-table-wrap"');    // 宽表横向滚动
      expect(md, "io 必须透传到行内渲染").toContain("mdInline(line, io)");
      expect(html).toContain(".md-table-wrap{max-width:100%;overflow-x:auto");
      expect(html).toContain("padding:9px 13px");       // 表格单元格内边距
      expect(html).toContain("tbody tr:nth-child(even)"); // 隔行底色
    });
  }, 30_000);

  it("④#ideMdHost 事件委托:相对链接点击→ideOpenFile 开新标签", async () => {
    await withPanel(7916, (html) => {
      const sk = extractFn(html, "ideBodySkeleton");
      expect(sk).toContain('$("ideMdHost").addEventListener("click"');
      expect(sk).toContain('e.target.closest("[data-ide-mdlink]")');
      expect(sk).toContain('ideOpenFile(a.getAttribute("data-ide-mdlink")');
      expect(html).toContain(".ide-md video.md-video"); // 视频样式在场
    });
  }, 30_000);
});

/**
 * 文件类型图标(树/页签取形)+ 文件/目录右键一键注入聊天窗。
 * 切片口径:函数名 index → 下一个 "\nfunction " index(不依赖行号:panel.ts 行号会漂移)。
 */
function sliceFn(src: string, name: string): string {
  const head = "function " + name + "(";
  const i = src.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  const e = src.indexOf("\nfunction ", i + head.length);
  return src.slice(i, e < 0 ? src.length : e);
}

describe(" J5 文件类型图标与右键注入聊天窗", () => {
  it("① FILE_ICONS 顶层 ≥12 组,FILE_EXT_GROUP 覆盖 ts/py/json/md/img/data/bin/sh/git/lock/txt", async () => {
    await withPanel(7927, (html) => {
      const fi = html.indexOf("const FILE_ICONS = {");
      expect(fi, "未找到 FILE_ICONS 图标表").toBeGreaterThan(0);
      const fe = html.indexOf("};", fi);
      expect(fe).toBeGreaterThan(fi);
      const body = html.slice(fi, fe);
      const keys = (body.match(/\n\s{2}[a-z0-9]+:\s/g) ?? []).map((x) => x.trim().replace(":", ""));
      expect(keys.length, "FILE_ICONS 顶层 key(" + keys.join(",") + ")应 ≥12").toBeGreaterThanOrEqual(12);
      for (const k of ["ts", "js", "py", "json", "md", "img", "data", "bin", "sh", "git", "lock", "txt"]) {
        expect(keys, "FILE_ICONS 缺少组 " + k).toContain(k);
      }
      const gi = html.indexOf("const FILE_EXT_GROUP = {");
      expect(gi, "未找到 FILE_EXT_GROUP 映射表").toBeGreaterThan(0);
      const grp = html.slice(gi, html.indexOf("};", gi));
      const MAP: Array<[string, string]> = [["ts", "ts"], ["tsx", "ts"], ["py", "py"], ["json", "json"], ["md", "md"],
        ["png", "img"], ["html", "data"], ["zip", "bin"], ["sh", "sh"], ["gitignore", "git"], ["lock", "lock"], ["txt", "txt"]];
      for (const [ext, g] of MAP) {
        expect(new RegExp(ext + ":\\s*\"" + g + "\"").test(grp), "FILE_EXT_GROUP 缺映射 " + ext + " → " + g).toBe(true);
      }
    });
  }, 30_000);

  it("② fileGroupOf / fileIcon 就位(唯一取形口),旧名 fileIconOf 不得残留", async () => {
    await withPanel(7928, (html) => {
      expect(sliceFn(html, "fileGroupOf"), "fileGroupOf 应剥前导点并查组").toContain("lastIndexOf");
      const icon = sliceFn(html, "fileIcon");
      expect(icon).toContain("fileGroupOf(name)");
      expect(icon).toContain("fic-");
      expect(html, "不得残留旧取形口 fileIconOf").not.toContain("fileIconOf");
    });
  }, 30_000);

  it("③ 树/页签取形:ideTreeRender 走 fileIcon(en.name),ideTabsRender 走 fileIcon(t.path)", async () => {
    await withPanel(7929, (html) => {
      const tree = sliceFn(html, "ideTreeRender");
      expect(tree, "树文件行应按名字取形").toContain("fileIcon(en.name)");
      expect(tree, "树文件行不得再写死单一方框图标").not.toContain('ic("file")');
      expect(tree, "目录行保持 folder 形").toContain('ic("folder")');
      const tabs = sliceFn(html, "ideTabsRender");
      expect(tabs, "页签前缀应按路径取形").toContain("fileIcon(t.path");
      expect(tabs).toContain("tab-ic");
    });
  }, 30_000);

  it("④ 右键菜单:文件/目录分支都有「添加到聊天窗」,文件另有「作为附件添加」", async () => {
    await withPanel(7930, (html) => {
      const menu = sliceFn(html, "ideRowMenu");
      expect(menu).toContain("添加到聊天窗");
      expect(menu).toContain("作为附件添加");
      expect(menu, "目录分支 = isDir + ref").toMatch(/ideAddToChat\(abs, rel, true, "ref"\)/);
      expect(menu, "文件分支 ref").toMatch(/ideAddToChat\(abs, rel, false, "ref"\)/);
      expect(menu, "文件分支 att").toMatch(/ideAddToChat\(abs, rel, false, "att"\)/);
    });
  }, 30_000);

  it("⑤ ideAddToChat:直塞绝对路径(ATT_MAX_COUNT 上限 + pendingAtts.push),不退回 /upload 上传路径", async () => {
    await withPanel(7931, (html) => {
      const fn = sliceFn(html, "ideAddToChat");
      expect(fn, "附件上限必须复用既有 ATT_MAX_COUNT").toContain("ATT_MAX_COUNT");
      expect(fn, "必须直接入 pendingAtts(零拷贝)").toContain("pendingAtts.push");
      expect(fn, "不得退回 /upload 上传路径").not.toContain("/upload");
      expect(fn, "引用模式走 buildFileMention").toContain("buildFileMention");
      expect(fn, "收尾必须切回聊天视图并刷新引用条").toContain('switchView("chat")');
      expect(fn).toContain("fileRefRender()");
    });
  }, 30_000);
});
