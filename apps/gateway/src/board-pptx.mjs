/** board→pptx 导出(2026-10-27 第三版,按 ZCode pptx skill 的设计规范重做)。
 *
 * 前两版的问题(用户逐条否掉):
 *   ① 白板卡片 1:1 铺成幻灯片,每页 1 行摘要 + 大片空白;
 *   ② 只有文字和表格,没有一张图(用户:「配图呢?流程图呢?说明图呢?」);
 *   ③ 标题下装饰线 + 卡片左侧色条 + 封面顶条 = 规范点名的 AI 稿特征;正文 10–18pt 太小;
 *      6 张半空的章节页;文段页没有视觉元素。
 * 第三版对照 ZCode/.../presentations-plugin/skills/pptx/SKILL.md:
 *   - 字号阶梯:封面 44 / 页标题 32 / 正文 20+17 / 图节点 14 / 最小 12;
 *   - 字体显式 Microsoft YaHei(不设字体时 LibreOffice 会替代,排版与真机不一致);
 *   - 删装饰线/色条/顶条,卡片只用底色(SURFACE)区分;
 *   - 删章节页:章名进页眉,章 claim 做本章首屏导语;
 *   - 每页必须有一种视觉版式:图 / 表格 / 对比栏 / 大数字 / 引言 / 步骤;
 *   - 调色板:近黑底 + 灰绿结构色 + 单一琥珀强调(每页最多一处)。
 *
 * 2026-11-15 v4:默认 editorial 浅色主题(technical/executive/warm 可选);去卡片墙/阴影;
 * 文案关键词门(office-voice:首先/其次/综上/这意味着/赋能 等报告腔直接拒导)。
 * 管线:parseDeckMd → validateDeck → planDeck → deckToPptx。
 *
 * 2026-11-15 v5(产品口径要求「叙事没有逻辑,每页不知道想表达什么;排版布局不优雅」):
 *   - 叙事层:每页必填 `> 结论:`(takeaway,8~42 字,≠标题);每章必填 claim;全场必填 spine(主线疑问句)。
 *     页面契约从「标题+图+要点」升级为五件套:标题=结论句 → 结论带=所以呢 → 图=证据 → 要点=支撑 → 来源行。
 *   - 版式层:固定四区网格(眉/标题+章主张/结论带/主体+支撑/脚注);结论带紧跟标题(结论先行,不再沉底,
 *     修「洞察视觉权重最低」);支撑区锚定脚注上方、主体区垂直居中(修「下半页空白像没做完」);
 *     stats 数字同权重(去 64pt hero 特权,修「同层级样式不一致」);flow 节点带边框、回边走底边正交折线、
 *     标签写条件语义(禁「回边/循环」同义反复);支撑行分隔线+主色小标题(修「像文档段落贴进 PPT」)。
 */
import pptxgen from "pptxgenjs";
import { analyzeVoice } from "./office-voice.mjs";

const W = 13.33;
const H = 7.5;
const M = 0.6;
const FONT = "Microsoft YaHei";

/**
 * 主题(2026-11-15 v4):默认 editorial(浅色纸感),另有 technical(深色)、executive(藏青)、warm(暖纸)。
 * 产品口径要求:办公 PPT 先像一份给人看的报告,不是技术 Demo;配色遵循 60/30/10(底/结构/强调)。
 * 强调色只用于「判断/基线/关键数字」,不做装饰。
 */
const THEMES = {
  editorial: {
    bg: "F7F4EE", surface: "FFFFFF", surface2: "EEE9DF", line: "D8D0C4",
    text: "1F2328", muted: "68706A", primary: "2F5D50", accent: "B06A3B", danger: "A33B2E",
    codeBg: "1E2328", codeText: "EDEAE2",
    matrixFill: { hh: "F3D9D2", hl: "F3E4CF", lh: "DCE8E2", ll: "ECE7DE" },
  },
  technical: {
    bg: "0E100F", surface: "191C1A", surface2: "222623", line: "333934",
    text: "EDEAE2", muted: "9AA39B", primary: "8FAE9B", accent: "E2A052", danger: "C2603C",
    codeBg: "161A17", codeText: "EDEAE2",
    matrixFill: { hh: "2E1E17", hl: "2A2318", lh: "1F2522", ll: "1A1E1B" },
  },
  executive: {
    bg: "F3F5F8", surface: "FFFFFF", surface2: "E8EDF3", line: "D5DCE5",
    text: "14202B", muted: "5F6B7A", primary: "1F3A5F", accent: "B7791F", danger: "A33B2E",
    codeBg: "17212B", codeText: "EDF2F7",
    matrixFill: { hh: "F2D9D5", hl: "F4E7D2", lh: "DCE6F0", ll: "E9EDF2" },
  },
  warm: {
    bg: "FBF3E6", surface: "FFFFFF", surface2: "F3E8D8", line: "E0D2BE",
    text: "2B2118", muted: "7B6A57", primary: "7A4E2D", accent: "A64B2A", danger: "9B3A2A",
    codeBg: "2A2119", codeText: "F7EEE2",
    matrixFill: { hh: "F0D8CE", hl: "F2E4D0", lh: "E4E8D8", ll: "EFE7DA" },
  },
};
export const THEME_NAMES = Object.keys(THEMES);
export const DEFAULT_THEME = "editorial";
let BG = THEMES[DEFAULT_THEME].bg;
let SURFACE = THEMES[DEFAULT_THEME].surface;
let SURFACE_2 = THEMES[DEFAULT_THEME].surface2;
let LINE = THEMES[DEFAULT_THEME].line;
let TEXT = THEMES[DEFAULT_THEME].text;
let MUTED = THEMES[DEFAULT_THEME].muted;
let PRIMARY = THEMES[DEFAULT_THEME].primary;
let ACCENT = THEMES[DEFAULT_THEME].accent;
let DANGER = THEMES[DEFAULT_THEME].danger;
let CODE_BG = THEMES[DEFAULT_THEME].codeBg;
let CODE_TEXT = THEMES[DEFAULT_THEME].codeText;
let MATRIX_FILL = THEMES[DEFAULT_THEME].matrixFill;
function applyTheme(name) {
  const t = THEMES[name] || THEMES[DEFAULT_THEME];
  BG = t.bg; SURFACE = t.surface; SURFACE_2 = t.surface2; LINE = t.line;
  TEXT = t.text; MUTED = t.muted; PRIMARY = t.primary; ACCENT = t.accent; DANGER = t.danger;
  CODE_BG = t.codeBg; CODE_TEXT = t.codeText; MATRIX_FILL = t.matrixFill;
}

/** 内部流程术语:出现在 deck 源稿=把规划指令当正文。 */
const INTERNAL_JARGON = /回答维度|逐章扩页|骨架版|终版|规划稿|本页要|待补充|TODO|TBD|占位/;
const JUNK_TITLE = /骨架|逐章|扩页|终版|草稿|模板|PPT ?骨架|draft|v\d+\s*$/i;

/** v6 自造词种子表(本项目黑话):正文用到就必须先有术语表定义。
 *  只收「不看上下文猜不出意思」的词;业界通用词(cache/token/API/上下文/权限…)不收。
 *  新自造词落地时往这里补——门是确定性的,词表是演进的。 */
const COINED_SEED = [
  "世界模型", "探索税", "仪式税", "上下文经济", "前缀稳定", "失败分支定向压缩", "定向压缩",
  "注入闸", "作业思路板", "指挥台", "做梦", "白板契约", "变更契约图", "回边",
];

const clamp = (s, n) => {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n) : t;
};
const stripNo = (s) => String(s ?? "").replace(/^\s*\d{1,3}(?:[.、]\d{1,3})?\s*[.、_\-·]?\s*/, "").trim();
const numOf = (s) => {
  const m = /^\s*(\d{1,3})/.exec(String(s ?? ""));
  return m ? m[1].padStart(2, "0") : "";
};

/** 内部指令前缀洗净(「回答维度②:」「【总评】」「评审结论:」)。 */
export function humanize(s) {
  return String(s ?? "")
    .replace(/^\s*回答维度[①-⑩\d]*\s*[:：]\s*/, "")
    .replace(/^\s*(?:评审结论|总评|结论)\s*[:：]{1,2}\s*/, "")
    .replace(/^\s*证据\s*[:：]\s*/, "")
    .replace(/^\s*【[^】]{1,8}】\s*/, "")
    .trim();
}

/** 板标题 → 对外文档名:去尾括号注、去「PPT 骨架/骨架/草稿」等过程词。 */
export function cleanTitle(s) {
  return humanize(s)
    .replace(/[（(][^（）()]{0,40}[)）]\s*$/g, "")
    .replace(/\bPPT\s*骨架\b/gi, "")
    .replace(/骨架版?|草稿版?|终版|逐章扩页/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*(?:PPT|文档)\s*$/i, "")
    .replace(/[\s·—–-]+$/g, "")
    .trim();
}

/** 解析 `- **小标题** — 说明` / `- **小标题**:说明` / `- 说明`。 */
export function parseBullet(line) {
  const body = line.replace(/^\s*[-*]\s+/, "").trim();
  if (!body) return null;
  const bold = /^\*\*(.+?)\*\*\s*(?:[—–:-]{1,2}|:)?\s*(.*)$/.exec(body);
  if (bold) return { lead: bold[1].trim(), text: bold[2].trim() };
  return { lead: "", text: body };
}

/**
 * 图块解析(四种示意图):
 *   ```layers   每行 `层名: 组件A | 组件B`                → 分层架构
 *   ```flow     `id: 名` + `a -> b` / `a -> b: 标签`       → 流程图
 *   ```matrix   `高影响高概率: 条目 | 条目`                 → 2×2 矩阵
 *   ```timeline `阶段: 事项 | 事项`                         → 时间线
 */
export function parseDiagram(type, lines) {
  const items = lines.map((l) => String(l).trim()).filter(Boolean);
  if (type === "layers") {
    const bands = [];
    for (const l of items) {
      const m = /^([^:：]{1,20})\s*[:：]\s*(.+)$/.exec(l);
      if (!m) continue;
      const boxes = m[2].split("|").map((x) => x.trim()).filter(Boolean);
      if (boxes.length) bands.push({ name: m[1].trim(), boxes });
    }
    return bands.length >= 2 ? { type, bands } : null;
  }
  if (type === "flow") {
    const nodes = [];
    const byId = new Map();
    const edges = [];
    for (const l of items) {
      const em = /^([\w\u4e00-\u9fa5.-]{1,24})\s*->\s*([\w\u4e00-\u9fa5.-]{1,24})\s*(?:[:：]\s*(.{0,16}))?$/.exec(l);
      if (em) {
        edges.push({ from: em[1], to: em[2], label: (em[3] || "").trim() });
        continue;
      }
      const nm = /^([\w\u4e00-\u9fa5.-]{1,24})\s*[:：]\s*(.{1,60})(?:\s*::\s*(.{1,60}))?$/.exec(l);
      if (nm && !byId.has(nm[1])) {
        const n = { id: nm[1], label: clamp(nm[2].trim(), 16), desc: (nm[3] || "").trim() };
        byId.set(n.id, n);
        nodes.push(n);
      }
    }
    for (const e of edges) {
      for (const id of [e.from, e.to]) {
        if (!byId.has(id)) {
          const n = { id, label: id };
          byId.set(id, n);
          nodes.push(n);
        }
      }
    }
    return nodes.length >= 2 && edges.length >= 1 ? { type, nodes, edges } : null;
  }
  if (type === "matrix") {
    const KEY_ORDER = ["高影响高概率", "高影响低概率", "低影响高概率", "低影响低概率"];
    const cells = [];
    let axes = { y: "影响", x: "概率" };
    for (const l of items) {
      const ax = /^axes\s*[:：]\s*(.+)$/i.exec(l);
      if (ax) {
        const parts = ax[1].split("|").map((x) => x.trim());
        axes = { y: (parts[0] || "影响").replace(/[高低].*$/, ""), x: (parts[1] || "概率").replace(/[高低].*$/, "") };
        continue;
      }
      const m = /^([^:：]{2,12})\s*[:：]\s*(.+)$/.exec(l);
      if (!m) continue;
      const key = KEY_ORDER.find((k) => {
        const [impact, prob] = k.split(/(?=高概率|低概率)/);
        return m[1].includes(impact) && m[1].includes(prob);
      });
      if (!key) continue;
      cells.push({ key, items: m[2].split("|").map((x) => x.trim()).filter(Boolean) });
    }
    return cells.length >= 2 ? { type, cells, axes, order: KEY_ORDER } : null;
  }
  if (type === "timeline") {
    const phases = [];
    for (const l of items) {
      const m = /^([^:：]{1,16})\s*[:：]\s*(.+)$/.exec(l);
      if (!m) continue;
      phases.push({ name: m[1].trim(), items: m[2].split("|").map((x) => x.trim()).filter(Boolean) });
    }
    return phases.length >= 2 ? { type, phases } : null;
  }
  return null;
}

/** 非图视觉块:对比栏 / 大数字 / 引言。 */
export function parseBlock(type, lines) {
  const items = lines.map((l) => String(l).trim()).filter(Boolean);
  if (type === "compare") {
    const cols = [];
    for (const l of items) {
      const m = /^([^:：]{1,12})\s*[:：]\s*(.+)$/.exec(l);
      if (!m) continue;
      cols.push({ name: m[1].trim(), items: m[2].split("|").map((x) => x.trim()).filter(Boolean) });
    }
    return cols.length >= 2 ? { type, cols } : null;
  }
  if (type === "stats") {
    const stats = [];
    for (const l of items) {
      const parts = l.split("|").map((x) => x.trim());
      if (parts.length >= 2 && parts[0]) stats.push({ value: parts[0], label: parts[1], source: parts[2] || "" });
    }
    return stats.length >= 2 ? { type, stats } : null;
  }
  if (type === "quote") {
    const statement = items[0] || "";
    if (!statement) return null;
    return { type, statement: humanize(stripNo(statement)), note: items[1] || "", source: items[2] || "" };
  }
  return null;
}

/**
 * markdown deck → 结构化 deck。
 *   # 标题 / subtitle: / theme: / kicker: / genre: / verdict: / verdict_note: / meta:
 *   ## 01 章 (claim:) / ### 页
 *   正文:`- **小标题** — 说明`、`| 表格 |`、```steps/layers/flow/matrix/timeline/compare/stats/quote
 *   `> 证据: 文件:行` / `> 结论: 一句话`
 */
