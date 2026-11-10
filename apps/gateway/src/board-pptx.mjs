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
 * 管线:parseDeckMd → validateDeck → planDeck → deckToPptx。
 */
import pptxgen from "pptxgenjs";

const W = 13.33;
const H = 7.5;
const M = 0.6;
const FONT = "Microsoft YaHei";

const BG = "0E100F";
const SURFACE = "191C1A";
const SURFACE_2 = "222623";
const LINE = "333934";
const TEXT = "EDEAE2";
const MUTED = "9AA39B";
const PRIMARY = "8FAE9B";
const ACCENT = "E2A052";
const DANGER = "C2603C";

/** 内部流程术语:出现在 deck 源稿=把规划指令当正文。 */
const INTERNAL_JARGON = /回答维度|逐章扩页|骨架版|终版|规划稿|本页要|待补充|TODO|TBD|占位/;
const JUNK_TITLE = /骨架|逐章|扩页|终版|草稿|模板|PPT ?骨架|draft|v\d+\s*$/i;

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
      const nm = /^([\w\u4e00-\u9fa5.-]{1,24})\s*[:：]\s*(.{1,40})$/.exec(l);
      if (nm && !byId.has(nm[1])) {
        const n = { id: nm[1], label: nm[2].trim() };
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
 *   # 标题 / subtitle: / genre: / verdict: / verdict_note: / meta:
 *   ## 01 章 (claim:) / ### 页
 *   正文:`- **小标题** — 说明`、`| 表格 |`、```steps/layers/flow/matrix/timeline/compare/stats/quote
 *   `> 证据: 文件:行` / `> 结论: 一句话`
 */
export function parseDeckMd(md) {
  const lines = String(md ?? "").split(/\r?\n/);
  const deck = { title: "", subtitle: "", genre: "", verdict: "", verdictNote: "", meta: "", chapters: [], todos: 0, unknownBlocks: [] };
  let chapter = null;
  let page = null;
  let fence = null;
  let table = null;
  const FENCE_KINDS = new Set(["steps", "layers", "flow", "matrix", "timeline", "compare", "stats", "quote", "code"]);
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
      // fail-closed(2026-11-05,演示产线质量门口径:未知=error,不静默降级):
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
      page = { title: stripNo(line.replace(/^###\s+/, "").trim()), blocks: [], evidence: "", takeaway: "" };
      chapter.pages.push(page);
      continue;
    }
    const meta = /^(subtitle|verdict_note|verdict|meta|claim|genre)\s*[:：]\s*(.*)$/i.exec(line);
    if (meta) {
      const key = meta[1].toLowerCase();
      const val = meta[2].trim();
      if (key === "claim") {
        if (chapter) chapter.claim = val;
      } else if (key === "subtitle") deck.subtitle = val;
      else if (key === "genre") deck.genre = val;
      else if (key === "verdict") deck.verdict = val;
      else if (key === "verdict_note") deck.verdictNote = val;
      else if (key === "meta") deck.meta = val;
      continue;
    }
    if (/^>\s*/.test(line)) {
      if (!page) continue;
      const t = line.replace(/^>\s*/, "").trim();
      if (/^证据\s*[:：]/.test(t)) page.evidence = t.replace(/^证据\s*[:：]\s*/, "");
      else if (/^结论\s*[:：]/.test(t)) page.takeaway = t.replace(/^结论\s*[:：]\s*/, "");
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
  // fail-closed:未登记的版式块 = 这张图不会被画出来,以前静默丢弃(见 parseDeckMd)。
  const unknownKinds = deck.unknownBlocks || [];
  if (unknownKinds.length) {
    const names = [...new Set(unknownKinds.map((b) => b.kind))].join("/");
    add("版式", `${unknownKinds.length} 个未登记版式块(${names}):导出器不认识它,内容不会被画出来——改用 §四 版式目录里的名字`);
  }
  if (deck.chapters.length < 2) add("全文", "至少 2 章才成文档");
  for (const ch of deck.chapters) {
    if (!ch.title) add(`第 ${ch.no} 章`, "章标题为空");
    if (!ch.pages.length) add(`${ch.no} ${ch.title}`, "本章没有页(`### 页标题`)");
    ch.pages.forEach((pg, idx) => {
      const at = `${ch.no}.${idx + 1} ${pg.title || "(空页标题)"}`;
      if (!pg.title) add(at, "页标题为空");
      else if (pg.title.length > 40) add(at, `页标题 ${pg.title.length} 字,超过 40`);

      const bullets = pg.blocks.filter((b) => b.kind === "bullets").flatMap((b) => b.items);
      const tables = pg.blocks.filter((b) => b.kind === "table");
      const steps = pg.blocks.filter((b) => b.kind === "steps");
      const visuals = pg.blocks.filter((b) => ["layers", "flow", "matrix", "timeline"].includes(b.kind));
      const compares = pg.blocks.filter((b) => b.kind === "compare");
      const stats = pg.blocks.filter((b) => b.kind === "stats");
      const quotes = pg.blocks.filter((b) => b.kind === "quote");

      const codeBlocks = pg.blocks.filter((b) => b.kind === "code");
      // ZCode 规范:不许纯文字页——每页至少一种视觉版式
      const mains = visuals.length + tables.length + steps.length + compares.length + stats.length + quotes.length + codeBlocks.length;
      if (mains === 0) add(at, "纯文字页:每页至少配图/代码摘录/表格/对比栏/大数字/引言之一");
      if (visuals.length > 1) add(at, "一页最多 1 张图");
      if (mains > 1) add(at, "同页混排多种主版式:一页只留一种");
      // 每页深度(2026-10-27 用户口径「每一页的内容质量很差」):只有图没有解读的页=看不懂的图。
      // 每页 2–3 条解读(机制为什么/影响谁),引言页 2 条;总字数 ≥60,否则退回"标题+图"的骨架页。
      const minB = quotes.length ? 2 : 2;
      if (bullets.length < minB) add(at, `解读只有 ${bullets.length} 条:每页要 2–3 条「机制/实证/影响」解读,不能只放图`);
      if (bullets.length > 3) add(at, `解读 ${bullets.length} 条过多(≤3)`);
      const fixedZone = stats.length || compares.length;
      if (fixedZone && bullets.length > 2) add(at, "大数字/对比栏版面固定,解读限 2 条(第 3 条拆到下一页)");
      const totalChars = bullets.reduce((n, b) => n + b.lead.length + b.text.length, 0);
      if (bullets.length >= minB && totalChars < 60) add(at, `解读总字数 ${totalChars}<60:每条要讲清因果,不是名词短语`);
      for (const b of bullets) {
        if (!b.text && !b.lead) add(at, "空要点");
        else if (b.lead.length > 24) add(at, `小标题「${b.lead.slice(0, 12)}…」超 24 字`);
        else if (!b.lead && b.text.length < 6) add(at, `要点「${b.text}」过短`);
        else if (b.lead && b.text.length < 4) add(at, `要点「${b.lead}」缺说明`);
        else if (b.text.length > 110) add(at, `解读 ${b.text.length} 字超 110(两行上限;再长拆两条)`);
        if (INTERNAL_JARGON.test(b.lead + b.text)) add(at, `要点含内部术语/占位词:「${clamp(b.lead || b.text, 16)}」`);
      }
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
      }
      if (quotes.length && quotes[0].data.statement.length > 36) add(at, "引言结论超 36 字(要一句话)");
      // composition(办公/产出)档:证据行不强制(模板给可选「> 素材:」行,解析层本就不计入 evidence);
      // 其余门(纯文字页/TODO 残留/每页 2–3 条解读/内部术语/总字数)照常——宽松≠放水。
      if (!pg.evidence && String(deck.genre || "") !== "composition") add(at, "缺 `> 证据:` 行");
    });
  }
  return issues;
}

