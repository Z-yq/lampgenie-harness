/**
 * 看板(无限画布卡片)命名一致性守卫(2026-10-21 命名质感轮)。
 *
 * 单一来源 = panel.ts CV_CARDS 的 title/tag(命名约定:「中文意象 + 英文锚点」,见 CV_CARDS 上方注释)。
 * 本测试把三个消费面钉死在同一份 title 上,改 CV_CARDS 漏同步任何一处即红:
 *   ① 经典布局侧栏 sb-act:显示名与 title tooltip 都 = 卡片 title(与画布定位栏 tooltip 同串);
 *   ② 有 vw-head 的视图:vw-title = 卡片 title;无 vw-head 的自定义 chrome 视图走豁免表(豁免按
 *      chrome 标记实证,防止"视图改出 vw-head 却忘了进豁免表"静默腐烂);
 *   ③ 经典态 header 的 VIEW_NAMES = 卡片 title(chat 例外:主视图不亮名)。
 *
 * 另守底:每卡 title/tag 非空、title 无重名(画布上两张同名卡=定位栏/命令中心无法分辨)。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface Card { name: string; node: string; title: string; tag: string }

/** sb-act 按钮 id → 卡片 name(侧栏入口历史映射:act-sense 开的是档案不是透镜)。
 *  n3 看板融合(2026-10-22):「分身 Agents」卡与 act-subagents 按钮已删(能力并入子agent会话流),
 *  映射表同步移除——留着会让「按钮存在」断言拿旧卡名去查已删视图。 */
const SB_ACT_TO_CARD: Record<string, string> = {
  "act-git": "git", "act-sense": "project", "act-wf": "wf", "act-exp": "exp", "act-market": "market",
  "act-board": "board", "act-team": "team", "act-nodes": "nodes", "act-approvals": "approvals",
  "act-subchat": "subchat", "act-track": "track", "act-traj": "traj", "act-usage": "usage",
  // 2026-11 人机随时可用轮:左栏「网页 Webview」恢复(CV_TRAY_ACT 也加 browser → act-web)。
  // 侧栏 title/显示名直接取 CV_CARDS.browser.title 同串,快捷键只放 .sb-kbd,故不需要另立文案。
  "act-web": "browser",
  // step-1041:指挥台画布卡(聊天渲染区+调度看板;CV_TRAY_ACT 同步 super → act-super)。
  "act-super": "super",
};

/** 无 vw-head 的自定义 chrome 视图:view-* 节点 → chrome 存在性标记(实证豁免,防静默漂移)。 */
const CUSTOM_CHROME: Record<string, RegExp> = {
  chat: /id="wsTabbar"/,         // 会话列(无标题条;工作区 tab 条即头)
  git: /class="git-bar"/,          // 分支条即头
  project: /class="pp-head"/,      // 档案进度头
  sense: /class="sense-bar"/,      // 查询条即头
  browser: /class="br-bar"/,       // 地址条即头
  sys: /class="set-layout"/,       // 设置双栏(各分区自带 vw-title,非视图级)
};

const html2cards = (html: string): Card[] => {
  const seg = html.match(/const CV_CARDS = \[([\s\S]*?)\n\];/);
  expect(seg, "CV_CARDS 段必须存在且以换行 ]; 收尾").toBeTruthy();
  return [...seg![1].matchAll(/\{([^{}]+)\}/g)].map((row) => {
    const pick = (k: string) => row[1].match(new RegExp(k + ': "([^"]*)"'))?.[1] ?? "";
    return { name: pick("name"), node: pick("node"), title: pick("title"), tag: pick("tag") };
  });
};