export function parseDeckMd(md) {
  const lines = String(md ?? "").split(/\r?\n/);
  const deck = { title: "", subtitle: "", genre: "", verdict: "", verdictNote: "", meta: "", theme: "", kicker: "", spine: "", notCovering: "", dataPolicy: "", legend: "", chapters: [], todos: 0, unknownBlocks: [] };
  let chapter = null;
  let page = null;
  let fence = null;
  let table = null;
  const FENCE_KINDS = new Set(["steps", "layers", "flow", "matrix", "timeline", "compare", "stats", "quote", "code", "cards", "pseudo"]);
  const pushTable = () => {
    if (table && page && table.headers.length >= 2 && table.rows.length >= 1) {
      page.blocks.push({ kind: "table", headers: table.headers, rows: table.rows });
    }
    table = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (/<!--/.test(line)) deck.todos += 1;
    const fenceOpen = /^\s*```+\s*([a-z-]*)\s*$/i.exec(line);
    if (fenceOpen && !fence) {
      const k = fenceOpen[1].toLowerCase();
      // fail-closed(2026-11-05,演示运行环境质量门口径:未知=error,不静默降级):
      // 未登记的版式块以前走 kind="ignore" 被无声吞掉——写错块名的页会「导出成功但没有那张图」。
      // 现在登记到 deck.unknownBlocks,由 validateDeck 拒导并点名(带页与块名)。
      if (k && !FENCE_KINDS.has(k)) {
        deck.unknownBlocks.push({ page: page ? page.title : "", kind: k });
        fence = { kind: "ignore" };
      } else {
        fence = FENCE_KINDS.has(k) ? { kind: k, items: [] } : { kind: "ignore" };
      }
      pushTable();
      continue;
    }
    if (/^\s*```+\s*$/.test(line) && fence) {
      if (page && fence.kind === "steps" && fence.items.length >= 2) {
        page.blocks.push({ kind: "steps", items: fence.items });
      } else if (page && fence.kind === "code") {
        if (fence.items.length >= 3) {
          page.blocks.push({ kind: "code", data: { source: fence.items[0], lines: fence.items.slice(1) } });
        }
      } else if (page && fence.kind === "pseudo") {
        if (fence.items.length >= 2) {
          page.blocks.push({ kind: "pseudo", data: { lines: fence.items } });
        }
      } else if (page && fence.kind === "cards" && fence.items.length >= 2) {
        // v8 cards: `标题 | 说明 | 子项1;子项2;子项3` → 圆角卡网格(workbuddy 最常用版式)
        const cards = [];
        for (const raw of fence.items) {
          const parts = raw.split("|").map((x) => x.trim());
          const title = parts[0] || "";
          const desc = parts[1] || "";
          const subs = (parts[2] || "").split(";").map((x) => x.trim()).filter(Boolean);
          if (title) cards.push({ title, desc, subs });
        }
        if (cards.length >= 2) page.blocks.push({ kind: "cards", data: { cards } });
      } else if (page && fence.kind !== "steps" && fence.kind !== "ignore") {
        const d = ["layers", "flow", "matrix", "timeline"].includes(fence.kind)
          ? parseDiagram(fence.kind, fence.items)
          : parseBlock(fence.kind, fence.items);
        if (d) page.blocks.push({ kind: d.type, data: d });
      }
      fence = null;
      continue;
    }
    if (fence) {
      const t = line.trim();
      if (!t) continue;
      if (fence.kind === "steps") {
        const [label, ...rest] = t.replace(/^\d+[.、)]\s*/, "").split("|");
        const detail = rest.join("|").trim();
        if (label.trim()) fence.items.push({ label: clamp(label, 40), detail: clamp(detail, 140) });
      } else if (fence.kind === "code") {
        // code 摘录保留行首缩进(else/except 层级是它要传达的信息);只去行尾空白与 tab
        fence.items.push(line.replace(/\t/g, "    ").replace(/\s+$/, ""));
      } else if (fence.kind !== "ignore") {
        fence.items.push(t);
      }
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      if (/^[\s|:-]+$/.test(line)) continue;
      if (!table) table = { headers: cells, rows: [] };
      else if (cells.some((c) => c !== "")) table.rows.push(cells);
      continue;
    }
    pushTable();
    if (!line.trim()) continue;
    if (/^#\s+/.test(line)) {
      deck.title = line.replace(/^#\s+/, "").trim();
      continue;
    }
    if (/^##\s+/.test(line)) {
      chapter = { no: "", title: "", claim: "", pages: [] };
      const t = line.replace(/^##\s+/, "").trim();
      chapter.no = numOf(t);
      chapter.title = stripNo(t);
      deck.chapters.push(chapter);
      page = null;
      continue;
    }
    if (/^###\s+/.test(line)) {
      if (!chapter) continue;
      page = { title: stripNo(line.replace(/^###\s+/, "").trim()), blocks: [], evidence: "", takeaway: "", definitions: [], status: "", pageLayout: "", carry: "" };
      chapter.pages.push(page);
      continue;
    }
    const meta = /^(subtitle|verdict_note|verdict|meta|claim|genre|theme|kicker|spine|notcovering|datapolicy|legend)\s*[:：]\s*(.*)$/i.exec(line);
    if (meta) {
      const key = meta[1].toLowerCase();
      const val = meta[2].trim();
      if (key === "claim") {
        if (chapter) chapter.claim = val;
      } else if (key === "subtitle") deck.subtitle = val;
      else if (key === "spine") deck.spine = val;
      else if (key === "genre") deck.genre = val;
      else if (key === "verdict") deck.verdict = val;
      else if (key === "verdict_note") deck.verdictNote = val;
      else if (key === "meta") deck.meta = val;
      else if (key === "theme") deck.theme = val;
      else if (key === "kicker") deck.kicker = val;
      else if (key === "notcovering") deck.notCovering = val;
      else if (key === "datapolicy") deck.dataPolicy = val;
      else if (key === "legend") deck.legend = val;
      continue;
    }
    if (/^>\s*/.test(line)) {
      if (!page) continue;
      const t = line.replace(/^>\s*/, "").trim();
      if (/^证据\s*[:：]/.test(t)) page.evidence = t.replace(/^证据\s*[:：]\s*/, "");
      else if (/^结论\s*[:：]/.test(t)) page.takeaway = t.replace(/^结论\s*[:：]\s*/, "");
      // v7 就地定义:`> 定义: 术语=一句话` —— 解释跟内容放在一起,术语表只是附录
      else if (/^定义\s*[:：]/.test(t)) {
        const body = t.replace(/^定义\s*[:：]\s*/, "");
        const eq = body.indexOf("=");
        if (eq > 0 && page.definitions.length < 2) page.definitions.push({ term: body.slice(0, eq).trim(), def: body.slice(eq + 1).trim() });
      }
      // v9 状态徽标:`> 状态: 已落地` —— 机制页标落地程度,渲染成右上角彩色徽标
      else if (/^状态\s*[:：]/.test(t)) {
        page.status = t.replace(/^状态\s*[:：]\s*/, "").trim();
      }
      // v12 版式引擎:`> 版式: 通栏|左图右文|右图左文|大字结论` —— 页面结构由源稿声明,渲染器按版式重排主体区
      else if (/^版式\s*[:：]/.test(t)) {
        page.pageLayout = t.replace(/^版式\s*[:：]\s*/, "").trim();
      }
      // v15 叙事粘合:`> 承上: 一句话` —— 接住上一页/上一章的哪条线(wb 每页「接前段」的对位),渲染成标题下灰字
      else if (/^承上\s*[:：]/.test(t)) {
        page.carry = t.replace(/^承上\s*[:：]\s*/, "").trim();
      }
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) && page) {
      const b = parseBullet(line);
      if (!b) continue;
      const last = page.blocks[page.blocks.length - 1];
      if (last && last.kind === "bullets") last.items.push(b);
      else page.blocks.push({ kind: "bullets", items: [b] });
      continue;
    }
  }
  pushTable();
  deck.chapters.forEach((c, i) => {
    if (!c.no) c.no = String(i + 1).padStart(2, "0");
    c.pages.forEach((p) => (p.title = stripNo(p.title)));
  });
  return deck;
}

/** 质量门:薄内容/纯文字页/内部术语/模板残留一律拒导。 */
export function validateDeck(deck) {
  const issues = [];
  const add = (where, msg) => issues.push({ where, msg });
  if (!deck || typeof deck !== "object") return [{ where: "deck", msg: "源稿为空或解析失败" }];
  if (!deck.title || deck.title.length < 4) add("标题", "缺少 `# 文档标题`");
  else if (JUNK_TITLE.test(deck.title)) add("标题", `「${deck.title}」还是白板/草稿标题,请写成对外文档名(去掉骨架/草稿/版本字样)`);
  if (deck.todos > 0) add("全文", `还有 ${deck.todos} 处 <!-- --> 模板注释未填`);
  if (deck.theme && !THEME_NAMES.includes(deck.theme)) add("主题", `未知 theme「${deck.theme}」:可用 ${THEME_NAMES.join(" / ")}`);
  // fail-closed:未登记的版式块 = 这张图不会被画出来,以前静默丢弃(见 parseDeckMd)。
  const unknownKinds = deck.unknownBlocks || [];
  if (unknownKinds.length) {
    const names = [...new Set(unknownKinds.map((b) => b.kind))].join("/");
    add("版式", `${unknownKinds.length} 个未登记版式块(${names}):导出器不认识它,内容不会被画出来——改用 §四 版式目录里的名字`);
  }
  if (deck.chapters.length < 2) add("全文", "至少 2 章才成文档");
  // 叙事层(2026-11-15 v5,产品口径要求「叙事没有逻辑,每页不知道想表达什么」):
  // 先定主线(全场回答哪个疑问句),每章 claim=本章结论方向,每页 `> 结论:`=标题没说的那半句。
  if (!deck.spine) add("全文", "缺 `spine:`——写页之前先定全场主线(一句疑问句:这场汇报回答什么)");
  else if ([...deck.spine].length < 8 || [...deck.spine].length > 80) add("全文", `spine ${[...deck.spine].length} 字(8~80):一句疑问句,不是章节目录`);
  for (const ch of deck.chapters) {
    if (!ch.title) add(`第 ${ch.no} 章`, "章标题为空");
    if (!ch.claim) add(`第 ${ch.no} 章`, "章缺 `claim:`——本章回答哪个子问题、结论朝哪个方向,一句话");
    else if ([...ch.claim].length < 8 || [...ch.claim].length > 80) add(`第 ${ch.no} 章`, `claim ${[...ch.claim].length} 字(8~80)`);
    if (!ch.pages.length) add(`${ch.no} ${ch.title}`, "本章没有页(`### 页标题`)");
    ch.pages.forEach((pg, idx) => {
      const at = `${ch.no}.${idx + 1} ${pg.title || "(空页标题)"}`;
      if (!pg.title) add(at, "页标题为空");
      else if (pg.title.length > 40) add(at, `页标题 ${pg.title.length} 字,超过 40`);
      // takeaway(所以呢):受众先读标题(判断)再读结论带(含义),图只是证据。
      const tk = String(pg.takeaway || "").trim();
      if (!tk) add(at, "缺 `> 结论:` 行——这页要回答「所以呢」:标题给了判断,结论带给含义/影响");
      else if (tk === pg.title) add(at, "结论与标题逐字相同:标题说「是什么」,结论带要说「所以怎样」");
      else if ([...tk].length < 8) add(at, `结论只有 ${[...tk].length} 字:要一句完整判断,不是两个词`);
      else if ([...tk].length > 42) add(at, `结论 ${[...tk].length} 字超 42(结论带单行上限)`);

      const bullets = pg.blocks.filter((b) => b.kind === "bullets").flatMap((b) => b.items);
      const tables = pg.blocks.filter((b) => b.kind === "table");
      const steps = pg.blocks.filter((b) => b.kind === "steps");
      const visuals = pg.blocks.filter((b) => ["layers", "flow", "matrix", "timeline"].includes(b.kind));
      const compares = pg.blocks.filter((b) => b.kind === "compare");
      const stats = pg.blocks.filter((b) => b.kind === "stats");
      const quotes = pg.blocks.filter((b) => b.kind === "quote");

      const codeBlocks = pg.blocks.filter((b) => b.kind === "code");
      const cardsBlocks = pg.blocks.filter((b) => b.kind === "cards");
      const pseudoBlocks = pg.blocks.filter((b) => b.kind === "pseudo");
      // ZCode 规范:不许纯文字页——每页至少一种视觉版式
      const mains = visuals.length + tables.length + steps.length + compares.length + stats.length + quotes.length + codeBlocks.length + cardsBlocks.length + pseudoBlocks.length;
      if (mains === 0) add(at, "纯文字页:每页至少配图/代码/伪代码/表格/卡片/对比栏/大数字/引言之一");
      if (visuals.length > 1) add(at, "一页最多 1 张图");
      // v8 放宽:允许「cards + visual/pseudo」或「visual + cards」组合(workbuddy 常见:
      // 因果链 flow + 条件映射 cards;伪代码 + 设计 cards)——只禁「两个同类主版式」。
      const visualN = visuals.length + tables.length + steps.length + compares.length + stats.length + quotes.length + codeBlocks.length;
      const canCombo = (cardsBlocks.length || pseudoBlocks.length) && visualN <= 1;
      if (mains > 1 && !canCombo) add(at, "同页混排多种主版式:一页只留一种(或 cards/pseudo + 一个主版式的组合)");
      // cards 校验:2~4 张、标题 ≤20、说明 ≤60、子项各 ≤30、子项 ≤4
      for (const cb of cardsBlocks) {
        const cs = cb.data.cards || [];
        if (cs.length < 2) add(at, "卡片至少 2 张");
        if (cs.length > 4) add(at, `卡片 ${cs.length} 张超 4(多则拆页)`);
        for (const c of cs) {
          if ([...(c.title || "")].length > 20) add(at, `卡片标题「${clamp(c.title, 10)}」超 20 字`);
          if (c.desc && [...c.desc].length > 60) add(at, `卡片「${clamp(c.title, 8)}」说明超 60 字`);
          if ((c.subs || []).length > 4) add(at, `卡片「${clamp(c.title, 8)}」子项超 4 条`);
          if ((c.subs || []).some((t) => [...t].length > 30)) add(at, `卡片「${clamp(c.title, 8)}」子项超 30 字`);
        }
      }
      // pseudo 校验:2~10 行,每行 ≤92 字符(同 code)
      for (const pb of pseudoBlocks) {
        const ls = pb.data.lines || [];
        if (ls.length < 2) add(at, "伪代码至少 2 行");
        if (ls.length > 10) add(at, `伪代码 ${ls.length} 行超 10(挑核心分支)`);
        if (ls.some((l) => l.length > 92)) add(at, "伪代码有行超 92 字符");
      }
      // 每页深度(2026-10-27「每一页的内容质量很差」;2026-11-15 v6 产品口径要求「就写一点点/片面式写作」):
      // 解读 2–4 条,总字数 ≥75——关键词是行文风格,不是信息裁剪;每页承载一条完整论证,不藏信息。
      // 术语表章里的页跳过字数下限:词条本身就是内容,硬凑解读反而稀释。
      const inGlossaryCh = /术语|概念/.test(ch.title);
      const minB = quotes.length ? 2 : 2;
      if (bullets.length < minB) add(at, `解读只有 ${bullets.length} 条:每页要 2–4 条「定义/机制/实证/影响」解读,不能只放图`);
      if (bullets.length > 4) add(at, `解读 ${bullets.length} 条过多(≤4)`);
      const fixedZone = stats.length || compares.length;
      if (fixedZone && bullets.length > 2) add(at, "大数字/对比栏版面固定,解读限 2 条(第 3 条拆到下一页)");
      const totalChars = bullets.reduce((n, b) => n + b.lead.length + b.text.length, 0);
      // v13(2026-11-18 轨迹分析:11/42 页要点 <100 字=骨架级不是论证级):密度下限 75→100
      if (!inGlossaryCh && bullets.length >= minB && totalChars < 100) add(at, `解读总字数 ${totalChars}<100:只写了骨架没写论证——补齐定义/机制/数据/影响,不藏信息`);
      for (const b of bullets) {
        if (!b.text && !b.lead) add(at, "空要点");
        else if (b.lead.length > 24) add(at, `小标题「${b.lead.slice(0, 12)}…」超 24 字`);
        else if (!b.lead && b.text.length < 6) add(at, `要点「${b.text}」过短`);
        else if (b.lead && b.text.length < 4) add(at, `要点「${b.lead}」缺说明`);
        else if (b.text.length > 110) add(at, `解读 ${b.text.length} 字超 110(两行上限;再长拆两条)`);
        if (INTERNAL_JARGON.test(b.lead + b.text)) add(at, `要点含内部术语/占位词:「${clamp(b.lead || b.text, 16)}」`);
      }
      // 文案口径(2026-11-15 产品口径要求):要关键词,不要 agent 报告腔;强命中直接拒导。
      // 结论带与标题同过一套规则(它也是模型可见文案)。
      const voice = analyzeVoice({ title: pg.title, bullets: tk ? [...bullets, { lead: "结论", text: tk }] : bullets });
      for (const v of voice.issues) add(at, `${v.code}: ${v.msg}`);
      for (const c of codeBlocks) {
        const d = c.data || {};
        if (!d.source || !/[.\/]/.test(d.source)) add(at, "代码摘录首行必须是来源(file 或 file:line)");
        if ((d.lines || []).length < 2) add(at, "代码摘录至少 2 行");
        if ((d.lines || []).length > 8) add(at, `代码摘录 ${d.lines.length} 行超 8 行(挑最能说明问题的几行)`);
        if ((d.lines || []).some((l) => l.length > 92)) add(at, "代码摘录有行超 92 字符(换行或删空格)");
      }
      for (const t of tables) {
        if (t.headers.length < 2) add(at, "表格至少 2 列");
        if (t.rows.length < 2) add(at, "表格至少 2 行数据");
        if (t.rows.length > 5) add(at, `表格 ${t.rows.length} 行,超一页容量(≤5;表格下方还要放解读)`);
        if (t.rows.some((r) => r.length !== t.headers.length)) add(at, "表格有行的列数与表头不一致");
      }
      const dg = visuals.length ? visuals[0] : null;
      if (dg) {
        const d = dg.data || {};
        if (dg.kind === "flow") {
          const ids = new Set((d.nodes || []).map((n) => n.id));
          if ((d.nodes || []).length < 3) add(at, "流程图至少 3 个节点");
          if ((d.edges || []).some((e) => !ids.has(e.from) || !ids.has(e.to))) add(at, "流程图有边指向未定义节点");
          if ((d.nodes || []).some((n) => n.label.length > 16)) add(at, "流程图节点名超 16 字(盒子放不下)");
          // v5 回边叙事门:回边必须有「条件语义」标签——「回边/循环」是给线命名,不是解释为什么回头。
          const idxOf = new Map((d.nodes || []).map((n, i) => [n.id, i]));
          for (const e of d.edges || []) {
            if ((idxOf.get(e.to) ?? 0) <= (idxOf.get(e.from) ?? 0)) {
              const lab = String(e.label || "").trim();
              if (!lab) add(at, `回边 ${e.from}→${e.to} 缺标签:写「什么条件下回头」(如 还需工具),没标签就是一条看不懂的线`);
              else if (/^(回边|循环|回流|下轮|返回|重复)$/.test(lab)) add(at, `回边标签「${lab}」是同义反复:写条件语义,如「还需工具」「未过闸」`);
            }
          }
        }
        if (dg.kind === "layers") {
          if ((d.bands || []).length < 2) add(at, "分层图至少 2 层");
          if ((d.bands || []).some((b) => b.boxes.length > 4)) add(at, "分层图每层最多 4 个组件");
        }
        if (dg.kind === "matrix" && (d.cells || []).length < 3) add(at, "风险矩阵至少填 3 个象限");
        if (dg.kind === "matrix" && (d.cells || []).some((c) => c.items.length > 3)) add(at, "矩阵每个象限最多 3 条(放不下会压到相邻象限)");
        if (dg.kind === "timeline" && (d.phases || []).length < 2) add(at, "时间线至少 2 个阶段");
      }
      for (const c of compares) {
        if (c.data.cols.length > 3) add(at, "对比栏最多 3 栏");
        if (c.data.cols.some((x) => x.items.length > 4)) add(at, "对比栏每栏最多 4 条");
        if (c.data.cols.some((x) => x.items.some((t) => t.length > 30))) add(at, "对比栏单条超 30 字(一栏放不下)");
      }
      for (const s of stats) {
        if (s.data.stats.length > 4) add(at, "大数字最多 4 个");
        if (s.data.stats.some((x) => x.value.length > 8)) add(at, "大数字数值超 8 字");
        // v5.1 视觉严评实测确认:四列时每列仅 ~2.8in,说明 >16 字折三行压到来源行——两行是硬上限
        if (s.data.stats.some((x) => [...x.label].length > 16)) add(at, `大数字说明超 16 字(两行上限,再长进来源或拆页)`);
        if (s.data.stats.some((x) => [...(x.source || "")].length > 20)) add(at, `大数字来源超 20 字(缩写:如「常量 xxx.ts:97」)`);
      }
      if (quotes.length && quotes[0].data.statement.length > 36) add(at, "引言结论超 36 字(要一句话)");
      // composition(办公/产出)档:证据行不强制(模板给可选「> 素材:」行,解析层本就不计入 evidence);
      // 其余门(纯文字页/TODO 残留/每页 2–3 条解读/内部术语/总字数)照常——宽松≠放水。
      if (!pg.evidence && String(deck.genre || "") !== "composition") add(at, "缺 `> 证据:` 行");
    });
  }
  // ── v7 就地拆解契约(2026-11-16 产品口径要求「解释要和要讲的内容放在一起,开局术语表=agent 的 md 文档地图风格;
  //    概念点名不拆解,如 slide9 的 10 个 phase 是啥」)──
  // 三条规则:①自造词首次出现的**那一页**必须 `> 定义: 术语=一句话`(渲染成标题下定义带)——解释跟内容走;
  // ②术语表只允许做**收尾附录**,开局放术语表=地图风格,拒;③点名即枚举:标题/结论承诺「N 个 X」,
  //    当页主体必须把 N 项逐项摆出来(表格/步骤/流程/分层),摆不下拆页——抽象概括节点不算拆解。
  const flatPages = [];
  deck.chapters.forEach((c, ci) => c.pages.forEach((pg, pi) => flatPages.push({ ci, pi, at: `${c.no}.${pi + 1} ${pg.title || "(空)"}`, page: pg, ch: c })));
  const pageText = (pg) => [pg.title, pg.takeaway, pg.evidence, ...(pg.definitions || []).flatMap((d) => [d.term, d.def]), ...pg.blocks.flatMap((b) => {
    if (b.kind === "bullets") return b.items.map((x) => `${x.lead}${x.text}`);
    if (b.kind === "table") return [b.headers.join(" "), ...b.rows.flat()];
    return [JSON.stringify(b.data)];
  })].join(" ");
  // ① 首用即定义(附录术语表页不参与首用判定——词条正文没用就不强制)
  const GLOSS_RE_FIRST = /术语|概念|词汇/;
  for (const t of COINED_SEED) {
    const first = flatPages.find((fp) => !GLOSS_RE_FIRST.test(fp.ch.title) && pageText(fp.page).includes(t));
    if (!first) continue;
    const hasDef = (first.page.definitions || []).some((d) => d.term.includes(t) || t.includes(d.term));
    if (!hasDef) add(first.at, `自造词「${t}」首次出现在这页,当页要给 \`> 定义: ${t}=一句话\`——解释和内容放在一起,不丢给附录`);
  }
  // ② 术语表只能做收尾附录
  const GLOSSARY_RE = /术语|概念|词汇/;
  const glossaryIdx = deck.chapters.map((c, i) => (GLOSSARY_RE.test(c.title) ? i : -1)).filter((i) => i >= 0);
  if (glossaryIdx.length) {
    const front = glossaryIdx.find((i) => i < Math.ceil(deck.chapters.length / 2));
    if (front !== undefined) add(`第 ${deck.chapters[front].no} 章`, "术语表是附录不是开场:开局放术语表是 md 文档地图风格——自造词在**首用页**用 \`> 定义:\` 就地讲,术语表挪到最后当速查");
    const entries = [];
    for (const gi of glossaryIdx) for (const pg of deck.chapters[gi].pages) for (const b of pg.blocks) {
      if (b.kind !== "table") continue;
      for (const r of b.rows) if (r.length >= 2 && String(r[0] || "").trim() && String(r[1] || "").trim()) entries.push({ term: String(r[0]).trim(), def: String(r[1]).trim() });
    }
    for (const e of entries) {
      if ([...e.term].length > 12) add("术语表", `词条「${clamp(e.term, 8)}」超 12 字(术语要短,解释放定义列)`);
      if ([...e.def].length < 10 || [...e.def].length > 60) add("术语表", `「${clamp(e.term, 8)}」定义 ${[...e.def].length} 字(10~60)`);
    }
  }
  // ③ 点名即枚举:标题/结论带里的「N 个/条/层/件/步/把/笔/本/面/类 X」必须当页逐项摆出
  // ── v10 叙事弧门(2026-11-17 产品口径要求「先讲通用,再讲 zcode 的做法,再详细拆解重要的地方;
  //    重要拆解要配具体做法示意 flow 图」)──
  // ① 概念首章:≥20 页成稿第一章必须是通用/概念/骨架章(先给地图,再进实现);
  // ② 承上启下:通用章与具体实现之间要有一页「从…到…」过渡,把骨架底线带进实现;
  // ③ 深拆章过程化:章标题/claim 含 拆/走读/深 的章,≥半页要有过程示意(flow/steps/pseudo/timeline)
  //    ——深拆要画「怎么走」,不能只给 layers/cards 结构和清单。
  const PROCESS_KINDS = new Set(["flow", "steps", "pseudo", "timeline"]);
  const v10Pages = deck.chapters.reduce((n, c) => n + c.pages.length, 0);
  if (v10Pages >= 20) {
    const ch1 = deck.chapters[0];
    const CONCEPT_RE = /(概念|通用|骨架|是什么|定义|基础|背景|现状|管什么|概述|全景)/;
    if (ch1 && !CONCEPT_RE.test(`${ch1.title} ${ch1.claim || ""}`)) {
      add(`第 ${ch1.no} 章`, "叙事弧缺概念首章:≥20 页成稿第一章要是通用/概念/骨架(先给地图,再进一家实现),现在是「" + ch1.title.slice(0, 16) + "」");
    }
    const BRIDGE_RE = /(承上|过渡|从.{1,24}到|带.{0,20}走|走一遍)/;
    if (!flatPages.some((fp) => BRIDGE_RE.test(fp.page.title || ""))) {
      add("全文", "缺承上启下过渡页:通用章之后、具体实现之前加一页「从…到…」,把骨架底线带进实现(workbuddy 的 P7 就是这个作用)");
    }
    const DEEP_RE = /(拆|走读|深|细节|深入)/;
    for (const c of deck.chapters) {
      if (!DEEP_RE.test(`${c.title} ${c.claim || ""}`)) continue;
      const proc = c.pages.filter((pg) => pg.blocks.some((b) => PROCESS_KINDS.has(b.kind))).length;
      if (proc * 2 < c.pages.length) {
        add(`第 ${c.no} 章 ${c.title}`, `深拆章过程化不足:${proc}/${c.pages.length} 页有过程示意(flow/steps/pseudo/timeline),要求 ≥半数——深拆要画「怎么走」,layers/cards 只能当辅助`);
      }
    }
  }
  // ── v9 构建思路与内容质量门(2026-11-17 产品口径要求「构建思路?内容质量?UI 设计?要成通用机制」)──
  // ① 构建思路:成稿必须声明「不讲什么」(scope 纪律)与「数字三档」(dataPolicy);
  // ② 内容质量:同一要点不得在 ≥2 页重复(递进不是复读);
  // ③ UI 设计:同章 ≥3 页连续同一版式(flow/layers/stats/cards)=节奏塌,拒;状态徽标取值必须合法。
  const v9ContentPages = deck.chapters.reduce((n, c) => n + c.pages.length, 0);
  if (v9ContentPages >= 8 && !deck.notCovering) {
    add("全文", "缺 `notCovering:`——成稿要说清「这次不讲什么」(scope 纪律:不讲的部分也是信息,防读者预期落空)");
  } else if (deck.notCovering && ([...deck.notCovering].length < 4 || [...deck.notCovering].length > 80)) {
    add("全文", `notCovering ${[...deck.notCovering].length} 字(4~80):列 2~3 个「这次不讲」的主题`);
  }
  const statsPageN = deck.chapters.reduce((n, c) => n + c.pages.filter((p) => p.blocks.some((b) => b.kind === "stats")).length, 0);
  if (statsPageN >= 2 && !deck.dataPolicy) {
    add("全文", "缺 `dataPolicy:`——数字三档纪律:实测(带日期口径) / 代码常量 / 设计目标,三类不能混着讲");
  } else if (deck.dataPolicy && ([...deck.dataPolicy].length < 6 || [...deck.dataPolicy].length > 80)) {
    add("全文", `dataPolicy ${[...deck.dataPolicy].length} 字(6~80):写清三档口径,一句即可`);
  }
  // 去重:同一条要点(lead+text 归一化)出现在 ≥2 页 = 复读,拒
  const bulletSeen = new Map();
  for (const fp of flatPages) {
    if (GLOSSARY_RE.test(fp.ch.title)) continue;
    for (const b of fp.page.blocks.filter((x) => x.kind === "bullets").flatMap((x) => x.items)) {
      const key = `${String(b.lead || "").replace(/\s+/g, "")}|${String(b.text || "").replace(/\s+/g, "")}`;
      if (!key.trim() || key.length < 8) continue;
      if (bulletSeen.has(key)) add(fp.at, `要点与 ${bulletSeen.get(key)} 逐字重复——递进不是复读:同一结论只讲一次,换页要换证据/换角度`);
      else bulletSeen.set(key, fp.at);
    }
  }
  // 节奏:同章内 ≥3 页连续同一版式(flow/layers/stats/cards)=视觉节奏塌
  const layoutOfPage = (pg) => {
    const has = (k) => pg.blocks.some((b) => b.kind === k);
    if (has("code")) return "code";
    if (has("cards")) return "cards";
    if (has("pseudo")) return "pseudo";
    if (has("flow")) return "flow";
    if (has("layers")) return "layers";
    if (has("matrix")) return "matrix";
    if (has("timeline")) return "timeline";
    if (has("compare")) return "compare";
    if (has("stats")) return "stats";
    if (has("quote")) return "quote";
    if (has("table")) return "table";
    if (has("steps")) return "steps";
    return "list";
  };
  const RHYTHM_GUARDED = new Set(["flow", "layers", "stats", "cards"]);
  for (const c of deck.chapters) {
    if (GLOSSARY_RE.test(c.title)) continue;
    let run = 0, prev = "";
    for (const pg of c.pages) {
      const l = layoutOfPage(pg);
      if (l === prev) run += 1; else { run = 1; prev = l; }
      if (run >= 3 && RHYTHM_GUARDED.has(l)) {
        add(`${c.no} ${pg.title}`, `连续 ${run} 页同一版式(${l}):视觉节奏塌了——中间插一页不同版式(表格/cards/对比)或合并`);
        break;
      }
    }
  }
  // 状态徽标取值
  for (const fp of flatPages) {
    const st = String(fp.page.status || "").trim();
    if (st && !/^(已落地|部分落地|设计目标|未测)$/.test(st)) add(fp.at, `状态「${st}」不合法:只能是 已落地 / 部分落地 / 设计目标 / 未测`);
  }
  const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const ENUM_RE = /(?<![\d.])(\d+|[一两二三四五六七八九十])(?!\d)(?:\s*)(个|条|层|件|步|把|笔|本|面|类)/g;
  const enumUnitsOf = (pg) => {
    const pick = (k) => pg.blocks.filter((b) => b.kind === k);
    const units = [];
    for (const t of pick("table")) units.push(t.rows.length);
    for (const s of pick("steps")) units.push(s.items.length);
    for (const v of pick("flow")) units.push((v.data.nodes || []).length);
    for (const l of pick("layers")) units.push((l.data.bands || []).reduce((n, b) => n + (b.boxes || []).length, 0), (l.data.bands || []).length);
    for (const tl of pick("timeline")) units.push((tl.data.phases || []).length);
    for (const mx of pick("matrix")) units.push((mx.data.cells || []).length);
    for (const st of pick("stats")) units.push(st.data.stats.length);
    for (const cp of pick("compare")) units.push(cp.data.cols.length, cp.data.cols.reduce((n, c) => n + c.items.length, 0));
    for (const cb of pick("cards")) units.push((cb.data.cards || []).length); // v8: cards 也是逐项枚举
    return Math.max(0, ...units, 0);
  };
  for (const fp of flatPages) {
    const claimText = `${fp.page.title || ""} ${fp.page.takeaway || ""}`;
    let m;
    ENUM_RE.lastIndex = 0;
    while ((m = ENUM_RE.exec(claimText))) {
      const n = /\d/.test(m[1]) ? Number(m[1]) : (CN_NUM[m[1]] || 0);
      if (n < 2) continue;
      const units = enumUnitsOf(fp.page);
      if (units < n) add(fp.at, `标题/结论承诺「${m[1]}${m[2]}」但主体只摆了 ${units} 项——点名即枚举:N 项逐项摆出来(表格每页 ≤5 行,多则拆页/换 steps),抽象概括节点不算拆解`);
    }
  }
  // ── v11 人类阅读门(2026-11-18 产品口径要求「workbuddy 的产出更符合人类阅读习惯,genie 的是
  //    agent coding 思维、平铺证据式表达;看不出 zcode 的循环是什么、有哪些步骤、每步干什么」)──
  // 对标 workbuddy 范式:过程主题先「一页走完」(全部步骤同一页,每步 名字+一句人话职责),
  // 代码引用只进页脚证据行——「置 running 并盖 startedAt」是 agent 之间的对话,不是给读者的说明。
  // ① 全流程总览:spine/章标题/章 claim/页标题/结论点名「N 相位/阶段/步/动作」→
  //    必须有一页把 N 项全部放进**同一个** steps/flow(总览页);「前五相/后五相」式拆页只能当补充。
  // ② 步骤人话:steps 说明 / flow 节点描述 / cards 说明写「这一步干什么(行为+目的)」——
  //    禁代码引用(文件/行号/函数调用)、禁复述赋值、字段/函数名 ≤1。
  // ③ 证据留页脚:表格不放「代码位置」列、单元格不写行号;要点报代码位置密度 ≤1/3,超过=平铺证据。
  // ④ 回边承诺:标题/结论说了「回边/循环回去」,主版式必须是 flow(steps 画不出边,承诺兑现不了)。
  const cnNumOf = (s0) => {
    if (/^\d+$/.test(s0)) return Number(s0);
    const D = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (s0.includes("十")) {
      const [a, b] = s0.split("十");
      return (D[a] || (a === "" ? 1 : 0)) * 10 + (D[b] || 0);
    }
    return D[s0] || 0;
  };
  const stripOrd = (t) => String(t || "")
    .replace(/第\s*[0-9一两二三四五六七八九十]{1,3}\s*(?:步|阶段|相位|相|节|章|次|圈)/g, " ")
    .replace(/P\d+/gi, " ");
  const PROC_PROMISE_RE = /(\d{1,2}|[一两二三四五六七八九十]{1,3})\s*(?:个|道|大)?\s*(相位|个相|阶段|步骤|动作|步|相|phase)/gi;
  const seqOf = (pg) => {
    const ns = [];
    for (const b of pg.blocks) {
      if (b.kind === "steps") ns.push(b.items.length);
      if (b.kind === "flow") ns.push((b.data.nodes || []).length);
    }
    return Math.max(0, ...ns, 0);
  };
  const seqMax = Math.max(0, ...flatPages.map((fp) => seqOf(fp.page)), 0);
  const promised = new Map();
  const promiseTexts = [
    [deck.spine, "全文主线"],
    ...flatPages.flatMap((fp) => [
      [`${fp.ch.title} ${fp.ch.claim || ""}`, `第 ${fp.ch.no} 章`],
      [`${fp.page.title || ""} ${fp.page.takeaway || ""}`, fp.at],
    ]),
  ];
  for (const [text, where] of promiseTexts) {
    let m2;
    PROC_PROMISE_RE.lastIndex = 0;
    while ((m2 = PROC_PROMISE_RE.exec(stripOrd(text)))) {
      const n = cnNumOf(m2[1]);
      if (n < 3 || n > 14) continue;
      if (!promised.has(n)) promised.set(n, where);
    }
  }
  for (const [n, where] of promised) {
    if (seqMax < n) {
      add(where, `点名了 ${n} 项过程(相位/阶段/步),但全稿没有一页把它走完(最大的过程页只有 ${seqMax} 项)——加一页全流程总览:全部 ${n} 项放进同一个 steps/flow,每项 名字+一句人话职责,循环回边写条件;「前半/后半」式拆页只能做补充`);
    }
  }
  // ② 步骤人话(steps 说明 / flow 节点描述 / cards 说明)
  const CODE_CITE_RE = /[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|h)(?:\s*[:：]\s*\d+)?|\w+\(\)|:\d{1,5}(?!\d)/;
  const ASSIGN_RE = /(置|盖|赋|标|记|写)(?:为|上|到|进|入)?\s*[a-zA-Z][\w.]{3,}/;
  const ID_TOKEN_RE = /\b[a-z]+[A-Z][a-zA-Z]+\b|\b[a-z]+(?:_[a-z0-9]+)+\b/g;
  const humanVoiceCheck = (at, kind, name, desc) => {
    const d = String(desc || "").trim();
    if (!d) return;
    if (CODE_CITE_RE.test(d)) add(at, `${kind}「${clamp(name, 12)}」的说明含代码引用(文件/行号/函数调用)——代码位置收进 \`> 证据:\` 行,说明写这一步干什么`);
    else if (ASSIGN_RE.test(d)) add(at, `${kind}「${clamp(name, 12)}」的说明在复述代码赋值(「${clamp(d, 14)}」)——读者要行为与目的,不是字段操作`);
    else {
      const ids = new Set(d.match(ID_TOKEN_RE) || []);
      if (ids.size >= 2) add(at, `${kind}「${clamp(name, 12)}」的说明是实现腔(出现 ${[...ids].slice(0, 3).join("/")} 等字段/函数名)——用行为动词讲这一步做什么,代码名词最多留一个`);
    }
  };
  for (const fp of flatPages) {
    for (const b of fp.page.blocks) {
      if (b.kind === "steps") {
        if (b.items.length > 14) add(fp.at, `steps ${b.items.length} 行超一页(两行回绕上限 14)——更大的过程改 flow 总览 + 分段深拆`);
        for (const it of b.items) {
          if ([...(it.label || "")].length > 16) add(fp.at, `步骤名「${clamp(it.label, 10)}」超 16 字`);
          if ([...(it.detail || "")].length > 46) add(fp.at, `步骤「${clamp(it.label, 10)}」说明超 46 字:一句人话职责(这步干什么/为什么),长解释挪到要点`);
          humanVoiceCheck(fp.at, "步骤", it.label, it.detail);
        }
      }
      if (b.kind === "flow") for (const nd of b.data.nodes || []) {
        if ([...(nd.desc || "")].length > 32) add(fp.at, `节点「${clamp(nd.label, 10)}」描述超 32 字(渲染两行上限,超了会被截断)——留一句为什么,细节进要点`);
        humanVoiceCheck(fp.at, "节点", nd.label, nd.desc);
      }
      if (b.kind === "cards") for (const c of b.data.cards || []) humanVoiceCheck(fp.at, "卡片", c.title, c.desc);
    }
  }
  // ③ 证据留页脚:表格代码列/单元格行号;要点报代码位置密度 ≤1/3
  const EVIDENCE_COL_RE = /^(代码位置|代码|位置|文件|出处|源码|来源)$/i;
  const CELL_CITE_RE = /[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|h)(?:\s*[:：]\s*\d+)?|:\d{1,5}(?!\d)/;
  const BULLET_REF_RE = /[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java)(?:\s*[:：]\s*\d+)?|:\d{1,5}(?!\d)|\b\w+\(\)|\b[a-z]+[A-Z][a-zA-Z]{4,}\b/;
  for (const fp of flatPages) {
    for (const t of fp.page.blocks.filter((x) => x.kind === "table")) {
      const hit = (t.headers || []).find((hd) => EVIDENCE_COL_RE.test(String(hd || "").trim()));
      if (hit) add(fp.at, `表格放了「${hit}」列:证据收进页脚 \`> 证据:\` 行,表格列讲每项干什么`);
      let cellHit = "";
      for (const r of t.rows || []) {
        for (const c of r) {
          if (CELL_CITE_RE.test(String(c || ""))) { cellHit = String(c); break; }
        }
        if (cellHit) break;
      }
      if (cellHit) add(fp.at, `表格单元格含代码引用「${clamp(cellHit, 14)}」:行号/文件收进页脚证据行,单元格写内容本身`);
    }
    const bl = fp.page.blocks.filter((x) => x.kind === "bullets").flatMap((x) => x.items);
    const refs = bl.filter((b) => BULLET_REF_RE.test(`${b.lead || ""}${b.text || ""}`)).length;
    if (bl.length >= 2 && refs >= 2 && refs * 3 > bl.length) add(fp.at, `平铺证据:${refs}/${bl.length} 条要点在报代码位置/函数名——证据集中页脚一行,正文讲机制与影响(读者先看懂行为,再核对出处)`);
    // ④ 回边承诺 vs 版式能力:steps 画不出边——说了回边/循环回去就必须用 flow
    const saysBack = /回边|回到第|循环回|再转一圈/.test(`${fp.page.title || ""} ${fp.page.takeaway || ""}`);
    const hasFlowBack = fp.page.blocks.some((x) => x.kind === "flow");
    if (saysBack && !hasFlowBack) {
      const hasSteps = fp.page.blocks.some((x) => x.kind === "steps");
      add(fp.at, `标题/结论说了「回边/循环回去」,但${hasSteps ? "主版式是 steps——steps 画不出回边" : "本页没有 flow"},承诺在图上兑现不了:改用 flow(回边带条件语义标签),或改标题不提回边`);
    }
  }
  // ── v12 版式配位门(2026-11-18 产品口径要求「每页格式单调,从上往下一个模子;PPT 要多元素
  //    布局:左右布局、上下布局、大框凸显」;借鉴 ref/ZCode pptx SKILL §3:每页一个视觉焦点、
  //    对比用左右、关键洞察用大字凸显、禁同版式连用)──
  // ① 版式合法性与容量:值 ∈ {通栏,左图右文,右图左文,大字结论};左右页必须有图/表/码主体且要点 ≤3,
  //    steps >8 不许左右;大数字/引言/对比栏自带整页版式不许再标;大字结论页要点 ≤2 且结论 ≥14 字。
  // ② 多样性:≥10 内容页成稿,结构版式 ≥3 种;连续同结构版式 >4 页 = 翻页节奏塌。
  const LAYOUT_KINDS = new Set(["通栏", "左图右文", "右图左文", "大字结论"]);
  for (const fp of flatPages) {
    const pl = String(fp.page.pageLayout || "").trim();
    if (!pl) continue;
    if (!LAYOUT_KINDS.has(pl)) {
      add(fp.at, `版式「${pl}」不合法:只能是 通栏 / 左图右文 / 右图左文 / 大字结论`);
      continue;
    }
    const bl = fp.page.blocks.filter((x) => x.kind === "bullets").flatMap((x) => x.items);
    if (pl === "大字结论") {
      if (bl.length > 2) add(fp.at, `大字结论页解读 ${bl.length} 条:焦点页解读 ≤2 条——焦点是那句大字结论,不是再铺论证`);
      if ([...(fp.page.takeaway || "")].length < 14) add(fp.at, "大字结论页的结论 <14 字:要撑得起整页大字,写一句完整判断");
    }
    if (pl === "左图右文" || pl === "右图左文") {
      const mainKinds = new Set(fp.page.blocks.filter((b) => ["flow", "layers", "matrix", "timeline", "table", "code", "cards", "pseudo", "steps"].includes(b.kind)).map((b) => b.kind));
      if (mainKinds.size > 1) add(fp.at, `版式「${pl}」页放了 ${mainKinds.size} 种主版式块(${[...mainKinds].join("+")}):半幅只放一个主块,组合页拆两页或改通栏`);
      const hasMain = fp.page.blocks.some((b) => ["flow", "layers", "matrix", "timeline", "table", "code", "cards", "pseudo", "steps"].includes(b.kind));
      if (!hasMain) add(fp.at, `版式「${pl}」但本页没有图/表/码主版式块:左右布局要一侧有主体,纯要点页去掉版式行`);
      if (bl.length > 3) add(fp.at, `版式「${pl}」解读 ${bl.length} 条超 3:侧栏放不下,精简或改通栏`);
      if (fp.page.blocks.some((b) => b.kind === "steps" && b.items.length > 8)) add(fp.at, "steps >8 步不许左右布局(竖排也挤):改通栏两行回绕");
      if (fp.page.blocks.some((b) => ["stats", "quote", "compare"].includes(b.kind))) add(fp.at, `大数字/引言/对比栏自带整页版式,不要再标「${pl}」`);
    }
  }
  if (flatPages.length >= 10) {
    const structKind = (fp) => {
      const pl = String(fp.page.pageLayout || "").trim() || "通栏";
      if (pl !== "通栏") return pl;
      if (fp.page.blocks.some((b) => b.kind === "stats")) return "数字页";
      if (fp.page.blocks.some((b) => b.kind === "quote")) return "引言页";
      return "通栏";
    };
    const kinds = new Set(flatPages.map(structKind));
    if (kinds.size < 3) {
      add("全文", `版式单调:全稿只有 ${kinds.size} 种结构版式(${[...kinds].join("/")})——对比/机制页用 左图右文/右图左文 交替,每章挑 1 页关键洞察用 大字结论,过程总览用通栏:要 ≥3 种`);
    }
    let run = 1;
    for (let i = 1; i < flatPages.length; i++) {
      if (structKind(flatPages[i]) === structKind(flatPages[i - 1])) {
        run += 1;
        if (run > 4) {
          add(flatPages[i].at, `连续 ${run} 页同一结构版式(${structKind(flatPages[i])}):翻页节奏塌了——中间换 左右/大字/数字 页打断`);
          run = 1;
        }
      } else run = 1;
    }
  }
  // ── v13 内容源覆盖门(2026-11-18 轨迹分析:内容文档 20 份只读 2 份,叙事靠二手事实表)──
  // ≥20 页成稿,证据行引用的内容文档(叙事 md 源)≥5 份不同;代码文件是出处不是叙事源,不计入。
  // 例外:证据行 80%+ 都是代码文件(纯代码调研稿)跳过。
  if (flatPages.length >= 20) {
    const evidences = flatPages.map((fp) => String(fp.page.evidence || ""));
    const docRefs = new Set();
    let codeRefs = 0, totalRefs = 0;
    for (const ev of evidences) {
      for (const m of ev.matchAll(/[\w.-]+\.md/g)) { docRefs.add(m[0]); totalRefs += 1; }
      codeRefs += (ev.match(/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs)\b/g) || []).length;
      totalRefs += (ev.match(/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs)\b/g) || []).length;
    }
    const codeDominant = totalRefs > 0 && codeRefs / totalRefs >= 0.8;
    if (!codeDominant && docRefs.size < 5) {
      add("全文", `内容源覆盖不足:证据行只引了 ${docRefs.size} 份内容文档([${[...docRefs].slice(0, 4).join("、")}${docRefs.size ? "…" : ""}]),要 ≥5 份——叙事要从内容源文档重读重写,不是转述二手事实表;纯代码调研稿(证据 80%+ 是代码文件)不受此门限制`);
    }
  }
  // ── v14 内容质量门(2026-11-18 文本对比实测确认:wb 625 字/页+126 个带单位数字(39/61 页)+页页交叉引用,
  //    v11 370 字/页+6 个数字(3/41 页)+0 交叉引用;素材文档单份就有 162 个数字,写作端零挖掘)──
  // ① 具体性:≥20 页稿,含带单位/量级数字的页 ≥40%(wb 为 64%)——参数/实测/阈值是论证的骨头;
  // ② 交叉引用:正文含「见 P\d+/第 X 章」的页 ≥5——读者要知道这个话题在全篇哪里展开;
  // ③ 复述门:定义带术语与同页卡片标题/要点小标题相同=复述撑行,拒;
  // ④ 页构成节奏:连续 ≥3 页 block 构成签名完全相同=模板感,拒。
  if (flatPages.length >= 20) {
    const NUM_UNIT_RE = /\d+(?:\.\d+)?\s*(?:%|倍|次|毫秒|ms|s|秒|分钟|小时|天|KB|MB|GB|TB|token|K|M|万|亿|条|步|层|档|圈|轮|相位|阶段|分之)/;
    const pageTextV14 = (pg) => [pg.title, pg.takeaway, ...pg.blocks.flatMap((b) => {
      if (b.kind === "bullets") return b.items.map((x) => `${x.lead}${x.text}`);
      if (b.kind === "table") return [b.headers.join(""), ...b.rows.flat()];
      if (b.kind === "steps") return b.items.map((x) => `${x.label}${x.detail || ""}`);
      if (b.kind === "cards") return (b.data.cards || []).flatMap((c) => [c.title, c.desc, ...(c.subs || [])]);
      if (b.kind === "flow") return (b.data.nodes || []).flatMap((n) => [n.label, n.desc || ""]);
      if (b.kind === "stats") return (b.data.stats || []).map((x) => `${x.value}${x.label}`);
      return [];
    })].join(" ");
    const withNum = flatPages.filter((fp) => NUM_UNIT_RE.test(pageTextV14(fp.page))).length;
    if (withNum * 10 < flatPages.length * 4) {
      add("全文", `具体性不足:只有 ${withNum}/${flatPages.length} 页出现带单位/量级的数字(参数/实测/阈值/百分比),要 ≥40%(对标 64%)——定性形容词不是论证:去内容源把真实数字挖出来(实测值带日期口径,代码常量标来源,查不到写「口径待核」不许编)`);
    }
    const XREF_RE = /(?:见\s*P?\d{1,3}|第\s*[一二三四五六七八九十\d]{1,3}\s*章|P\d{1,3}\s*[–—-])/;
    const withXref = flatPages.filter((fp) => XREF_RE.test(pageTextV14(fp.page))).length;
    if (withXref < 5) {
      add("全文", `交叉引用只有 ${withXref} 页:≥20 页成稿要 ≥5 页出现「见 P\d+/第 X 章」——读者要知道这个话题在后续哪章展开、在哪里回扣(总览页与深拆页互指是最低配)`);
    }
  }
  // 复述门(窄化:lead 含新词→当页定义是首用正路径,不拦;拦的是同一术语全稿重复定义)
  {
    const defSeen = new Map();
    for (const fp of flatPages) {
      for (const d of fp.page.definitions || []) {
        const term = String(d.term || "").trim();
        if (!term) continue;
        if (defSeen.has(term)) {
          add(fp.at, `术语「${clamp(term, 10)}」在第 ${defSeen.get(term)} 页已定义过——同一术语只定义一次,后面再出现直接用;重复定义=复述撑行`);
        } else defSeen.set(term, fp.at);
      }
    }
  }
  // ── v15 叙事粘合门(2026-11-19 文字版对比实测确认:对标稿每页「接前段」承接句,我们 0 处——页是并列不是链条)──
  // ≥12 内容页成稿,带 `> 承上:` 的页 ≥50%;承上 8~42 字且不得与标题同义。
  if (flatPages.length >= 12) {
    const withCarry = flatPages.filter((fp) => String(fp.page.carry || "").trim().length >= 8);
    if (withCarry.length * 2 < flatPages.length) {
      add("全文", `叙事粘合不足:只有 ${withCarry.length}/${flatPages.length} 页带 \`> 承上:\` 承接句(要 ≥50%)——每页写一句「接住上一页/上一章哪条线」(如「骨架看清了,下一问是一家怎么落地」),页与页才是链条不是并列`);
    }
    for (const fp of flatPages) {
      const c = String(fp.page.carry || "").trim();
      if (!c) continue;
      if ([...c].length > 42) add(fp.at, `承上句 ${[...c].length} 字超 42:一句「从哪条线来」,不是摘要`);
      if (c === (fp.page.title || "").trim()) add(fp.at, "承上句与标题重复:承上讲「上一页的线」,不是复述本页标题");
    }
  }
  {
    const sigOf = (pg) => pg.blocks.filter((b) => b.kind !== "bullets" || true).map((b) => b.kind).sort().join("+");
    let run = 1;
    for (let i = 1; i < flatPages.length; i++) {
      if (sigOf(flatPages[i].page) === sigOf(flatPages[i - 1].page)) {
        run += 1;
        if (run >= 3) {
          add(flatPages[i].at, `连续 ${run} 页页面构成完全相同(${sigOf(flatPages[i].page)})——模板感:换一种块型(表/cards/flow/大数字)或合并`);
          run = 1;
        }
      } else run = 1;
    }
  }
  return issues;
}