/** 版式计划:封面 + 内容页;章名进页眉,章 claim 只做本章首屏导语。 */
export function planDeck(deck) {
  const plan = [];
  const chapters = deck.chapters.map((c, i) => ({ ...c, no: c.no || String(i + 1).padStart(2, "0") }));
  plan.push({
    kind: "cover",
    title: cleanTitle(deck.title),
    subtitle: deck.subtitle,
    verdict: humanize(deck.verdict),
    verdictNote: deck.verdictNote,
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
      const layout = codeB ? "code" : visual ? "visual" : compare ? "compare" : stats ? "stats" : quote ? "quote" : table ? "table" : steps ? "steps" : "list";
      plan.push({
        kind: "content",
        chapterNo: ch.no,
        chapterTitle: ch.title,
        kicker: i === 0 ? humanize(ch.claim) : "",
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
        bullets: pg.blocks.filter((b) => b.kind === "bullets").flatMap((b) => b.items),
        takeaway: pg.takeaway,
        evidence: pg.evidence,
      });
    });
  }
  return plan.map((s, i) => ({ ...s, pageIndex: i + 1, total: plan.length }));
}

// ---------------------------------------------------------------- 渲染

/** 页眉:章名 + 标题(不画装饰线/色条,规范点名 AI 稿特征);返回正文起始 y。 */
function pageHead(slide, s) {
  slide.background = { color: BG };
  slide.addText(`${s.chapterNo} / ${s.chapterTitle}`, {
    x: M, y: 0.42, w: 8, h: 0.3, fontFace: FONT, fontSize: 13, color: PRIMARY, charSpacing: 0.5, margin: 0,
  });
  slide.addText(s.title, {
    x: M, y: 0.78, w: W - 2 * M, h: 0.8, fontFace: FONT, fontSize: 32, bold: true, color: TEXT, margin: 0, valign: "top",
  });
  let top = 1.86;
  if (s.kicker) {
    slide.addText(s.kicker, {
      x: M, y: 1.5, w: W - 2 * M, h: 0.62, fontFace: FONT, fontSize: 16, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.15,
    });
    top = 2.28;
  }
  return top;
}