describe("看板卡片命名一致性(单一来源 = CV_CARDS.title)", () => {
  it("每卡 title/tag 非空、title 无重名;侧栏/视图/经典 header 三面与 title 一致", async () => {
    const port = 7891;
    const srv = servePanel(port, () => { /* 纯静态:不接 WS */ });
    let html: string;
    try {
      html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    } finally {
      await srv.close();
    }
    const cards = html2cards(html);
    // n3 看板融合(2026-10-22):「分身 Agents」独立卡已删(能力并入子agent会话流),卡片数 20 → 19。
    // step-1535:轨迹拆成独立看板视图(#view-traj + CV_CARDS.traj)→ 19 → 20。
    // step-1041:指挥台画布卡(#view-super + CV_CARDS.super,聊天渲染区+调度看板四区)→ 20 → 21。
    expect(cards.length, "画布卡片数(21:18 模块 + 子agent会话流 + 轨迹 + 指挥台;step-141 增 ide,n3 删分身 Agents 卡,step-1535 增 traj,step-1041 增 super)").toBe(21);

    // ---- 底线:非空 + 无重名(name 也不许撞,防定位栏 data-name 失真) ----
    for (const c of cards) {
      expect(c.name, "name 必须非空(坐标/映射键)").not.toBe("");
      expect(c.title, c.name + " title 必须非空").not.toBe("");
      expect(c.tag, c.name + " tag 必须非空").not.toBe("");
    }
    const titles = cards.map((c) => c.title);
    expect(new Set(titles).size, "卡片 title 不得重名").toBe(titles.length);
    expect(new Set(cards.map((c) => c.name)).size).toBe(cards.length);

    // ---- ① 侧栏 sb-act:tooltip == title(与画布定位栏同串),显示名 == title ----
    for (const [actId, cardName] of Object.entries(SB_ACT_TO_CARD)) {
      const card = cards.find((c) => c.name === cardName)!;
      const btn = html.match(new RegExp('<div class="sb-act" id="' + actId + '"[^>]*>'));
      expect(btn, "侧栏按钮存在: " + actId).toBeTruthy();
      expect(btn![0], actId + " tooltip 应为卡片 title(与定位栏 tooltip 一致)")
        .toBe('<div class="sb-act" id="' + actId + '" title="' + card.title + '">');
      const label = btn![0] && html.slice(html.indexOf(btn![0]) + btn![0].length)
        .replace(/^[\s\S]*?<\/svg>/, "").match(/^\s*([^<]+?)\s*</);
      expect(label?.[1], actId + " 显示名应为卡片 title").toBe(card.title);
    }

    // ---- ② 视图头:有 vw-head 的视图 vw-title == 卡片 title;豁免视图必须有自定义 chrome ----
    for (const c of cards) {
      const anchor = html.indexOf('id="' + c.node + '"');
      expect(anchor, "视图节点存在: #" + c.node).toBeGreaterThan(0);
      const scope = html.slice(anchor, anchor + 1200);
      if (CUSTOM_CHROME[c.name]) {
        expect(scope.match(CUSTOM_CHROME[c.name]), c.name + " 豁免成立(自定义 chrome 在场)").toBeTruthy();
        continue;
      }
      const t = scope.match(/vw-title">([^<]*)</);
      expect(t?.[1], "#" + c.node + " 的 vw-title 应为卡片 title").toBe(c.title);
    }

    // ---- ③ 经典态 header VIEW_NAMES == 卡片 title(chat=主视图不亮名,豁免) ----
    const vnSeg = html.match(/const VIEW_NAMES = \{([^}]*)\};/);
    expect(vnSeg, "VIEW_NAMES 段存在").toBeTruthy();
    const viewNames: Record<string, string> = {};
    for (const m of vnSeg![1].matchAll(/(\w+): "([^"]*)"/g)) viewNames[m[1]] = m[2];
    for (const c of cards) {
      if (c.name === "chat") continue; // 主视图:header 恒空
      expect(viewNames[c.name], "VIEW_NAMES[" + c.name + "] 应为卡片 title").toBe(c.title);
    }
  }, 30_000);

  it("画布卡片命名机制仍以 spec.title 为源(资产侧不得另立文案;2026-10-21 cvRail 退役后守卡头)", () => {
    const asset = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "canvas-shell.js"), "utf8");
    // cvRail 定位栏已退役(双导航融合):tooltip 一致性守卫改钉卡头标题/副标与右键菜单——
    // 都取 spec.title/spec.tag,经典侧栏 tooltip 与之同串的一致性由上一用例守卫。
    expect(asset).not.toContain(".cv-rail-btn"); // rail 残留=退役不彻底
    // 卡头标题/副标同源(title 兜底 name;tag 兜底空)——改名只改 CV_CARDS 即可全线生效
    expect(asset).toContain("esc(sp.title || sp.name)");
    expect(asset).toContain("esc(sp.tag || \"\")");
    // 右键菜单/对外 titles() 的文案同样源自 spec(卡片身份单一来源)
    expect(asset).toContain("spec.title");
  });
});