/** v13 代际查重(2026-11-18 session 轨迹分析实测确认:重生成任务把旧稿文字照抄 41/42 页只换版式)——
 * 重生成导出时与归档旧稿逐页比对,bigram Dice 相似度;换皮稿在导出层被拒,不靠任务书自觉。 */
const bigramsOf = (t) => {
  const str = String(t || "").replace(/\s+/g, "");
  const set = new Set();
  for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
  return set;
};
const diceRatio = (a, b) => {
  const A = bigramsOf(a), B = bigramsOf(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return (2 * inter) / (A.size + B.size);
};
export function regenSimilarity(deck, oldMd) {
  const old = parseDeckMd(String(oldMd || ""));
  const keyOf = (t) => String(t || "").replace(/[\s版式:通栏左右图文大结论(),,。:;——-]/g, "").slice(0, 18);
  const oldPages = new Map();
  old.chapters.forEach((c) => c.pages.forEach((pg) => oldPages.set(keyOf(pg.title), pg)));
  const bodyOf = (pg) => {
    const parts = [];
    for (const b of pg.blocks) {
      if (b.kind === "bullets") for (const it of b.items) parts.push(`${it.lead}${it.text}`);
      if (b.kind === "steps") for (const it of b.items) parts.push(`${it.label}${it.detail || ""}`);
      if (b.kind === "table") for (const r of b.rows) parts.push(r.join(""));
      if (b.kind === "flow") for (const n of b.data.nodes || []) parts.push(`${n.label}${n.desc || ""}`);
      if (b.kind === "cards") for (const cd of b.data.cards || []) parts.push(`${cd.title}${cd.desc || ""}`);
      if (b.kind === "pseudo" || b.kind === "code") parts.push(JSON.stringify(b.data).slice(0, 200));
    }
    if (pg.takeaway) parts.push(pg.takeaway);
    return parts.join("\n");
  };
  let matched = 0, twin = 0, total = 0;
  const twins = [];
  deck.chapters.forEach((c) => c.pages.forEach((pg, i) => {
    total += 1;
    const o = oldPages.get(keyOf(pg.title));
    if (!o) return;
    matched += 1;
    const r = diceRatio(bodyOf(pg), bodyOf(o));
    if (r >= 0.85) { twin += 1; twins.push(`${c.no}.${i + 1} ${clamp(pg.title, 12)}(${r.toFixed(2)})`); }
  }));
  return { total, matched, twin, twins };
}

/** 版式计划:封面 + 内容页;章名进页眉,章 claim 只做本章首屏导语。 */
export function planDeck(deck) {
  const plan = [];
  const chapters = deck.chapters.map((c, i) => ({ ...c, no: c.no || String(i + 1).padStart(2, "0") }));
  plan.push({
    kind: "cover",
    title: cleanTitle(deck.title),
    subtitle: deck.subtitle,
    genre: deck.genre,
    theme: deck.theme || DEFAULT_THEME,
    kicker: deck.kicker || (deck.genre === "composition" ? "BRIEFING" : "REPORT"),
    verdict: humanize(deck.verdict),
    verdictNote: deck.verdictNote,
    spine: clamp(deck.spine, 90),
    notCovering: deck.notCovering || "",
    dataPolicy: deck.dataPolicy || "",
    meta: deck.meta,
    toc: chapters.map((c) => ({ no: c.no, title: c.title })),
  });
  for (const ch of chapters) {
    ch.pages.forEach((pg, i) => {
      const pick = (k) => pg.blocks.find((b) => b.kind === k) || null;
      const visual = pick("flow") || pick("layers") || pick("matrix") || pick("timeline");
      const table = pick("table");
      const steps = pick("steps");
      const compare = pick("compare");
      const stats = pick("stats");
      const quote = pick("quote");
      const codeB = pick("code");
      const cardsB = pick("cards");
      const pseudoB = pick("pseudo");
      // v12 修复:visual 优先于 cards/pseudo——flow+cards 组合页旧版 layout 取 cards,flow 被静默丢弃
      const layout = codeB ? "code" : visual ? "visual" : cardsB ? "cards" : pseudoB ? "pseudo" : compare ? "compare" : stats ? "stats" : quote ? "quote" : table ? "table" : steps ? "steps" : "list";
      plan.push({
        kind: "content",
        chapterNo: ch.no,
        chapterTitle: ch.title,
        // 章主张只在本章首页展示,单行截断(网格为它保留固定一行,非首页留白)
        kicker: i === 0 ? clamp(humanize(ch.claim), 64) : "",
        no: `${ch.no}.${i + 1}`,
        title: pg.title,
        layout,
        visual: visual ? visual.data : null,
        table: table ? { headers: table.headers, rows: table.rows } : null,
        steps: steps ? steps.items : null,
        compare: compare ? compare.data : null,
        stats: stats ? stats.data : null,
        quote: quote ? quote.data : null,
        code: codeB ? codeB.data : null,
        cards: cardsB ? cardsB.data : null,
        pseudo: pseudoB ? pseudoB.data : null,
        bullets: pg.blocks.filter((b) => b.kind === "bullets").flatMap((b) => b.items),
        takeaway: pg.takeaway,
        definitions: pg.definitions || [],
        status: pg.status || "",
        pageLayout: pg.pageLayout || "",
        carry: pg.carry || "",
        evidence: pg.evidence,
      });
    });
  }
  return plan.map((s, i) => ({ ...s, pageIndex: i + 1, total: plan.length }));
}

// ---------------------------------------------------------------- 渲染

/** v5 页面四区网格(所有内容页共用,翻页节奏一致):
 *  眉 0.38 → 标题 0.66(26pt,≤2 行) → 章主张行 1.50(本章首页,单行) → 结论带 1.86(高 0.52)
 *  → 主体区 2.54 起 → 支撑区锚定 6.64 上方 → 脚注 6.78。主体+支撑共 4.1 英寸,按内容再分配。 */
const GRID = { eyebrowY: 0.38, titleY: 0.66, titleH: 0.8, claimY: 1.5, bandY: 1.86, bandH: 0.52, mainTop: 2.54, footLimit: 6.64 };

// v12 版式引擎:主体区当前矩形(通栏=整幅;左图右文/右图左文=半幅)。主体渲染器一律读
// ZX/ZW;页面全局件(页眉/结论带/定义带/页脚)仍用整幅 M/W,不受版式影响。
let ZX = M;
let ZW = W - 2 * M;
const setZone = (x, w) => { ZX = x; ZW = w; };
const resetZone = () => { ZX = M; ZW = W - 2 * M; };

/** 页眉:章名 + 标题 + (本章首页)章主张(不画装饰线/色条,规范点名 AI 稿特征)。 */
function pageHead(slide, s) {
  slide.background = { color: BG };
  slide.addText(`${s.chapterNo} / ${s.chapterTitle}`, {
    x: M, y: GRID.eyebrowY, w: 8, h: 0.3, fontFace: FONT, fontSize: 12, color: PRIMARY, charSpacing: 0.8, margin: 0, bold: true,
  });
  // v9 状态徽标:机制页右上角标落地程度(已落地绿/部分落地琥珀/设计目标灰)
  if (s.status) {
    const st = String(s.status);
    const col = st === "已落地" ? PRIMARY : st === "部分落地" ? ACCENT : MUTED;
    const fill = st === "已落地" ? PRIMARY : st === "部分落地" ? ACCENT : LINE;
    const txt = st === "已落地" || st === "部分落地" ? BG : TEXT;
    slide.addShape("roundRect", { x: W - M - 1.15, y: GRID.eyebrowY - 0.03, w: 1.15, h: 0.3, rectRadius: 0.15, fill: { color: fill }, line: { color: col, width: 0 }, shadow: { type: "none" } });
    slide.addText(st, { x: W - M - 1.15, y: GRID.eyebrowY - 0.03, w: 1.15, h: 0.3, fontFace: FONT, fontSize: 10.5, bold: true, color: txt, align: "center", valign: "middle", margin: 0 });
  }
  slide.addText(s.title, {
    x: M, y: GRID.titleY, w: W - 2 * M, h: GRID.titleH, fontFace: FONT, fontSize: 26, bold: true, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.1,
  });
  // v15 承上行:标题下一句「从上一页哪条线来」(wb 的接前段);与章主张行同位,承上优先
  if (s.carry) {
    slide.addText("承上 · " + clamp(s.carry, 42), {
      x: M, y: GRID.claimY, w: W - 2 * M, h: 0.28, fontFace: FONT, fontSize: 11.5, color: MUTED, margin: 0, valign: "top",
    });
  } else if (s.kicker) {
    slide.addText(s.kicker, {
      x: M, y: GRID.claimY, w: W - 2 * M, h: 0.28, fontFace: FONT, fontSize: 13, color: MUTED, margin: 0, valign: "top",
    });
  }
  return GRID;
}

/** 结论带(「结论」):紧跟标题、主体之上——结论先行,洞察不再沉底。
 *  标签用「结论」而非「所以」:单页被截图传播时,「所以」是断头逻辑。 */
function renderTakeaway(slide, s, y) {
  if (!s.takeaway) return;
  const h = GRID.bandH;
  slide.addShape("roundRect", { x: M, y, w: W - 2 * M, h, rectRadius: 0.04, fill: { color: SURFACE_2 }, line: { color: SURFACE_2, width: 0 }, shadow: { type: "none" } });
  slide.addShape("rect", { x: M, y: y + 0.07, w: 0.055, h: h - 0.14, fill: { color: ACCENT }, line: { color: ACCENT, width: 0 } });
  slide.addText("结论", { x: M + 0.2, y: y + 0.04, w: 0.56, h: h - 0.08, fontFace: FONT, fontSize: 11.5, bold: true, color: ACCENT, margin: 0, valign: "middle" });
  slide.addText(clamp(s.takeaway, 42), {
    x: M + 0.84, y: y + 0.04, w: W - 2 * M - 1.04, h: h - 0.08, fontFace: FONT, fontSize: 16, bold: true, color: TEXT, margin: 0, valign: "middle",
  });
}

function pageFoot(slide, s) {
  if (s.evidence) {
    slide.addText("来源 · " + s.evidence, {
      x: M, y: 6.78, w: 10.3, h: 0.52, fontFace: FONT, fontSize: 12, color: MUTED, margin: 0,
      valign: "bottom", lineSpacingMultiple: 1.05,
    });
  }
  slide.addText(`${s.pageIndex} / ${s.total}`, {
    x: W - M - 1.2, y: 6.98, w: 1.2, h: 0.28, fontFace: FONT, fontSize: 12, color: MUTED, align: "right", margin: 0,
  });
}

/** 要点页:编号行表(无容器、细线分隔),不是裸 bullet 列表。 */
function renderList(slide, s, top) {
  const bs = s.bullets;
  const n = bs.length;
  const bottom = GRID.footLimit;
  const avail = bottom - top;
  const rowH = Math.min(1.32, avail / Math.max(1, n));
  const lead = n >= 5 ? 19 : 22;
  const detail = n >= 5 ? 15.5 : 16.5;
  bs.forEach((b, i) => {
    const y = top + i * rowH;
    slide.addText(String(i + 1).padStart(2, "0"), {
      x: ZX, y: y + 0.06, w: 0.62, h: 0.32, fontFace: FONT, fontSize: 14, bold: true, color: PRIMARY, margin: 0,
    });
    if (b.lead) {
      slide.addText(b.lead, { x: ZX + 0.64, y, w: ZW - 0.64, h: 0.42, fontFace: FONT, fontSize: lead, bold: true, color: TEXT, margin: 0 });
      slide.addText(b.text, {
        x: ZX + 0.64, y: y + 0.44, w: ZW - 0.64, h: rowH - 0.52, fontFace: FONT, fontSize: detail, color: MUTED, margin: 0, valign: "top",
      });
    } else {
      slide.addText(b.text, { x: ZX + 0.64, y, w: ZW - 0.64, h: rowH - 0.1, fontFace: FONT, fontSize: lead, color: TEXT, margin: 0 });
    }
  });
}

function renderTable(slide, s, top, h) {
  const t = s.table;
  const cols = t.headers.length;
  const colW = Array.from({ length: cols }, () => (ZW) / cols);
  const rowH = Math.min(0.72, Math.max(0.4, (h - 0.46) / Math.max(1, t.rows.length)));
  const rows = [
    t.headers.map((hd) => ({ text: hd, options: { bold: true, color: PRIMARY, fontSize: 14, fill: { color: SURFACE_2 } } })),
    ...t.rows.map((r, ri) =>
      r.map((c) => ({ text: c, options: { color: TEXT, fontSize: 13.5, fill: { color: ri % 2 === 0 ? BG : SURFACE } } })),
    ),
  ];
  slide.addTable(rows, {
    x: ZX, y: top, w: ZW, colW,
    border: { type: "solid", color: LINE, pt: 0.75 },
    margin: 0.08, valign: "middle", autoPage: false,
    rowH: [0.46, ...t.rows.map(() => rowH)],
  });
  return top + 0.46 + t.rows.length * rowH;
}

function renderSteps(slide, s, top, h) {
  const items = s.steps;
  const n = items.length;
  if (n <= 6) {
    const gap = 0.24;
    const w = (ZW - gap * (n - 1)) / n;
    const boxY = top + 0.1;
    const boxH = 1.02;
    // v5:说明区高度尊重主体区预算(旧版固定 1.05,预算小的页顶进支撑区)
    const detailH = items.some((i) => i.detail) ? Math.max(0.42, Math.min(1.05, h - 1.35)) : 0;
    items.forEach((it, i) => {
      const x = ZX + i * (w + gap);
      slide.addShape("ellipse", { x: x + 0.02, y: boxY + 0.04, w: 0.42, h: 0.42, fill: { color: i === 0 ? ACCENT : SURFACE }, line: { color: i === 0 ? ACCENT : LINE, width: 1 }, shadow: { type: "none" } });
      slide.addText(String(i + 1), { x: x + 0.02, y: boxY + 0.07, w: 0.42, h: 0.34, fontFace: FONT, fontSize: 13, bold: true, color: i === 0 ? BG : PRIMARY, align: "center", margin: 0 });
      slide.addText(clamp(it.label, 16), { x: x + 0.54, y: boxY + 0.02, w: w - 0.54, h: 0.48, fontFace: FONT, fontSize: 17, bold: true, color: TEXT, margin: 0, valign: "top" });
      if (it.detail) {
        const fs = detailH >= 0.8 ? 13.5 : 12.5;
        slide.addText(clamp(it.detail, 46), { x, y: boxY + 0.62, w, h: detailH, fontFace: FONT, fontSize: fs, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.2 });
      }
      if (i < n - 1) {
        slide.addShape("line", { x: x + w - 0.06, y: boxY + 0.25, w: gap + 0.06, h: 0, line: { color: LINE, width: 1 } });
      }
    });
    return boxY + boxH + detailH;
  }
  // v11 两行回绕(≥7 步):全流程总览一页走完(workbuddy 范式)——单行每格宽 <1.4in,
  // 说明被挤成竖条;两行 × ceil(n/2) 格,每格放得下「名字 + 一句人话职责」。
  const per = Math.ceil(n / 2);
  const gap = 0.2;
  const vgap = 0.34;
  const w = (ZW - gap * (per - 1)) / per;
  const rowH = Math.max(1.16, Math.min(1.52, (h - vgap) / 2));
  const detailH = Math.max(0.5, rowH - 0.62);
  for (let r = 0; r < 2; r++) {
    const y = top + r * (rowH + vgap);
    const count = r === 0 ? Math.min(per, n) : n - per;
    for (let i = 0; i < count; i++) {
      const idx = r * per + i;
      const it = items[idx];
      const x = ZX + i * (w + gap);
      slide.addShape("ellipse", { x: x + 0.02, y: y + 0.03, w: 0.36, h: 0.36, fill: { color: idx === 0 ? ACCENT : SURFACE }, line: { color: idx === 0 ? ACCENT : LINE, width: 1 }, shadow: { type: "none" } });
      slide.addText(String(idx + 1), { x: x + 0.02, y: y + 0.05, w: 0.36, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: idx === 0 ? BG : PRIMARY, align: "center", margin: 0 });
      slide.addText(clamp(it.label, 16), { x: x + 0.44, y: y, w: w - 0.44, h: 0.52, fontFace: FONT, fontSize: 15, bold: true, color: TEXT, margin: 0, valign: "top" });
      if (it.detail) {
        slide.addText(clamp(it.detail, 46), { x, y: y + 0.56, w, h: detailH, fontFace: FONT, fontSize: 10.5, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.1 });
      }
      if (i < count - 1) {
        slide.addShape("line", { x: x + w - 0.04, y: y + 0.21, w: gap + 0.08, h: 0, line: { color: LINE, width: 1 } });
      }
    }
  }
  // 行间连接:第一行末尾 → 第二行开头(读者从 ⑥ 跳 ⑦ 不用猜方向)
  const lastX = ZX + (Math.min(per, n) - 1) * (w + gap) + w / 2;
  const firstX = ZX + w / 2;
  const midY = top + rowH + vgap / 2;
  slide.addShape("line", { x: lastX, y: top + rowH, w: 0, h: vgap / 2, line: { color: LINE, width: 1 } });
  slide.addShape("line", { x: firstX, y: midY, w: lastX - firstX, h: 0, line: { color: LINE, width: 1 } });
  slide.addShape("line", { x: firstX, y: midY, w: 0, h: vgap / 2, line: { color: LINE, width: 1, endArrowType: "triangle" } });
  return top + rowH * 2 + vgap;
}

function renderCompare(slide, s, top, h) {
  const cols = s.compare.cols;
  const n = cols.length;
  const gap = 0.3;
  const w = (ZW - gap * (n - 1)) / n;
  const maxItems = Math.max(...cols.map((c) => c.items.length), 1);
  h = Math.min(h, 1.1 + maxItems * 0.78);
  cols.forEach((c, i) => {
    const x = ZX + i * (w + gap);
    slide.addText(c.name, { x, y: top + 0.04, w, h: 0.42, fontFace: FONT, fontSize: 20, bold: true, color: i === 0 ? PRIMARY : ACCENT, margin: 0 });
    const step = Math.min(0.74, (h - 0.62) / Math.max(1, c.items.length));
    const fs2 = step >= 0.58 ? 17 : 14.5;
    c.items.forEach((it, j) => {
      slide.addText([
        { text: it, options: { bullet: { characterCode: "2013", indent: 12 }, color: TEXT } },
      ], {
        x, y: top + 0.58 + j * step, w, h: step - 0.04,
        fontFace: FONT, fontSize: fs2, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.18,
      });
    });
  });
  return top + h;
}

function renderStats(slide, s, top, h) {
  const st = s.stats.stats;
  // v5:数字同权重(同字号同色)——旧版第一个数字 64pt+强调色、其余 40pt,实测被点评
  //「同层级指标样式不一致,强调逻辑说不通」。要突出结论,靠结论带,不靠数字变脸。
  // v5.1:三栏真实网格(等宽列、全部居中对齐、同一基线),数字加大到 44pt 撑起主体区。
  const blockH = Math.min(h, 2.3);
  const n = st.length;
  const gap = 0.3;
  const w = (ZW - gap * (n - 1)) / n;
  st.forEach((it, i) => {
    const x = ZX + i * (w + gap);
    slide.addText(it.value, {
      x, y: top + 0.1, w, h: 0.86, fontFace: FONT, fontSize: 44, bold: true, color: PRIMARY, margin: 0, valign: "bottom", align: "center",
    });
    slide.addText(it.label, { x: x + 0.05, y: top + 1.04, w: w - 0.1, h: 0.62, fontFace: FONT, fontSize: 14, color: TEXT, margin: 0, valign: "top", align: "center", lineSpacingMultiple: 1.1 });
    if (it.source) {
      slide.addText(it.source, { x: x + 0.05, y: top + 1.7, w: w - 0.1, h: 0.44, fontFace: FONT, fontSize: 11.5, color: MUTED, margin: 0, valign: "top", align: "center", lineSpacingMultiple: 1.05 });
    }
  });
  return top + blockH;
}

function renderQuote(slide, s, top, h) {
  const q = s.quote;
  // v5:引言字号随预算收缩(预算 <2.6in 时 40pt 会顶穿支撑区)
  const big = h >= 2.6;
  const fs = big ? 40 : 31;
  const y2 = top + (big ? 1.8 : 1.42);
  slide.addText(q.statement, {
    x: ZX, y: top + 0.35, w: ZW - 1.4, h: big ? 1.3 : 1.0, fontFace: FONT, fontSize: fs, bold: true, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.12,
  });
  if (q.note) {
    slide.addText(q.note, { x: ZX, y: y2, w: ZW - 1.3, h: 0.95, fontFace: FONT, fontSize: big ? 20 : 16.5, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.25 });
  }
  return top + (big ? 2.95 : 2.4);
}

function renderLayers(slide, d, top, h) {
  const n = d.bands.length;
  const gap = 0.18;
  const bandH = (h - gap * (n - 1)) / n;
  const labelW = 1.7;
  d.bands.forEach((b, i) => {
    const y = top + i * (bandH + gap);
    slide.addShape("roundRect", { x: ZX, y, w: ZW, h: bandH, rectRadius: 0.06, fill: { color: SURFACE }, line: { color: SURFACE, width: 0 }, shadow: { type: "none" } });
    slide.addText(b.name, { x: ZX + 0.24, y, w: labelW - 0.32, h: bandH, fontFace: FONT, fontSize: 15, bold: true, color: PRIMARY, margin: 0, valign: "middle" });
    const k = b.boxes.length;
    const areaW = ZW - labelW - 0.24;
    const bgap = 0.14;
    const bw = (areaW - bgap * (k - 1)) / k;
    b.boxes.forEach((t, j) => {
      const x = M + labelW + j * (bw + bgap);
      slide.addShape("roundRect", { x, y: y + 0.12, w: bw, h: bandH - 0.24, rectRadius: 0.05, fill: { color: SURFACE_2 }, line: { color: SURFACE_2, width: 0 }, shadow: { type: "none" } });
      slide.addText(clamp(t, 20), { x: x + 0.1, y: y + 0.12, w: bw - 0.2, h: bandH - 0.24, fontFace: FONT, fontSize: bandH < 0.8 ? 12.5 : 14, color: TEXT, align: "center", valign: "middle", margin: 0 });
    });
  });
  return top + h;
}

function renderFlow(slide, d, top, h) {
  const ids = d.nodes.map((n) => n.id);
  // 先 DFS 标出回边,只在去掉回边的 DAG 上做最长路径分层——
  // 实测:写入链里 decide→recv 的回边把整张图的 rank 顶到极端值,节点被挤到右侧两列并互相压住。
  const adj = new Map(ids.map((id) => [id, []]));
  for (const e of d.edges) (adj.get(e.from) || []).push(e.to);
  const color = new Map(ids.map((id) => [id, 0]));
  const back = new Set();
  const dfs = (u) => {
    color.set(u, 1);
    for (const v of adj.get(u) || []) {
      if (color.get(v) === 1) { back.add(`${u}->${v}`); continue; }
      if (color.get(v) === 0) dfs(v);
    }
    color.set(u, 2);
  };
  ids.forEach((id) => { if (color.get(id) === 0) dfs(id); });
  const rank = new Map(ids.map((id) => [id, 0]));
  for (let it = 0; it <= ids.length; it++) {
    let changed = false;
    for (const e of d.edges) {
      if (back.has(`${e.from}->${e.to}`)) continue;
      const nr = (rank.get(e.from) ?? 0) + 1;
      if (nr > (rank.get(e.to) ?? 0)) { rank.set(e.to, nr); changed = true; }
    }
    if (!changed) break;
  }
  const cols = Math.max(...ids.map((id) => rank.get(id) ?? 0)) + 1;
  const gapX = 0.5;
  const nodeW = Math.min(2.45, (ZW - gapX * (cols - 1)) / cols);
  const stepX = cols > 1 ? (ZW - nodeW) / (cols - 1) : 0;
  const byCol = new Map();
  for (const n of d.nodes) {
    const r = rank.get(n.id) ?? 0;
    if (!byCol.has(r)) byCol.set(r, []);
    byCol.get(r).push(n);
  }
  const maxRows = Math.max(...[...byCol.values()].map((l) => l.length), 1);
  // 行数多时压节点高与行距,保证整张图落在给定高度内(实测:固定 0.92 会压到下方要点)
  const vgap = maxRows >= 3 ? 0.22 : 0.4;
  // v11:带 desc 的节点(标题+两行说明)最低 0.74 才放得下,旧底 0.6 会溢出节点盒
  const hasDesc = d.nodes.some((n) => n.desc);
  const floorH = hasDesc ? 0.74 : 0.6;
  const nodeH = Math.min(0.92, Math.max(floorH, (h - 0.24 - vgap * (maxRows - 1)) / maxRows));
  const pos = new Map();
  for (const [r, list] of byCol) {
    const total = list.length * nodeH + (list.length - 1) * vgap;
    // v5.1:富余高度偏上 25% —— 图贴近结论带,空隙留给图与支撑区之间(有分隔线收口,不像洞)
    const startY = top + 0.12 + Math.max(0, (h - 0.24 - total) * 0.25);
    list.forEach((n, i) => pos.set(n.id, { x: ZX + r * stepX, y: startY + i * (nodeH + vgap), r }));
  }
  const out = (id) => d.edges.filter((e) => e.from === id);
  const labels = [];
  const laneY = top + h - 0.16;
  for (const e of d.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const ax = a.x + nodeW;
    const ay = a.y + nodeH / 2;
    const bx = b.x;
    const by = b.y + nodeH / 2;
    if (b.r > a.r) {
      if (Math.abs(by - ay) < 0.02) {
        slide.addShape("line", { x: ax, y: ay, w: bx - ax, h: 0, line: { color: MUTED, width: 1.5, endArrowType: "triangle" } });
      } else {
        const midX = (ax + bx) / 2;
        slide.addShape("line", { x: ax, y: ay, w: midX - ax, h: 0, line: { color: MUTED, width: 1.5 } });
        slide.addShape("line", { x: midX, y: Math.min(ay, by), w: 0, h: Math.abs(by - ay), line: { color: MUTED, width: 1.5 } });
        slide.addShape("line", { x: midX, y: by, w: bx - midX, h: 0, line: { color: MUTED, width: 1.5, endArrowType: "triangle" } });
      }
      if (e.label) {
        // v11:前向边标签放「列间通道」里,不再贴目标节点顶部(旧位 by-0.34 会压到带 desc 节点的说明文字)
        if (Math.abs(by - ay) < 0.02) {
          labels.push({ text: e.label, x: (ax + bx) / 2 - 0.48, y: ay - Math.max(0.3, nodeH / 2 + 0.04), w: 0.96 });
        } else {
          const midX = (ax + bx) / 2;
          labels.push({ text: e.label, x: midX - 0.48, y: (Math.min(ay, by) + Math.max(ay, by)) / 2 - 0.16, w: 0.96 });
        }
      }
    } else {
      // v5 回边:源底边中点 → 下方通道 → 目标底边中点(正交折线,箭头明确进目标底边);
      // v5.1 回边升格为主角:强调色+加粗——全页最该被看见的机制不能再是一条灰色细线。
      const sx = a.x + nodeW / 2;
      const sy = a.y + nodeH;
      const tx = b.x + nodeW / 2;
      const ty = b.y + nodeH;
      slide.addShape("line", { x: sx, y: sy, w: 0, h: laneY - sy, line: { color: ACCENT, width: 1.75 } });
      slide.addShape("line", { x: Math.min(sx, tx), y: laneY, w: Math.abs(tx - sx), h: 0, line: { color: ACCENT, width: 1.75 } });
      slide.addShape("line", { x: tx, y: ty, w: 0, h: laneY - ty, line: { color: ACCENT, width: 1.75, beginArrowType: "triangle" } });
      if (e.label) labels.push({ text: e.label, x: (sx + tx) / 2 - 0.72, y: laneY - 0.16, w: 1.44 });
    }
  }
  for (const n of d.nodes) {
    const p = pos.get(n.id);
    const decision = out(n.id).filter((e) => e.label).length >= 2;
    // 回边落点也升格(强调边框):回边的两端必须一眼有着落
    const backTarget = d.edges.some((e) => {
      const pa = pos.get(e.from);
      const pb = pos.get(e.to);
      return pa && pb && pb.r <= pa.r && e.to === n.id;
    });
    const hot = decision || backTarget;
    // v5:普通节点也带 LINE 细边框——旧版无边框的白盒在纸底上「对比太弱,边框几乎没有」。
    // v13(全稿普查):窄列节点字号自适应——定宽硬折会把 4 字标签断成「末行单字悬挂」(9/43 页)
    const labelFs = nodeW < 1.75 ? 11.5 : nodeW < 2.1 ? 12.5 : 14;
    slide.addShape("roundRect", { x: p.x, y: p.y, w: nodeW, h: nodeH, rectRadius: 0.06, fill: { color: SURFACE }, line: { color: hot ? ACCENT : LINE, width: hot ? 1.5 : 1 }, shadow: { type: "none" } });
    // v8:有描述的节点分两行(标题粗体 + 描述小字),workbuddy 的因果链节点都带「为什么」
    if (n.desc) {
      slide.addText(clamp(n.label, 16), {
        x: p.x + 0.1, y: p.y + 0.05, w: nodeW - 0.2, h: Math.max(0.22, nodeH * 0.42),
        fontFace: FONT, fontSize: Math.max(11, labelFs - 1), bold: true, color: TEXT, align: "center", valign: "bottom", margin: 0,
      });
      slide.addText(clamp(n.desc, 32), {
        x: p.x + 0.08, y: p.y + nodeH * 0.46, w: nodeW - 0.16, h: Math.max(0.2, nodeH * 0.52),
        fontFace: FONT, fontSize: [...n.desc].length >= 18 ? 10 : 10.5, color: MUTED, align: "center", valign: "top", margin: 0, lineSpacingMultiple: 1.05,
      });
    } else {
      slide.addText(clamp(n.label, 16), {
        x: p.x + 0.1, y: p.y + 0.06, w: nodeW - 0.2, h: nodeH - 0.12,
        fontFace: FONT, fontSize: labelFs, bold: true, color: TEXT, align: "center", valign: "middle", margin: 0,
      });
    }
  }
  // v11 标签避让:同带标签两两水平重叠时上下错开(平行条件边的标签互相盖住=条件看不见)
  labels.sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 1; i < labels.length; i++) {
    for (let j = 0; j < i; j++) {
      const A = labels[j], B = labels[i];
      const aw = A.w || 0.6, bw = B.w || 0.6;
      if (Math.abs(A.y - B.y) < 0.28 && B.x < A.x + aw && B.x + bw > A.x) {
        B.y = B.y >= laneY - 0.3 ? A.y - 0.3 : A.y + 0.3;
      }
    }
  }
  // v11 标签-节点避让:标签底块不许压节点文字——压到就挪到该节点的上方或下方空白
  const nodeRects = d.nodes.map((n) => ({ ...pos.get(n.id) })).filter(Boolean);
  for (const L of labels) {
    const lw = L.w || 0.6;
    for (const r of nodeRects) {
      const xOverlap = L.x + lw > r.x + 0.04 && L.x < r.x + nodeW - 0.04;
      const yOverlap = L.y + 0.3 > r.y + 0.03 && L.y < r.y + nodeH - 0.03;
      if (!xOverlap || !yOverlap) continue;
      const upOk = r.y - 0.34 >= top - 0.02;
      L.y = upOk ? r.y - 0.34 : r.y + nodeH + 0.04;
      break;
    }
  }
  for (const l of labels) {
    // v5:标签从 4 字放宽到 12 字——「回边」这类同义反复被质量门拒,标签要写条件语义。
    slide.addText(clamp(l.text, 12), {
      x: l.x, y: l.y, w: l.w || 0.6, h: 0.3, margin: 0, fontFace: FONT,
      fontSize: 12.5, bold: true, color: ACCENT, align: "center", valign: "middle",
      fill: { color: BG }, line: { color: BG, width: 0 },
    });
  }
  return top + h;
}