function pageFoot(slide, s) {
  if (s.evidence) {
    slide.addText("证据 · " + s.evidence, {
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
  const bottom = s.takeaway ? 5.9 : 6.55;
  const avail = bottom - top;
  const rowH = Math.min(1.32, avail / Math.max(1, n));
  const lead = n >= 5 ? 18 : 20;
  const detail = n >= 5 ? 16 : 17;
  bs.forEach((b, i) => {
    const y = top + i * rowH;
    slide.addText(String(i + 1).padStart(2, "0"), {
      x: M, y: y + 0.06, w: 0.62, h: 0.32, fontFace: FONT, fontSize: 14, bold: true, color: PRIMARY, margin: 0,
    });
    if (b.lead) {
      slide.addText(b.lead, { x: M + 0.64, y, w: W - 2 * M - 0.64, h: 0.42, fontFace: FONT, fontSize: lead, bold: true, color: TEXT, margin: 0 });
      slide.addText(b.text, {
        x: M + 0.64, y: y + 0.44, w: W - 2 * M - 0.64, h: rowH - 0.52, fontFace: FONT, fontSize: detail, color: MUTED, margin: 0, valign: "top",
      });
    } else {
      slide.addText(b.text, { x: M + 0.64, y, w: W - 2 * M - 0.64, h: rowH - 0.1, fontFace: FONT, fontSize: lead, color: TEXT, margin: 0 });
    }
    if (i < n - 1) {
      slide.addShape("line", { x: M + 0.64, y: y + rowH - 0.08, w: W - 2 * M - 0.64, h: 0, line: { color: LINE, width: 0.75 } });
    }
  });
}

/** 结论:淡色底带(不画色条)。 */
function renderNote(slide, s, y) {
  if (!s.takeaway) return;
  slide.addShape("rect", { x: M, y, w: W - 2 * M, h: 0.72, fill: { color: SURFACE }, line: { color: SURFACE, width: 0 } });
  slide.addText("结论", { x: M + 0.2, y: y + 0.22, w: 0.6, h: 0.28, fontFace: FONT, fontSize: 12, color: PRIMARY, margin: 0 });
  slide.addText(s.takeaway, { x: M + 0.9, y: y + 0.1, w: W - 2 * M - 1.1, h: 0.52, fontFace: FONT, fontSize: 16, color: TEXT, margin: 0, valign: "middle" });
}

function renderTable(slide, s, top, h) {
  const t = s.table;
  const cols = t.headers.length;
  const colW = Array.from({ length: cols }, () => (W - 2 * M) / cols);
  const rowH = Math.min(0.72, Math.max(0.4, (h - 0.46) / Math.max(1, t.rows.length)));
  const rows = [
    t.headers.map((hd) => ({ text: hd, options: { bold: true, color: PRIMARY, fontSize: 14, fill: { color: BG } } })),
    ...t.rows.map((r, ri) =>
      r.map((c) => ({ text: c, options: { color: TEXT, fontSize: 13.5, fill: { color: ri % 2 === 0 ? BG : SURFACE } } })),
    ),
  ];
  slide.addTable(rows, {
    x: M, y: top, w: W - 2 * M, colW,
    border: { type: "solid", color: LINE, pt: 0.75 },
    margin: 0.08, valign: "middle", autoPage: false,
    rowH: [0.46, ...t.rows.map(() => rowH)],
  });
  return top + 0.46 + t.rows.length * rowH;
}

function renderSteps(slide, s, top) {
  const items = s.steps;
  const n = items.length;
  const gap = 0.24;
  const w = (W - 2 * M - gap * (n - 1)) / n;
  const boxY = top + 0.1;
  const boxH = 1.02;
  items.forEach((it, i) => {
    const x = M + i * (w + gap);
    slide.addShape("roundRect", { x, y: boxY, w, h: boxH, rectRadius: 0.06, fill: { color: SURFACE }, line: { color: SURFACE, width: 0 } });
    slide.addText(String(i + 1).padStart(2, "0"), { x: x + 0.16, y: boxY + 0.12, w: 0.5, h: 0.26, fontFace: FONT, fontSize: 12, bold: true, color: PRIMARY, margin: 0 });
    slide.addText(clamp(it.label, 14), { x: x + 0.16, y: boxY + 0.42, w: w - 0.3, h: 0.44, fontFace: FONT, fontSize: 15, bold: true, color: TEXT, margin: 0, valign: "top" });
    if (it.detail) {
      slide.addText(clamp(it.detail, 42), { x: x + 0.16, y: boxY + boxH + 0.16, w: w - 0.24, h: 0.9, fontFace: FONT, fontSize: 13, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.2 });
    }
    if (i < n - 1) {
      slide.addShape("line", { x: x + w + 0.03, y: boxY + boxH / 2, w: gap - 0.06, h: 0, line: { color: MUTED, width: 1.5, endArrowType: "triangle" } });
    }
  });
  return boxY + boxH + (items.some((i) => i.detail) ? 1.05 : 0);
}

function renderCompare(slide, s, top, h) {
  const cols = s.compare.cols;
  const n = cols.length;
  const gap = 0.3;
  const w = (W - 2 * M - gap * (n - 1)) / n;
  const maxItems = Math.max(...cols.map((c) => c.items.length), 1);
  h = Math.min(h, 1.1 + maxItems * 0.78);
  cols.forEach((c, i) => {
    const x = M + i * (w + gap);
    slide.addShape("roundRect", { x, y: top, w, h, rectRadius: 0.08, fill: { color: SURFACE }, line: { color: SURFACE, width: 0 } });
    slide.addText(c.name, { x: x + 0.24, y: top + 0.2, w: w - 0.48, h: 0.42, fontFace: FONT, fontSize: 18, bold: true, color: PRIMARY, margin: 0 });
    const step = Math.min(0.78, (h - 0.78) / Math.max(1, c.items.length));
    const fs2 = step >= 0.6 ? 18 : 15;
    c.items.forEach((it, j) => {
      slide.addText([
        { text: it, options: { bullet: { characterCode: "2013", indent: 12 }, color: TEXT } },
      ], {
        x: x + 0.24, y: top + 0.78 + j * step, w: w - 0.48, h: step - 0.04,
        fontFace: FONT, fontSize: fs2, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.15,
      });
    });
  });
  return top + h;
}

function renderStats(slide, s, top, h) {
  const st = s.stats.stats;
  // 高度由调用方预算给定(下方还有解读区),不得超出——实测 4 个大数字 + 3 条解读时溢出压字
  const blockH = Math.min(h, 2.3);
  const n = st.length;
  const gap = 0.3;
  const w = (W - 2 * M - gap * (n - 1)) / n;
  st.forEach((it, i) => {
    const x = M + i * (w + gap);
    slide.addText(it.value, {
      x, y: top + 0.18, w, h: 0.82, fontFace: FONT, fontSize: 46, bold: true,
      color: i === 0 ? ACCENT : TEXT, margin: 0, valign: "bottom",
    });
    slide.addText(it.label, { x, y: top + 1.06, w: w - 0.12, h: 0.42, fontFace: FONT, fontSize: 15, color: TEXT, margin: 0, valign: "top" });
    if (it.source) {
      slide.addText(it.source, { x, y: top + 1.5, w: w - 0.12, h: 0.42, fontFace: FONT, fontSize: 11.5, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.1 });
    }
  });
  return top + blockH;
}

function renderQuote(slide, s, top) {
  const q = s.quote;
  slide.addText(q.statement, {
    x: M, y: top + 0.35, w: W - 2 * M - 1.4, h: 1.3, fontFace: FONT, fontSize: 36, bold: true, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.15,
  });
  if (q.note) {
    slide.addText(q.note, { x: M, y: top + 1.8, w: W - 2 * M - 1.3, h: 0.95, fontFace: FONT, fontSize: 18, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.25 });
  }
  return top + 2.95;
}

function renderLayers(slide, d, top, h) {
  const n = d.bands.length;
  const gap = 0.18;
  const bandH = (h - gap * (n - 1)) / n;
  const labelW = 1.7;
  d.bands.forEach((b, i) => {
    const y = top + i * (bandH + gap);
    slide.addShape("roundRect", { x: M, y, w: W - 2 * M, h: bandH, rectRadius: 0.06, fill: { color: SURFACE }, line: { color: SURFACE, width: 0 } });
    slide.addText(b.name, { x: M + 0.24, y, w: labelW - 0.32, h: bandH, fontFace: FONT, fontSize: 15, bold: true, color: PRIMARY, margin: 0, valign: "middle" });
    const k = b.boxes.length;
    const areaW = W - 2 * M - labelW - 0.24;
    const bgap = 0.14;
    const bw = (areaW - bgap * (k - 1)) / k;
    b.boxes.forEach((t, j) => {
      const x = M + labelW + j * (bw + bgap);
      slide.addShape("roundRect", { x, y: y + 0.12, w: bw, h: bandH - 0.24, rectRadius: 0.05, fill: { color: SURFACE_2 }, line: { color: SURFACE_2, width: 0 } });
      slide.addText(clamp(t, 20), { x: x + 0.1, y: y + 0.12, w: bw - 0.2, h: bandH - 0.24, fontFace: FONT, fontSize: 14, color: TEXT, align: "center", valign: "middle", margin: 0 });
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
  const nodeW = Math.min(2.45, (W - 2 * M - gapX * (cols - 1)) / cols);
  const stepX = cols > 1 ? (W - 2 * M - nodeW) / (cols - 1) : 0;
  const byCol = new Map();
  for (const n of d.nodes) {
    const r = rank.get(n.id) ?? 0;
    if (!byCol.has(r)) byCol.set(r, []);
    byCol.get(r).push(n);
  }
  const maxRows = Math.max(...[...byCol.values()].map((l) => l.length), 1);
  // 行数多时压节点高与行距,保证整张图落在给定高度内(实测:固定 0.92 会压到下方要点)
  const vgap = maxRows >= 3 ? 0.22 : 0.4;
  const nodeH = Math.min(0.92, Math.max(0.6, (h - 0.24 - vgap * (maxRows - 1)) / maxRows));
  const pos = new Map();
  for (const [r, list] of byCol) {
    const total = list.length * nodeH + (list.length - 1) * vgap;
    const startY = top + 0.12 + Math.max(0, (h - 0.24 - total) / 2);
    list.forEach((n, i) => pos.set(n.id, { x: M + r * stepX, y: startY + i * (nodeH + vgap), r }));
  }
  const out = (id) => d.edges.filter((e) => e.from === id);
  const labels = [];
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
    } else {
      const laneY = top + h - 0.14;
      slide.addShape("line", { x: ax, y: ay, w: 0, h: laneY - ay, line: { color: MUTED, width: 1.25 } });
      slide.addShape("line", { x: Math.min(ax, bx), y: laneY, w: Math.abs(bx - ax), h: 0, line: { color: MUTED, width: 1.25 } });
      slide.addShape("line", { x: bx, y: by, w: 0, h: laneY - by, line: { color: MUTED, width: 1.25, endArrowType: "triangle" } });
    }
    if (e.label) {
      const ly = b.r <= a.r ? top + h - 0.46 : by - 0.34;
      labels.push({ text: e.label, x: (ax + bx) / 2 - 0.3, y: Math.max(top, ly) });
    }
  }
  for (const n of d.nodes) {
    const p = pos.get(n.id);
    const decision = out(n.id).filter((e) => e.label).length >= 2;
    slide.addShape("roundRect", { x: p.x, y: p.y, w: nodeW, h: nodeH, rectRadius: 0.06, fill: { color: SURFACE }, line: { color: decision ? ACCENT : SURFACE, width: decision ? 1.5 : 0 } });
    slide.addText(clamp(n.label, 16), {
      x: p.x + 0.14, y: p.y + 0.06, w: nodeW - 0.28, h: nodeH - 0.12,
      fontFace: FONT, fontSize: 14, bold: true, color: TEXT, align: "center", valign: "middle", margin: 0,
    });
  }
  for (const l of labels) {
    slide.addText(clamp(l.text, 4), {
      x: l.x, y: l.y, w: 0.6, h: 0.3, margin: 0, fontFace: FONT,
      fontSize: 13, bold: true, color: ACCENT, align: "center", valign: "middle",
      fill: { color: BG }, line: { color: BG, width: 0 },
    });
  }
  return top + h;
}

function renderMatrix(slide, d, top, h) {
  const padL = 0.9;
  const padT = 0.38;
  const gap = 0.18;
  const cw = (W - 2 * M - padL - gap) / 2;
  const ch = (h - padT - gap) / 2;
  const POS = { "高影响低概率": [0, 0], "高影响高概率": [0, 1], "低影响低概率": [1, 0], "低影响高概率": [1, 1] };
  const FILL = { "高影响高概率": "2E1E17", "高影响低概率": "2A2318", "低影响高概率": "1F2522", "低影响低概率": "1A1E1B" };
  const BORDER = { "高影响高概率": DANGER, "高影响低概率": ACCENT, "低影响高概率": PRIMARY, "低影响低概率": LINE };
  slide.addText((d.axes?.y || "影响") + " ↑", { x: M, y: top, w: 1.4, h: 0.3, fontFace: FONT, fontSize: 13, color: MUTED, margin: 0 });
  slide.addText((d.axes?.x || "概率") + " →", { x: W - M - 1.6, y: top, w: 1.6, h: 0.3, fontFace: FONT, fontSize: 13, color: MUTED, align: "right", margin: 0 });
  for (const cell of d.cells) {
    const p = POS[cell.key];
    if (!p) continue;
    const x = M + padL + p[1] * (cw + gap);
    const y = top + padT + p[0] * (ch + gap);
    slide.addShape("roundRect", { x, y, w: cw, h: ch, rectRadius: 0.05, fill: { color: FILL[cell.key] || SURFACE }, line: { color: BORDER[cell.key] || LINE, width: 1 } });
    slide.addText(cell.key, { x: x + 0.18, y: y + 0.1, w: cw - 0.36, h: 0.26, fontFace: FONT, fontSize: 12.5, bold: true, color: BORDER[cell.key] || PRIMARY, margin: 0 });
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
  const w = (W - 2 * M - gap * (n - 1)) / n;
  const lineY = top + 0.62;
  slide.addShape("line", { x: M, y: lineY, w: W - 2 * M, h: 0, line: { color: LINE, width: 2 } });
  const maxItems = Math.max(...d.phases.map((p) => p.items.length), 1);
  const cardH = Math.min(2.9, Math.max(1.15, 0.42 + maxItems * 0.44));
  const cardTop = lineY + 0.34;
  d.phases.forEach((p, i) => {
    const x = M + i * (w + gap);
    slide.addText(clamp(p.name, 10), { x, y: top, w, h: 0.34, fontFace: FONT, fontSize: 15, bold: true, color: i === 0 ? ACCENT : PRIMARY, align: "center", margin: 0 });
    slide.addShape("ellipse", { x: x + w / 2 - 0.08, y: lineY - 0.08, w: 0.16, h: 0.16, fill: { color: i === 0 ? ACCENT : PRIMARY }, line: { color: i === 0 ? ACCENT : PRIMARY, width: 0 } });
    slide.addShape("roundRect", { x, y: cardTop, w, h: cardH, rectRadius: 0.06, fill: { color: SURFACE }, line: { color: SURFACE, width: 0 } });
    slide.addText(
      p.items.map((t, j) => ({ text: clamp(t, 30), options: { bullet: { characterCode: "2013", indent: 12 }, breakLine: j < p.items.length - 1 } })),
      { x: x + 0.2, y: cardTop + 0.18, w: w - 0.4, h: cardH - 0.36, fontFace: FONT, fontSize: 14, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.25 },
    );
  });
  return cardTop + cardH;
}

function renderVisual(slide, s, top) {
  const hasBullets = s.bullets.length > 0;
  const h = hasBullets ? (s.takeaway ? 2.7 : 3.1) : s.takeaway ? 3.45 : 4.25;
  const d = s.visual;
  if (d.type === "layers") renderLayers(slide, d, top, h);
  else if (d.type === "flow") renderFlow(slide, d, top, h);
  else if (d.type === "matrix") renderMatrix(slide, d, top, h);
  else renderTimeline(slide, d, top, h);
  return top + h;
}

/** 图页/引言页附带的要点(≤3,单行 16pt)。 */
function renderSideBullets(slide, bullets, y) {
  const runs = [];
  bullets.forEach((b, i) => {
    const last = i === bullets.length - 1;
    if (b.lead) {
      runs.push({ text: b.lead, options: { bold: true, color: TEXT, bullet: { characterCode: "2013", indent: 12 } } });
      runs.push({ text: "　" + b.text, options: { color: MUTED, breakLine: !last, paraSpaceAfter: last ? 0 : 8 } });
    } else {
      runs.push({ text: b.text, options: { color: TEXT, bullet: { characterCode: "2013", indent: 12 }, breakLine: !last, paraSpaceAfter: last ? 0 : 8 } });
    }
  });
  slide.addText(runs, { x: M, y, w: W - 2 * M, h: 1.2, fontFace: FONT, fontSize: 16, margin: 0, valign: "top", lineSpacingMultiple: 1.25 });
}

function renderCode(slide, s, top, h) {
  const c = s.code;
  slide.addText(c.source, { x: M, y: top, w: W - 2 * M, h: 0.28, fontFace: FONT, fontSize: 12, color: PRIMARY, margin: 0 });
  const boxY = top + 0.34;
  const boxH = Math.min(h - 0.34, 0.28 + c.lines.length * 0.27);
  slide.addShape("roundRect", { x: M, y: boxY, w: W - 2 * M, h: boxH, rectRadius: 0.05, fill: { color: "161A17" }, line: { color: LINE, width: 0.75 } });
  const lineH = Math.min(0.27, (boxH - 0.2) / Math.max(1, c.lines.length));
  const fs = lineH >= 0.26 ? 13 : 12;
  slide.addText(
    c.lines.map((l, i) => ({ text: l.length ? l : " ", options: { breakLine: i < c.lines.length - 1 } })),
    { x: M + 0.22, y: boxY + 0.1, w: W - 2 * M - 0.44, h: boxH - 0.2, fontFace: "Courier New", fontSize: fs, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.05 },
  );
  return boxY + boxH;
}

/** 解读区:每条「粗体小标题 + 说明」,说明可两行(≤110 字)。 */
function renderReading(slide, bullets, y, h) {
  const n = bullets.length;
  const rowH = Math.min(0.86, h / Math.max(1, n));
  bullets.forEach((b, i) => {
    const ry = y + i * rowH;
    if (b.lead) {
      slide.addText([
        { text: b.lead, options: { bold: true, color: TEXT } },
        { text: " — " + b.text, options: { color: MUTED } },
      ], { x: M, y: ry, w: W - 2 * M, h: rowH - 0.06, fontFace: FONT, fontSize: 15, margin: 0, valign: "top", lineSpacingMultiple: 1.18 });
    } else {
      slide.addText(b.text, { x: M, y: ry, w: W - 2 * M, h: rowH - 0.06, fontFace: FONT, fontSize: 15, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.18 });
    }
  });
}

function renderContent(pptx, s) {
  const slide = pptx.addSlide();
  const top = pageHead(slide, s);
  const bottomLimit = s.takeaway ? 6.0 : 6.68;
  const budget = bottomLimit - top;
  const nB = s.bullets.length;
  const readingH = s.layout === "quote" && nB ? Math.min(1.15, 0.55 * nB) : nB ? Math.min(2.5, 0.82 * nB) : 0;
  const mainH = Math.max(1.35, budget - readingH - (nB ? 0.14 : 0));
  let bottom = top;
  if (s.layout === "code") {
    bottom = renderCode(slide, s, top, mainH);
  } else if (s.layout === "visual") {
    const d = s.visual;
    if (d.type === "layers") renderLayers(slide, d, top, mainH);
    else if (d.type === "flow") renderFlow(slide, d, top, mainH);
    else if (d.type === "matrix") renderMatrix(slide, d, top, mainH);
    else renderTimeline(slide, d, top, mainH);
    bottom = top + mainH;
  } else if (s.layout === "table") {
    bottom = renderTable(slide, s, top, mainH);
  } else if (s.layout === "steps") {
    bottom = renderSteps(slide, s, top);
  } else if (s.layout === "compare") {
    bottom = renderCompare(slide, s, top, mainH);
  } else if (s.layout === "stats") {
    bottom = renderStats(slide, s, top, mainH);
  } else if (s.layout === "quote") {
    bottom = renderQuote(slide, s, top);
  } else {
    renderList(slide, s, top);
    bottom = 6.0;
  }
  if (nB) {
    const ry = Math.max(bottom + 0.14, top + mainH + 0.14);
    renderReading(slide, s.bullets, ry, bottomLimit - ry);
  }
  if (s.takeaway) renderNote(slide, s, Math.min(6.06, Math.max(bottomLimit + 0.06, top + 2.2)));
  pageFoot(slide, s);
  return slide;
}

function renderCover(pptx, s) {
  const cover = pptx.addSlide();
  cover.background = { color: BG };
  cover.addText("CODE REVIEW", { x: M, y: 0.95, w: 6, h: 0.34, fontFace: FONT, fontSize: 14, color: PRIMARY, charSpacing: 3, margin: 0 });
  cover.addText(s.title, {
    x: M, y: 1.45, w: 8.7, h: 1.55, fontFace: FONT, fontSize: 44, bold: true, color: TEXT, margin: 0, valign: "top", lineSpacingMultiple: 1.1,
  });
  if (s.subtitle) {
    cover.addText(s.subtitle, { x: M, y: 3.05, w: 8.4, h: 0.8, fontFace: FONT, fontSize: 18, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.25 });
  }
  if (s.verdict) {
    cover.addShape("roundRect", { x: M, y: 4.0, w: 8.2, h: 1.5, rectRadius: 0.08, fill: { color: SURFACE }, line: { color: SURFACE, width: 0 } });
    cover.addText("总评", { x: M + 0.32, y: 4.2, w: 1.0, h: 0.28, fontFace: FONT, fontSize: 13, color: PRIMARY, margin: 0 });
    cover.addText(s.verdict, { x: M + 0.32, y: 4.5, w: 7.4, h: 0.46, fontFace: FONT, fontSize: 24, bold: true, color: TEXT, margin: 0 });
    if (s.verdictNote) {
      cover.addText(s.verdictNote, { x: M + 0.32, y: 4.96, w: 7.4, h: 0.5, fontFace: FONT, fontSize: 13, color: MUTED, margin: 0, valign: "top", lineSpacingMultiple: 1.15 });
    }
  }
  cover.addText("目录", { x: 9.6, y: 1.5, w: 3.2, h: 0.3, fontFace: FONT, fontSize: 13, color: PRIMARY, charSpacing: 1, margin: 0 });
  (s.toc || []).forEach((c, i) => {
    cover.addText(c.no, { x: 9.6, y: 1.94 + i * 0.46, w: 0.5, h: 0.3, fontFace: FONT, fontSize: 14, bold: true, color: PRIMARY, margin: 0 });
    cover.addText(c.title, { x: 10.14, y: 1.94 + i * 0.46, w: 2.7, h: 0.3, fontFace: FONT, fontSize: 14, color: TEXT, margin: 0 });
  });
  if (s.meta) {
    cover.addText(s.meta, { x: M, y: 6.85, w: W - 2 * M, h: 0.3, fontFace: FONT, fontSize: 12, color: MUTED, margin: 0 });
  }
  return cover;
}

export function deckToPptx(deck, outPath) {
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
  if (root) {
    out.push(`verdict: ${humanize(root.label)}`);
    out.push(`verdict_note: ${humanize(root.summary)}`);
  } else {
    out.push(`verdict: <!-- 总评一句话 -->`);
    out.push(`verdict_note: <!-- 支撑这句总评的两三点依据 -->`);
  }
  out.push(`meta: <!-- 仓库@版本 · 评审日期 · 评审人 -->`);
  out.push("");
  out.push(`<!-- 每页必须有一种视觉版式,纯文字页会被质量门拒:`);
  out.push(`     架构 → 三反引号 layers(层名: 组件|组件);流程 → flow(id: 名 + a -> b: 是);`);
  out.push(`     风险 → matrix(高影响高概率: 条目|条目);计划 → timeline(阶段: 事项|事项);`);
  out.push(`     取舍 → compare(方案A: 项|项 / 方案B: 项|项);数字 → stats(数字|说明|来源);`);
  out.push(`     单句结论 → quote(一句话 + 一句补充 + 来源)。正文 20pt,一条说明 ≤64 字。 -->`);
  chapters.forEach((ch, i) => {
    const no = numOf(ch.label) || String(i + 1).padStart(2, "0");
    out.push("");
    out.push(`## ${no} ${stripNo(ch.label)}`);
    out.push(`claim: <!-- 本章一句话结论(「所以呢」,不是「本章讲什么」) -->`);
    const kids = pagesOf.get(ch.id) || [];
    if (!kids.length) {
      out.push("");
      out.push(`### <!-- 页标题 -->`);
      out.push(`> 证据: <!-- 文件:行 -->`);
    }
    for (const pg of kids) {
      out.push("");
      out.push(`### ${stripNo(pg.label)}`);
      out.push(`<!-- 板上线索:${humanize(pg.summary)}`);
      out.push(`     选一种视觉版式改写(layers/flow/matrix/timeline/compare/stats/quote),必要时拆页 -->`);
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
  out.push(`     每页必须有一种视觉版式,纯文字页会被质量门拒:`);
  out.push(`     架构 → 三反引号 layers(层名: 组件|组件);流程 → flow(id: 名 + a -> b: 是);`);
  out.push(`     风险 → matrix(高影响高概率: 条目|条目);计划 → timeline(阶段: 事项|事项);`);
  out.push(`     取舍 → compare(方案A: 项|项 / 方案B: 项|项);数字 → stats(数字|说明|来源);`);
  out.push(`     单句结论 → quote(一句话 + 一句补充 + 来源)。正文 20pt,一条说明 ≤64 字。 -->`);
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
    out.push(`claim: <!-- 本章一句话结论(「所以呢」,不是「本章讲什么」) -->`);
    out.push("");
    out.push(`### ${name} · 开篇`);
    out.push(`- <!-- **小标题** — 一句话说明 -->`);
    out.push(`- <!-- **小标题** — 一句话说明 -->`);
    out.push(`> 素材: <!-- 数据/引用/案例来源(可选) -->`);
  });
  out.push("");
  return out.join("\n");
}