function renderMatrix(slide, d, top, h) {
  const padL = 0.9;
  const padT = 0.38;
  const gap = 0.18;
  const cw = (ZW - padL - gap) / 2;
  const ch = (h - padT - gap) / 2;
  const POS = { "高影响低概率": [0, 0], "高影响高概率": [0, 1], "低影响低概率": [1, 0], "低影响高概率": [1, 1] };
  const FILL = { "高影响高概率": MATRIX_FILL.hh, "高影响低概率": MATRIX_FILL.hl, "低影响高概率": MATRIX_FILL.lh, "低影响低概率": MATRIX_FILL.ll };
  const BORDER = { "高影响高概率": DANGER, "高影响低概率": ACCENT, "低影响高概率": PRIMARY, "低影响低概率": LINE };
  const TITLE = { "高影响高概率": DANGER, "高影响低概率": ACCENT, "低影响高概率": PRIMARY, "低影响低概率": MUTED };
  slide.addText((d.axes?.y || "影响") + " ↑", { x: ZX, y: top, w: 1.4, h: 0.3, fontFace: FONT, fontSize: 13, color: MUTED, margin: 0 });
  slide.addText((d.axes?.x || "概率") + " →", { x: W - M - 1.6, y: top, w: 1.6, h: 0.3, fontFace: FONT, fontSize: 13, color: MUTED, align: "right", margin: 0 });
  for (const cell of d.cells) {
    const p = POS[cell.key];
    if (!p) continue;
    const x = M + padL + p[1] * (cw + gap);
    const y = top + padT + p[0] * (ch + gap);
    slide.addShape("roundRect", { x, y, w: cw, h: ch, rectRadius: 0.05, fill: { color: FILL[cell.key] || SURFACE }, line: { color: BORDER[cell.key] || LINE, width: 1 }, shadow: { type: "none" } });
    slide.addText(cell.key, { x: x + 0.18, y: y + 0.1, w: cw - 0.36, h: 0.26, fontFace: FONT, fontSize: 12.5, bold: true, color: TITLE[cell.key] || PRIMARY, margin: 0 });
    const area = ch - 0.5;
    const step = Math.min(0.52, area / Math.max(1, cell.items.length));
    const mfs = step >= 0.45 ? 13.5 : 12;
    cell.items.forEach((t, i) => {
      slide.addText(
        [{ text: clamp(t, 26), options: { bullet: { characterCode: "2013", indent: 10 }, color: TEXT } }],
        { x: x + 0.18, y: y + 0.42 + i * step, w: cw - 0.36, h: step - 0.02, fontFace: FONT, fontSize: mfs, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.12 },
      );
    });
  }
  return top + h;
}

function renderTimeline(slide, d, top, h) {
  const n = d.phases.length;
  const gap = 0.26;
  const w = (ZW - gap * (n - 1)) / n;
  const lineY = top + 0.62;
  slide.addShape("line", { x: ZX, y: lineY, w: ZW, h: 0, line: { color: LINE, width: 2 } });
  const maxItems = Math.max(...d.phases.map((p) => p.items.length), 1);
  // v5:卡片高度尊重主体区预算——旧版固定到 2.9,预算小的页直接压进支撑区(实测 P22 重叠 51%)。
  const cardH = Math.max(0.72, Math.min(2.6, 0.42 + maxItems * 0.44, h - 0.98));
  const cardTop = lineY + 0.34;
  const fs = cardH < 1.15 ? 12.5 : 14;
  d.phases.forEach((p, i) => {
    const x = ZX + i * (w + gap);
    slide.addText(clamp(p.name, 10), { x, y: top, w, h: 0.34, fontFace: FONT, fontSize: 15, bold: true, color: i === 0 ? ACCENT : PRIMARY, align: "center", margin: 0 });
    slide.addShape("ellipse", { x: x + w / 2 - 0.08, y: lineY - 0.08, w: 0.16, h: 0.16, fill: { color: i === 0 ? ACCENT : PRIMARY }, line: { color: i === 0 ? ACCENT : PRIMARY, width: 0 }, shadow: { type: "none" } });
    slide.addShape("roundRect", { x, y: cardTop, w, h: cardH, rectRadius: 0.06, fill: { color: SURFACE }, line: { color: SURFACE, width: 0 }, shadow: { type: "none" } });
    slide.addText(
      p.items.map((t, j) => ({ text: clamp(t, 30), options: { bullet: { characterCode: "2013", indent: 12 }, breakLine: j < p.items.length - 1 } })),
      { x: x + 0.2, y: cardTop + 0.14, w: w - 0.4, h: cardH - 0.28, fontFace: FONT, fontSize: fs, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.22 },
    );
  });
  return cardTop + cardH;
}

function renderCode(slide, s, top, h) {
  const c = s.code;
  slide.addText(c.source, { x: ZX, y: top, w: ZW, h: 0.28, fontFace: FONT, fontSize: 12, color: PRIMARY, margin: 0 });
  const boxY = top + 0.34;
  const boxH = Math.min(h - 0.34, 0.28 + c.lines.length * 0.27);
  slide.addShape("roundRect", { x: ZX, y: boxY, w: ZW, h: boxH, rectRadius: 0.05, fill: { color: CODE_BG }, line: { color: LINE, width: 0.75 }, shadow: { type: "none" } });
  const lineH = Math.min(0.27, (boxH - 0.2) / Math.max(1, c.lines.length));
  const fs = lineH >= 0.26 ? 13 : 12;
  // 保留行首缩进:pptxgenjs/渲染器会折叠连续普通空格,用 NBSP 固定控制流层级。
  const codeLine = (l) => l.replace(/^ +/, (m) => "\u00A0".repeat(m.length));
  slide.addText(
    c.lines.map((l, i) => ({ text: l.length ? codeLine(l) : " ", options: { breakLine: i < c.lines.length - 1 } })),
    { x: ZX + 0.22, y: boxY + 0.1, w: ZW - 0.44, h: boxH - 0.2, fontFace: "Courier New", fontSize: fs, color: CODE_TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.05 },
  );
  return boxY + boxH;
}

/** v8 卡片网格(workbuddy 对齐):N 张圆角卡横排,每张「彩色标题条 + 说明 + 子项」。
 *  这是 workbuddy 最常用的版式——五条不变量、三件事、四个机制全用它。 */
function renderCards(slide, s, top, h) {
  const cards = s.cards.cards;
  const n = cards.length;
  const gap = 0.2;
  const w = (ZW - gap * (n - 1)) / n;
  // v13(全稿普查):卡高随内容收缩——固定满槽在「一句说明+两条目」时空置三四成,成片留白
  const needOf = (c) => 0.38 + 0.08 + (c.desc ? 0.55 : 0) + (c.subs && c.subs.length ? Math.min(c.subs.length, 4) * 0.34 + 0.08 : 0) + 0.1;
  const cardH = Math.max(1.1, Math.min(h, 2.6, ...cards.map(needOf)));
  cards.forEach((c, i) => {
    const x = ZX + i * (w + gap);
    // 外框
    slide.addShape("roundRect", { x, y: top, w, h: cardH, rectRadius: 0.06, fill: { color: SURFACE }, line: { color: LINE, width: 1 }, shadow: { type: "none" } });
    // 标题条(彩色底)
    const headH = 0.38;
    slide.addShape("roundRect", { x, y: top, w, h: headH, rectRadius: 0.06, fill: { color: PRIMARY }, line: { color: PRIMARY, width: 0 }, shadow: { type: "none" } });
    slide.addText(clamp(c.title, 20), { x: x + 0.12, y: top + 0.03, w: w - 0.24, h: headH - 0.06, fontFace: FONT, fontSize: 14, bold: true, color: BG, margin: 0, valign: "middle" });
    // 说明
    let y = top + headH + 0.08;
    if (c.desc) {
      slide.addText(clamp(c.desc, 60), { x: x + 0.12, y, w: w - 0.24, h: 0.5, fontFace: FONT, fontSize: 12.5, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.15 });
      y += 0.55;
    }
    // 子项(圆点)
    if (c.subs && c.subs.length) {
      const subH = Math.min(cardH - (y - top) - 0.1, c.subs.length * 0.34);
      const step = Math.min(0.34, subH / c.subs.length);
      const fs = step >= 0.3 ? 11.5 : 10.5;
      slide.addText(
        c.subs.map((t, j) => ({ text: clamp(t, 30), options: { bullet: { characterCode: "2013", indent: 8 }, breakLine: j < c.subs.length - 1 } })),
        { x: x + 0.12, y, w: w - 0.24, h: subH, fontFace: FONT, fontSize: fs, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.15 },
      );
    }
  });
  return top + cardH;
}

/** v8 伪代码块:讲算法逻辑,不要 file:line 来源(与 code 摘录区分)。 */
function renderPseudo(slide, s, top, h) {
  const lines = s.pseudo.lines;
  const boxH = Math.min(h, 0.24 + lines.length * 0.26);
  slide.addShape("roundRect", { x: ZX, y: top, w: ZW, h: boxH, rectRadius: 0.05, fill: { color: CODE_BG }, line: { color: SURFACE_2, width: 0.75 }, shadow: { type: "none" } });
  const lineH = Math.min(0.26, (boxH - 0.16) / Math.max(1, lines.length));
  const fs = lineH >= 0.25 ? 12.5 : 11.5;
  const codeLine = (l) => l.replace(/^ +/, (m) => "\u00A0".repeat(m.length));
  slide.addText(
    lines.map((l, i) => ({ text: l.length ? codeLine(l) : " ", options: { breakLine: i < lines.length - 1 } })),
    { x: ZX + 0.2, y: top + 0.08, w: ZW - 0.4, h: boxH - 0.16, fontFace: "Courier New", fontSize: fs, color: CODE_TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.05 },
  );
  return top + boxH;
}

/** 支撑区行高估算:一行 ≈56 个汉字宽(14.5pt × 12.1in),短行单行、长行两行;
 *  估高与实际绘制同源,主体区才知道自己真正有多少预算。 */
function readingRowH(b) {
  const len = [...(b.lead || "")].length + [...(b.text || "")].length + 2;
  const lines = len > 56 ? 2 : 1;
  return 0.14 + lines * 0.34;
}
function estimateReadingH(bullets) {
  if (!bullets || !bullets.length) return 0;
  return Math.min(2.1, bullets.reduce((n, b) => n + readingRowH(b), 0));
}

/** 支撑区(v5):锚定脚注上方,每条「主色粗体小标题 + 说明」,行间细分隔线;
 *  区顶再画一条收口细线——主体与支撑之间的空隙从「没排完的洞」变成「有意的分节」。
 *  旧版是无锚点的裸文本行,被点评「像文档段落贴进 PPT」。 */
function renderReading(slide, bullets, y, h) {
  slide.addShape("line", { x: ZX, y: y - 0.14, w: ZW, h: 0, line: { color: LINE, width: 0.75 } });
  let ry = y;
  bullets.forEach((b, i) => {
    const rowH = Math.min(readingRowH(b), y + h - ry);
    if (b.lead) {
      slide.addText([
        { text: b.lead, options: { bold: true, color: PRIMARY } },
        { text: "　" + b.text, options: { color: TEXT } },
      ], { x: ZX, y: ry, w: ZW, h: rowH - 0.06, fontFace: FONT, fontSize: 14.5, margin: 0, valign: "top", lineSpacingMultiple: 1.2 });
    } else {
      slide.addText(b.text, { x: ZX, y: ry, w: ZW, h: rowH - 0.06, fontFace: FONT, fontSize: 14.5, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.2 });
    }
    ry += rowH;
    if (i < bullets.length - 1) {
      slide.addShape("line", { x: ZX, y: ry - 0.04, w: ZW, h: 0, line: { color: LINE, width: 0.5 } });
    }
  });
}

/** 定义带(v7 就地拆解):自造词第一次出现的那页,定义就贴在标题下——解释跟内容走,不丢给附录。 */
function renderDefinitions(slide, defs, y) {
  if (!defs || !defs.length) return 0;
  const h = defs.length * 0.34 + 0.12;
  slide.addShape("roundRect", { x: M, y, w: W - 2 * M, h, rectRadius: 0.04, fill: { color: SURFACE }, line: { color: LINE, width: 0.75 }, shadow: { type: "none" } });
  defs.forEach((d, i) => {
    slide.addText([
      { text: d.term, options: { bold: true, color: PRIMARY } },
      { text: "　" + clamp(d.def, 64), options: { color: TEXT } },
    ], { x: M + 0.2, y: y + 0.05 + i * 0.34, w: W - 2 * M - 0.4, h: 0.32, fontFace: FONT, fontSize: 13.5, margin: 0, valign: "middle" });
  });
  return h;
}

/** v12 大字结论:结论带升格为本页唯一视觉焦点(23pt 大字 + 大底框),标题退后——
 *  关键洞察页读者第一眼看到的是那句判断,不是版式零件(ZCode SKILL §3 single-statement emphasis)。 */
function renderFocusHero(slide, s, y) {
  const h = 1.5;
  slide.addShape("roundRect", { x: M, y, w: W - 2 * M, h, rectRadius: 0.06, fill: { color: SURFACE_2 }, line: { color: SURFACE_2, width: 0 }, shadow: { type: "none" } });
  slide.addText("结论", { x: M + 0.3, y: y + 0.12, w: 0.8, h: 0.3, fontFace: FONT, fontSize: 12.5, bold: true, color: ACCENT, margin: 0 });
  slide.addText(clamp(s.takeaway || "", 42), { x: M + 0.3, y: y + 0.42, w: W - 2 * M - 0.6, h: h - 0.52, fontFace: FONT, fontSize: 23, bold: true, color: PRIMARY, margin: 0, valign: "top", lineSpacingMultiple: 1.15 });
  return y + h;
}

/** v12 窄幅步骤竖排:编号行(圆号+名+人话职责,细线分隔)——左右布局的半幅里横向格子放不下。 */
function renderStepsRows(slide, s, top, h) {
  const items = s.steps;
  const n = items.length;
  const rowH = Math.min(1.0, Math.max(0.5, (h - 0.08) / n));
  const labelW = Math.min(2.3, ZW * 0.34);
  items.forEach((it, i) => {
    const y = top + i * rowH;
    if (i > 0) slide.addShape("line", { x: ZX, y: y - 0.02, w: ZW, h: 0, line: { color: LINE, width: 0.75 } });
    slide.addShape("ellipse", { x: ZX + 0.02, y: y + 0.05, w: 0.32, h: 0.32, fill: { color: i === 0 ? ACCENT : SURFACE }, line: { color: i === 0 ? ACCENT : LINE, width: 1 }, shadow: { type: "none" } });
    slide.addText(String(i + 1), { x: ZX + 0.02, y: y + 0.07, w: 0.32, h: 0.27, fontFace: FONT, fontSize: 11, bold: true, color: i === 0 ? BG : PRIMARY, align: "center", margin: 0 });
    slide.addText(clamp(it.label, 16), { x: ZX + 0.44, y: y + 0.02, w: labelW, h: rowH - 0.06, fontFace: FONT, fontSize: 14, bold: true, color: TEXT, margin: 0, valign: "top" });
    if (it.detail) {
      slide.addText(clamp(it.detail, 60), { x: ZX + 0.56 + labelW, y: y + 0.03, w: Math.max(1.2, ZW - 0.56 - labelW), h: rowH - 0.06, fontFace: FONT, fontSize: 11.5, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.1 });
    }
  });
  return top + n * rowH;
}

/** v12 侧栏要点卡:左右布局的读区——浅底圆角卡 + 编号行(小标题粗体+说明),要点不再永远沉底。 */
function renderSideReading(slide, bullets, x, w, top, h) {
  if (!bullets || !bullets.length) return;
  slide.addShape("roundRect", { x, y: top, w, h, rectRadius: 0.08, fill: { color: SURFACE_2 }, line: { color: SURFACE_2, width: 0 }, shadow: { type: "none" } });
  const n = bullets.length;
  const padT = 0.18;
  const rowH = Math.min(1.5, (h - padT * 2) / n);
  bullets.forEach((b, i) => {
    const y = top + padT + i * rowH;
    slide.addText(String(i + 1), { x: x + 0.18, y: y + 0.02, w: 0.3, h: 0.3, fontFace: FONT, fontSize: 13, bold: true, color: ACCENT, margin: 0 });
    if (b.lead) slide.addText(clamp(b.lead, 24), { x: x + 0.52, y, w: w - 0.72, h: 0.36, fontFace: FONT, fontSize: 14, bold: true, color: TEXT, margin: 0 });
    slide.addText(clamp(b.text, 120), { x: x + 0.52, y: y + (b.lead ? 0.38 : 0.02), w: w - 0.72, h: rowH - (b.lead ? 0.42 : 0.08), fontFace: FONT, fontSize: 12, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.15 });
  });
}

/** v12 左右布局:主版式块占一侧(58%),要点做成侧栏卡占另一侧——打破「标题-图-要点」
 *  永远纵向三段的单调;对比页/机制页交替用 左图右文/右图左文(ZCode SKILL §3 side-by-side)。 */
function renderSplit(slide, s, top, bottomLimit, reversed, center) {
  const gap = 0.28;
  const totalW = W - 2 * M;
  const visW = totalW * 0.585 - gap / 2;
  const sideW = totalW - visW - gap;
  const visX = reversed ? M + sideW + gap : M;
  const sideX = reversed ? M : M + visW + gap;
  const h = bottomLimit - top;
  setZone(visX, visW);
  let bottom = top;
  if (s.layout === "steps") {
    bottom = renderStepsRows(slide, s, top, h);
  } else if (s.layout === "code") {
    const actual = Math.min(h, 0.72 + s.code.lines.length * 0.27);
    bottom = renderCode(slide, s, center(actual), h);
  } else if (s.layout === "cards") {
    bottom = renderCards(slide, s, center(2.4), 2.4);
  } else if (s.layout === "pseudo") {
    bottom = renderPseudo(slide, s, center(Math.min(h, 0.24 + s.pseudo.lines.length * 0.26)), h);
  } else if (s.layout === "table") {
    bottom = renderTable(slide, s, top, h);
  } else if (s.layout === "visual") {
    const d = s.visual;
    if (d.type === "layers") bottom = renderLayers(slide, d, top, h);
    else if (d.type === "flow") bottom = renderFlow(slide, d, top, h);
    else if (d.type === "matrix") bottom = renderMatrix(slide, d, top, h);
    else bottom = renderTimeline(slide, d, top, h);
  } else {
    bottom = renderList(slide, s, top);
  }
  resetZone();
  renderSideReading(slide, s.bullets, sideX, sideW, top, h);
  return bottom;
}

function renderContent(pptx, s) {
  const slide = pptx.addSlide();
  const grid = pageHead(slide, s);
  // 有就地定义时,定义带贴在标题下、结论带随之下移——「是什么」先于「所以呢」
  const defH = renderDefinitions(slide, s.definitions, GRID.claimY + 0.32);
  const bandY = defH ? GRID.bandY + defH + 0.06 : GRID.bandY;
  // v12 版式引擎:大字结论页跳过普通结论带(结论升格为焦点),左右布局把要点挪进侧栏
  const layoutMode = String(s.pageLayout || "");
  const isFocus = layoutMode === "大字结论";
  const isSplit = layoutMode === "左图右文" || layoutMode === "右图左文";
  let top = defH ? grid.mainTop + defH + 0.06 : grid.mainTop;
  if (isFocus) top = renderFocusHero(slide, s, bandY) + 0.14;
  else renderTakeaway(slide, s, bandY);
  const bottomLimit = grid.footLimit;
  const nB = s.bullets.length;
  // 支撑区按实际行数估高,锚定脚注上方;主体区拿走剩余预算(左右布局的要点在侧栏,不占底部)。
  const readingH = nB && !isSplit ? estimateReadingH(s.bullets) : 0;
  const mainBudget = Math.max(1.2, bottomLimit - top - (readingH ? readingH + 0.16 : 0));
  // 固定高度版式(stats/quote/code)在预算内垂直居中;stats 偏上 0.4(数字区更高,压死区)
  const center = (actual, bias = 0.35) => top + Math.max(0, (mainBudget - actual) * bias);
  let bottom = top;
  if (isSplit) {
    bottom = renderSplit(slide, s, top, bottomLimit, layoutMode === "右图左文", center);
  } else if (s.layout === "code") {
    const actual = Math.min(mainBudget, 0.72 + s.code.lines.length * 0.27);
    bottom = renderCode(slide, s, center(actual), mainBudget);
  } else if (s.layout === "cards") {
    // v8 cards:主版式(可与其他副版式同页——见下方的"组合区")
    const cardN = s.cards.cards.length;
    const actual = Math.min(mainBudget, cardN <= 2 ? 2.4 : 2.0);
    bottom = renderCards(slide, s, center(actual), actual);
    // 组合区:cards 页允许再带一个 flow/pseudo(如因果链 + 伪代码)
    if (s.pseudo) {
      const pH = Math.min(bottomLimit - bottom - 0.14, 0.24 + s.pseudo.lines.length * 0.26);
      if (pH > 0.4) bottom = renderPseudo(slide, { pseudo: s.pseudo }, bottom + 0.1, pH);
    }
  } else if (s.layout === "pseudo") {
    bottom = renderPseudo(slide, s, center(Math.min(mainBudget, 0.24 + s.pseudo.lines.length * 0.26)), mainBudget);
  } else if (s.layout === "stats") {
    bottom = renderStats(slide, s, center(2.3, 0.4), Math.min(mainBudget, 2.3));
  } else if (s.layout === "steps") {
    if (s.steps.length >= 7) {
      // v11:两行回绕的全流程总览占满主体区(7~14 步一页走完)
      bottom = renderSteps(slide, s, top, mainBudget);
    } else {
      const hasDetail = s.steps.some((i) => i.detail);
      bottom = renderSteps(slide, s, center(hasDetail ? 2.3 : 1.3), mainBudget);
    }
  } else if (s.layout === "quote") {
    const actual = mainBudget >= 2.6 ? 2.95 : 2.4;
    bottom = renderQuote(slide, s, center(actual), mainBudget);
  } else if (s.layout === "visual") {
    const d = s.visual;
    if (d.type === "layers") bottom = renderLayers(slide, d, top, mainBudget);
    else if (d.type === "flow") bottom = renderFlow(slide, d, top, mainBudget);
    else if (d.type === "matrix") bottom = renderMatrix(slide, d, top, mainBudget);
    else bottom = renderTimeline(slide, d, top, mainBudget);
    // v8 组合区:visual 页可再带 cards(因果链 + 条件映射是 workbuddy 的常见组合)
    if (s.cards) {
      const cH = Math.min(bottomLimit - bottom - 0.14, 2.0);
      if (cH > 0.8) bottom = renderCards(slide, { cards: s.cards }, bottom + 0.1, cH);
    }
    // v12:visual 页也可带 pseudo(伪代码 + 流程图同页;此前该组合被静默丢 pseudo)
    if (s.pseudo) {
      const pH = Math.min(bottomLimit - bottom - 0.14, 0.24 + s.pseudo.lines.length * 0.26);
      if (pH > 0.4) bottom = renderPseudo(slide, { pseudo: s.pseudo }, bottom + 0.1, pH);
    }
  } else if (s.layout === "table") {
    bottom = renderTable(slide, s, top, mainBudget);
  } else if (s.layout === "compare") {
    bottom = renderCompare(slide, s, top, mainBudget);
  } else {
    renderList(slide, s, top);
    bottom = bottomLimit;
  }
  // v13(全稿普查):要点带紧跟内容区(留 0.22),只有超出页底时才锚定 footLimit——固定贴底会在稀内容页留出整幅空带
  if (nB && !isSplit) renderReading(slide, s.bullets, Math.max(top, Math.min(bottomLimit - readingH, bottom + 0.22)), readingH);
  pageFoot(slide, s);
  return slide;
}

function renderCover(pptx, s) {
  const cover = pptx.addSlide();
  cover.background = { color: BG };
  cover.addText(s.kicker || "REPORT", { x: M, y: 0.9, w: 6, h: 0.34, fontFace: FONT, fontSize: 13, color: PRIMARY, charSpacing: 3, bold: true, margin: 0 });
  cover.addText(s.title, {
    x: M, y: 1.38, w: 8.8, h: 1.95, fontFace: FONT, fontSize: 50, bold: true, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.06,
  });
  if (s.subtitle) {
    cover.addText(s.subtitle, { x: M, y: 3.52, w: 8.4, h: 0.8, fontFace: FONT, fontSize: 19, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.25 });
  }
  if (s.spine) {
    cover.addText("主线 · " + s.spine, { x: M, y: 4.32, w: 8.6, h: 0.32, fontFace: FONT, fontSize: 14, bold: true, color: PRIMARY, margin: 0 });
  }
  if (s.verdict) {
    cover.addText("总评", { x: M, y: 4.62, w: 1.0, h: 0.28, fontFace: FONT, fontSize: 12, color: ACCENT, bold: true, margin: 0 });
    cover.addText(s.verdict, { x: M, y: 4.92, w: 8.2, h: 0.52, fontFace: FONT, fontSize: 28, bold: true, color: TEXT, margin: 0 });
    if (s.verdictNote) {
      cover.addText(s.verdictNote, { x: M, y: 5.46, w: 7.8, h: 0.5, fontFace: FONT, fontSize: 14, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.18 });
    }
  }
  cover.addText("目录", { x: 9.7, y: 1.42, w: 3.2, h: 0.3, fontFace: FONT, fontSize: 12, color: PRIMARY, charSpacing: 2, bold: true, margin: 0 });
  // v6:章数多时(如加了术语表章)自动收紧行距/字号,目录不再压到封面 meta 行(实测 12 章重叠 47%)
  const tocN = (s.toc || []).length;
  const tocStep = Math.min(0.44, (6.62 - 1.88) / Math.max(1, tocN));
  const tocFs = tocN > 11 ? 11.5 : 13;
  (s.toc || []).forEach((c, i) => {
    // v13(终审复发):目录窄列长标题折行末行单字悬挂——按长度自适应字号并留断行余量
    const tl = [...String(c.title || "")].length;
    const fs = tl > 13 ? 10.5 : tl > 10 ? 11.5 : tocFs;
    cover.addText(c.no, { x: 9.7, y: 1.88 + i * tocStep, w: 0.5, h: 0.3, fontFace: FONT, fontSize: fs, bold: true, color: ACCENT, margin: 0 });
    cover.addText(clamp(c.title, 14), { x: 10.22, y: 1.88 + i * tocStep, w: 2.6, h: 0.3, fontFace: FONT, fontSize: fs, color: TEXT, margin: 0, valign: "middle" });
  });
  if (s.meta) {
    cover.addText(s.meta, { x: M, y: 6.88, w: W - 2 * M, h: 0.3, fontFace: FONT, fontSize: 11.5, color: MUTED, margin: 0 });
  }
  // v9 构建思路落封面:不讲清单 + 数字三档纪律(workbuddy 同款 scope/信任声明)
  if (s.notCovering) {
    cover.addText("不讲 " + clamp(s.notCovering, 80), { x: M, y: 6.56, w: W - 2 * M, h: 0.26, fontFace: FONT, fontSize: 11.5, color: MUTED, margin: 0 });
  }
  if (s.dataPolicy) {
    cover.addText("口径 " + clamp(s.dataPolicy, 80), { x: M, y: 6.3, w: W - 2 * M, h: 0.26, fontFace: FONT, fontSize: 11.5, color: PRIMARY, margin: 0 });
  }
  return cover;
}

export function deckToPptx(deck, outPath) {
  applyTheme(deck?.theme);
  const plan = planDeck(deck);
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "W16x9", width: W, height: H });
  pptx.layout = "W16x9";
  pptx.author = "lampgenie-harness";
  pptx.title = deck.title || "评审文档";
  for (const s of plan) {
    if (s.kind === "cover") renderCover(pptx, s);
    else renderContent(pptx, s);
  }
  return pptx.writeFile({ fileName: outPath }).then(() => ({ file: outPath, slides: plan.length }));
}

/** 板骨架 → 待填源稿(agent 只填正文,不改结构)。 */
export function boardToDeckTemplate(doc) {
  const nodes = doc.nodes || [];
  const edges = doc.edges || [];
  const chapters = nodes.filter((n) => n.kind === "section");
  const order = new Map();
  chapters.forEach((c, i) => order.set(c.id, i));
  const pagesOf = new Map();
  for (const e of edges) {
    if ((e.kind || "") !== "contains") continue;
    const f = nodes.find((n) => n.id === e.from);
    const t = nodes.find((n) => n.id === e.to);
    if (f && t && f.kind === "section" && t.kind === "page") {
      if (!pagesOf.has(f.id)) pagesOf.set(f.id, []);
      pagesOf.get(f.id).push(t);
    }
  }
  const root = nodes.find((n) => n.kind === "aggregate");
  chapters.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  const out = [];
  out.push(`# ${cleanTitle(doc.title)}`);
  out.push(`subtitle: <!-- 一句话:给谁看、解决什么问题 -->`);
  out.push(`theme: editorial  <!-- editorial(浅色纸感) / technical(深色) / executive(藏青) / warm(暖纸) -->`);
  out.push(`kicker: REPORT  <!-- 封面眉标:REPORT / BRIEFING / REVIEW -->`);
  out.push(`spine: <!-- 全场主线,一句疑问句:这场汇报回答什么(8~80 字) -->`);
  if (root) {
    out.push(`verdict: ${humanize(root.label)}`);
    out.push(`verdict_note: ${humanize(root.summary)}`);
  } else {
    out.push(`verdict: <!-- 总评一句话 -->`);
    out.push(`verdict_note: <!-- 支撑这句总评的两三点依据 -->`);
  }
  out.push(`meta: <!-- 仓库@版本 · 评审日期 · 评审人 -->`);
  out.push("");
  out.push(`<!-- 每页六件套(缺一会被质量门拒):`);
  out.push(`     ⓪「术语与概念」章(成稿 ≥8 内容页必填,已给骨架在前两章位):自造词先定义再用,定义 10~60 字;`);
  out.push(`     ① 页标题 = 结论句(≤40 字);② \`> 结论:\` = 所以呢(8~42 字,≠标题);`);
  out.push(`     ③ 一种视觉版式 = 证据主体:架构 → 三反引号 layers(层名: 组件|组件);流程 → flow(id: 名 + a -> b: 条件);`);
  out.push(`        回边标签写条件语义(如 还需工具),禁「回边/循环」;风险 → matrix(高影响高概率: 条目|条目);`);
  out.push(`        计划 → timeline(阶段: 事项|事项);取舍 → compare(方案A: 项|项 / 方案B: 项|项);数字 → stats(数字|说明|来源,说明 ≤16 字/来源 ≤20 字);`);
  out.push(`     单句结论 → quote(一句话 + 一句补充 + 来源);④ 2–4 条支撑要点(每条 ≤64 字,全页 ≥75 字,定义/机制/数据/影响齐给);⑤ \`> 证据:\` 来源行。 -->`);
  // 术语表章骨架(2026-11-15 v6):先定义再用——模板阶段就占住前两章位,填完再导
  out.push("");
  out.push(`## 00 术语与概念`);
  out.push(`claim: <!-- 这些自造词先说清,正文首次出现不再就地解释 -->`);
  out.push("");
  out.push(`### 术语表:这套稿的黑话,一张表说清`);
  out.push(`| 术语 | 是什么 |`);
  out.push(`|---|---|`);
  out.push(`| <!-- 自造词(≤12 字) --> | <!-- 它是什么 + 一句类比/例子(10~60 字) --> |`);
  out.push(`| <!-- 自造词 --> | <!-- 同上;每页 ≤5 词条,词多拆页;收进表的词正文必须真用 --> |`);
  out.push(`| <!-- 业界通用词不收:API/缓存/token 等无需解释 --> | <!-- 删掉这行 --> |`);
  out.push(`- <!-- **先读这张表** — 正文首次出现这些词不再就地解释 -->`);
  out.push(`- <!-- **通用词不收** — 只收这套稿自造的词 -->`);
  out.push(`> 证据: <!-- 文件:行 -->`);
  out.push(`> 结论: <!-- 这张表覆盖全文的概念地基(8~42 字) -->`);
  chapters.forEach((ch, i) => {
    const no = numOf(ch.label) || String(i + 1).padStart(2, "0");
    out.push("");
    out.push(`## ${no} ${stripNo(ch.label)}`);
    out.push(`claim: <!-- 本章一句话结论(回答哪个子问题、结论朝哪个方向,8~80 字) -->`);
    const kids = pagesOf.get(ch.id) || [];
    if (!kids.length) {
      out.push("");
      out.push(`### <!-- 页标题:结论句,不是话题词 -->`);
      out.push(`> 结论: <!-- 所以呢:标题没说的那半句(8~42 字) -->`);
      out.push(`> 证据: <!-- 文件:行 -->`);
    }
    for (const pg of kids) {
      out.push("");
      out.push(`### ${stripNo(pg.label)}`);
      out.push(`<!-- 板上线索:${humanize(pg.summary)}`);
      out.push(`     选一种视觉版式改写(layers/flow/matrix/timeline/compare/stats/quote),必要时拆页 -->`);
      out.push(`> 结论: <!-- 所以呢:标题没说的那半句(8~42 字) -->`);
      out.push(`> 证据: <!-- 文件:行 -->`);
    }
  });
  out.push("");
  return out.join("\n");
}

/** composition 板(办公/产出类「作业思路板」)→ 汇报骨架源稿(2026-11-04)。
 *  与 docs 板(boardToDeckTemplate)的区别:板画的是表达结构(主题·受众·章节·章间关系),
 *  没有页节点与代码证据位——每章给一个「开篇」页,证据行换成可选「> 素材:」行;
 *  质量门对 genre: composition 走宽松档(不要求 `> 证据:`),结构门(纯文字页/TODO/解读深度)保留。
 *  章序:章间关系边(A→B 且 label 含关系词)即 A 前 B 后,按此拓扑排;无边章节按 nodes 提交序垫后。
 *  opts.relations=关系词表,由 TS 调用方传入(board-content-predicate.ts 的 COMPOSITION_RELATIONS,单一真源);
 *  缺省内置同表,改词表时两处同步。边的判定口径与 isCompositionStructure 一致(两端都是 section +
 *  label 含关系词,不另查 kind——手写板可能缺 kind 字段,判据分叉会让「判成 composition 的板排序错」)。
 */
export function boardToCompositionTemplate(doc, opts) {
  const relations = Array.isArray(opts && opts.relations) && opts.relations.length
    ? opts.relations.map((r) => String(r))
    : ["承接", "递进", "并列", "对照", "因果"]; // 同 board-content-predicate.ts COMPOSITION_RELATIONS
  const nodes = doc.nodes || [];
  const edges = doc.edges || [];
  const sections = nodes.filter((n) => n && String(n.kind || "") === "section");
  const relOf = (label) => {
    const l = String(label || "");
    return relations.find((r) => l.includes(r)) || "";
  };
  // 章间先后链:relEdges 收集两端都是 section、label 命中关系词的边
  const relEdges = [];
  for (const e of edges) {
    const rel = relOf(e.label);
    const f = sections.find((n) => n.id === e.from);
    const t = sections.find((n) => n.id === e.to);
    if (rel && f && t && f.id !== t.id) relEdges.push({ from: f, to: t, rel });
  }
  const inChain = new Set();
  for (const re of relEdges) {
    inChain.add(re.from.id);
    inChain.add(re.to.id);
  }
  const before = new Map(); // id -> 未落位的前驱集合
  for (const re of relEdges) {
    if (!before.has(re.to.id)) before.set(re.to.id, new Set());
    before.get(re.to.id).add(re.from.id);
  }
  // 链上章节拓扑排(同层按 nodes 提交序);无边章节垫后(提交序)
  const chain = sections.filter((s) => inChain.has(s.id));
  const rest = sections.filter((s) => !inChain.has(s.id));
  const ordered = [];
  const placed = new Set();
  const pending = chain.slice();
  let guard = 0;
  while (pending.length && guard++ < 1000) {
    const idx = pending.findIndex((s) => {
      const preds = before.get(s.id) || new Set();
      return ![...preds].some((p) => !placed.has(p));
    });
    // idx<0=环(如 A→B→A):按提交序兜底吐出一个,不死循环
    const pick = pending.splice(idx >= 0 ? idx : 0, 1)[0];
    ordered.push(pick);
    placed.add(pick.id);
  }
  ordered.push(...rest);
  const relBetween = (a, b) => {
    const hit = relEdges.find((re) => re.from.id === a.id && re.to.id === b.id)
      || relEdges.find((re) => re.from.id === b.id && re.to.id === a.id);
    return hit ? hit.rel : "";
  };
  const theme = nodes.find((n) => /主题/.test(String((n && n.label) || "")));
  const audience = nodes.find((n) => /受众|听众|读者/.test(String((n && n.label) || "")));
  const root = nodes.find((n) => n && String(n.kind || "") === "aggregate");
  const nos = ordered.map((s, i) => numOf(s.label) || String(i + 1).padStart(2, "0"));
  const out = [];
  out.push(`# ${cleanTitle(doc.title)}`);
  out.push(`subtitle: ${theme ? clamp(humanize(theme.summary || theme.label), 80) : "<!-- 一句话:给谁看、解决什么问题 -->"}`);
  out.push(`theme: editorial  <!-- editorial(浅色纸感) / technical(深色) / executive(藏青) / warm(暖纸) -->`);
  out.push(`kicker: BRIEFING  <!-- 封面眉标:BRIEFING / REPORT / REVIEW -->`);
  out.push(`spine: <!-- 全场主线,一句疑问句:这场汇报回答什么(8~80 字) -->`);
  out.push(`genre: composition`);
  if (root) {
    out.push(`verdict: ${humanize(root.label)}`);
    out.push(`verdict_note: ${humanize(root.summary)}`);
  } else {
    out.push(`verdict: <!-- 总评一句话(这份汇报的落点) -->`);
    out.push(`verdict_note: <!-- 支撑这句总评的两三点依据 -->`);
  }
  out.push(`meta: ${audience ? clamp(humanize(audience.summary || audience.label), 60) : "<!-- 受众/场合 · 日期 -->"}`);
  out.push("");
  out.push(`<!-- 办公/产出类汇报稿:素材来源写在「> 素材:」行,不要求 文件:行;其余质量门照常。`);
  out.push(`     每页六件套(缺一会被质量门拒):⓪ 自造词先定义(成稿 ≥8 内容页须有「术语与概念」章);`);
  out.push(`     ① 页标题 = 结论句(≤40 字);② \`> 结论:\` = 所以呢(8~42 字,≠标题);`);
  out.push(`     ③ 一种视觉版式 = 证据主体:`);
  out.push(`        架构 → 三反引号 layers(层名: 组件|组件);流程 → flow(id: 名 + a -> b: 条件语义标签,禁「回边/循环」);`);
  out.push(`        风险 → matrix(高影响高概率: 条目|条目);计划 → timeline(阶段: 事项|事项);`);
  out.push(`        取舍 → compare(方案A: 项|项 / 方案B: 项|项);数字 → stats(数字|说明|来源);`);
  out.push(`        单句结论 → quote(一句话 + 一句补充 + 来源);④ 2–3 条支撑要点(每条 ≤64 字);⑤ \`> 素材:\` 来源行。 -->`);
  const parts = [];
  ordered.forEach((s, i) => {
    const name = stripNo(s.label);
    if (i === 0) {
      parts.push(`${nos[i]} ${name}`);
      return;
    }
    const rel = relBetween(ordered[i - 1], s);
    parts.push(rel ? `--${rel}--> ${nos[i]} ${name}` : `${nos[i]} ${name}`);
  });
  out.push(`outline: ${parts.join(" ")}`);
  ordered.forEach((ch, i) => {
    const name = stripNo(ch.label);
    out.push("");
    out.push(`## ${nos[i]} ${name}`);
    out.push(`claim: <!-- 本章一句话结论(回答哪个子问题、结论朝哪个方向,8~80 字) -->`);
    out.push("");
    out.push(`### ${name} · 开篇`);
    out.push(`> 结论: <!-- 所以呢:标题没说的那半句(8~42 字) -->`);
    out.push(`- <!-- **小标题** — 一句话说明 -->`);
    out.push(`- <!-- **小标题** — 一句话说明 -->`);
    out.push(`> 素材: <!-- 数据/引用/案例来源(可选) -->`);
  });
  out.push("");
  return out.join("\n");
}
