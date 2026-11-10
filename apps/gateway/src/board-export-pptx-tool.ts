/** board_export_pptx 工具(2026-10-27,step-1011 重写)。
 *
 * 分工:planner 画骨架板(章/页/总评)→ coding agent 写正文源稿(markdown,人可改)→
 * 本工具导出真实 .pptx。
 *
 * 为什么不让工具直接读板:第一版把页节点 1:1 铺成幻灯片,交付是「每页 1 行摘要 + 大片空白 +
 * 截断省略号」——白板页节点是规划卡片,不含页面正文。故本版把「渲染」与「内容」分开:
 *   mode=template 从板生成 <任务仓>/docs/review/<板id>.deck.md(结构已填、正文留 TODO)
 *   mode=export   读源稿 → 质量门(薄页/缺证据/内部术语/模板残留)→ 渲染 .pptx
 * 薄内容一律拒导并逐条点名,不给「导出成功但其实没内容」的假交付。
 * 纯 IO 面:读板/读源稿/写文件;不改板数据。
 */
import { loadBoardAsync } from "./board-store.js";
import { repoRoot } from "./repo-root.js";
import { deckToPptx, parseDeckMd, validateDeck, boardToDeckTemplate, boardToCompositionTemplate } from "./board-pptx.mjs";
import { isCompositionStructure, COMPOSITION_RELATIONS } from "./board-content-predicate.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute, basename, extname } from "node:path";
import type { Tool } from "@lampgenie/runtime/agent/loop";

type DeckExporter = (deck: unknown, outPath: string) => Promise<{ file: string; slides: number }>;
type DeckParser = (md: string) => unknown;
type DeckValidator = (deck: unknown) => { where: string; msg: string }[];
type DeckTemplater = (doc: unknown) => string;
type CompositionTemplater = (doc: unknown, opts?: { relations?: readonly string[] }) => string;
const deckExport = deckToPptx as unknown as DeckExporter;
const deckParse = parseDeckMd as unknown as DeckParser;
const deckValidate = validateDeck as unknown as DeckValidator;
const deckTemplate = boardToDeckTemplate as unknown as DeckTemplater;
const compositionTemplate = boardToCompositionTemplate as unknown as CompositionTemplater;

type Stats = { chapters: number; pages: number; bullets: number; tables: number; steps: number; visuals: number };
const statsOf = (deck: unknown): Stats => {
  const d = deck as { chapters?: { pages?: { blocks?: { kind: string; items?: unknown[] }[] }[] }[] };
  const st: Stats = { chapters: 0, pages: 0, bullets: 0, tables: 0, steps: 0, visuals: 0 };
  for (const c of d.chapters ?? []) {
    st.chapters++;
    for (const p of c.pages ?? []) {
      st.pages++;
      for (const b of p.blocks ?? []) {
        if (b.kind === "bullets") st.bullets += b.items?.length ?? 0;
        else if (b.kind === "table") st.tables++;
        else if (b.kind === "steps") st.steps++;
        else if (["flow", "layers", "matrix", "timeline"].includes(b.kind)) st.visuals++;
      }
    }
  }
  return st;
};

export function boardExportPptxTool(
  sessionId: string,
  taskId: string,
  taskRoot: string,
  storeRoot?: string,
): Tool {
  return {
    name: "board_export_pptx",
    description: [
      "把「骨架板 + 正文源稿」导出为真实 .pptx(方案评审/汇报文档)。两步走:",
      "① mode=template:从 docs 板(总评+章 section+页 page)生成 markdown 源稿 <任务仓>/docs/review/<板id>.deck.md,",
      "   结构/章名/页名/证据位已填好,正文处是 <!-- --> TODO;然后你按真实代码逐页补写 3–6 条要点。",
      "   composition 板(办公/产出类「作业思路板」:主题/受众/章节/章间关系)同样能 mode=template:",
      "   生成汇报骨架源稿(每章一个开篇页,素材行代替代码证据行,章序按章间关系边拓扑排)。",
      "② mode=export:传 source=<源稿路径> 导出。质量门会拒收:某页只有 1 条要点/没有正文/缺 `> 证据:`",
      "   行/残留 TODO/标题还带「骨架·草稿」字样/要点里出现「回答维度」这类内部指令。被拒会逐条点名页与原因。",
      "版式由源稿自动选:要点列表(缺省)、| 表格 |(对比/矩阵/风险清单)、```steps 代码块(管线/时序,画成带箭头的步骤条)。",
      "输出缺省 <任务仓>/docs/review/<源稿名>.pptx。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["template", "export"], description: "template=生成待填源稿;export=导出 pptx(缺省)" },
        source: { type: "string", description: "export 必填:markdown 源稿路径(相对任务仓或绝对路径)" },
        targetTaskId: { type: "string", description: "template 用:从哪块板生成(缺省=本任务板)" },
        outDir: { type: "string", description: "输出目录(缺省 <任务仓>/docs/review)" },
        outName: { type: "string", description: "export 用:输出文件名(不含扩展名;缺省同源稿名)" },
      },
      required: [],
    },
    execute: async (a: { mode?: string; source?: string; targetTaskId?: string; outDir?: string; outName?: string }) => {
      const mode = a.mode === "template" ? "template" : "export";
      // 板存储根与 board_upsert 同口径:storeRoot ?? repoRoot()(实测踩坑:按 taskRoot 读板,
      // 任务项目指向别仓时永远「板不存在」——planner 在同一会话画的板读不到)。
      const boardRoot = storeRoot ?? repoRoot();
      const outDir = typeof a.outDir === "string" && a.outDir.trim() !== "" ? a.outDir.trim() : join(taskRoot, "docs", "review");

      if (mode === "template") {
        const tid = typeof a.targetTaskId === "string" && a.targetTaskId.trim() !== "" ? a.targetTaskId.trim() : taskId;
        const doc = await loadBoardAsync(boardRoot, sessionId, tid) as { nodes?: { kind?: string; id?: string; label?: string }[]; edges?: { from?: string; to?: string; label?: string }[]; boardType?: string } | null;
        if (!doc) return `板 ${tid} 不存在或损坏(先 board_upsert 画骨架;本次未生成源稿)。`;
        // composition 板(办公/产出类「作业思路板」):boardType 标注或结构判据命中即走汇报骨架模板;
        // 关系词表由 board-content-predicate.ts 单一真源传入,防两处分叉。
        const isComp = doc.boardType === "composition"
          || isCompositionStructure(
            (doc.nodes || []) as { id: string; kind?: string }[],
            (doc.edges || []) as { from: string; to: string; label?: string }[],
          );
        if (!isComp) {
          const kinds = new Set((doc.nodes || []).map((n) => String(n.kind ?? "")));
          if (!kinds.has("section") || !kinds.has("page")) {
            return `板 ${tid} 不是「章+页」两层 docs 骨架(缺 section/page 节点)——先按 docs/draw 落两层结构;本次未生成源稿。`;
          }
        }
        const file = join(outDir, `${tid}.deck.md`);
        try {
          mkdirSync(dirname(file), { recursive: true });
          const md = isComp
            ? compositionTemplate(doc, { relations: COMPOSITION_RELATIONS })
            : deckTemplate(doc);
          writeFileSync(file, md, "utf8");
          const pages = (md.match(/^### /gm) || []).length;
          if (isComp) {
            return [
              `已生成汇报骨架源稿 ${file}(${pages} 个页标题,结构来自作业思路板 ${tid},正文位是 TODO)。`,
              `下一步:逐页补写 2–3 条要点「- **短小标题** — 一句话说明」;`,
              `每页选一种视觉版式(layers/flow/matrix/timeline/compare/stats/quote 或表格),纯文字页会被质量门拒;`,
              `素材来源写在「> 素材:」行(数据/引用/案例,不要求 文件:行);`,
              `写完调 board_export_pptx({mode:"export", source:"${file}"}) 导出——质量门会点名没填够的页。`,
            ].join("");
          }
          return [
            `已生成源稿 ${file}(${pages} 个页标题,结构来自板 ${tid},正文位是 TODO)。`,
            `下一步:逐页补写 3–6 条要点「- **短小标题** — 一句话说明(带 文件:行)」,每页保留/补上「> 证据: 文件:行」;`,
            `对比/风险/清单类页改写成 markdown 表格,管线类页用 \`\`\`steps 代码块(每行「步骤名 | 说明」);`,
            `写完调 board_export_pptx({mode:"export", source:"${file}"}) 导出——质量门会点名没填够的页。`,
          ].join("");
        } catch (err) {
          return `生成源稿失败:${String((err as Error)?.message ?? err).slice(0, 300)}(本次未产出文件)`;
        }
      }

      const srcIn = typeof a.source === "string" ? a.source.trim() : "";
      if (!srcIn) {
        return "export 需要 source=<源稿路径>。没有源稿就没有正文——先 mode=template 生成源稿、逐页补写,再导出(本次未导出)。";
      }
      const srcPath = isAbsolute(srcIn) ? srcIn : join(taskRoot, srcIn);
      if (!existsSync(srcPath)) {
        return `源稿 ${srcPath} 不存在(先 mode=template 生成;本次未导出)。`;
      }
      let md = "";
      try {
        md = readFileSync(srcPath, "utf8");
      } catch (err) {
        return `读取源稿失败:${String((err as Error)?.message ?? err).slice(0, 200)}(本次未导出)`;
      }
      const deck = deckParse(md);
      const issues = deckValidate(deck);
      if (issues.length > 0) {
        const head = issues.slice(0, 10).map((i) => `· ${i.where}:${i.msg}`).join("\n");
        return [
          `导出被拒:源稿有 ${issues.length} 处不合格(本次未产出文件)。`,
          head,
          issues.length > 10 ? `…还有 ${issues.length - 10} 处,修完再导。` : "",
          `修法:每页 3–6 条「- **小标题** — 说明」,配「> 证据: 文件:行」;删掉 <!-- --> 注释;标题写成对外文档名。`,
        ].filter(Boolean).join("\n");
      }
      const st = statsOf(deck);
      const name = (typeof a.outName === "string" && a.outName.trim() !== ""
        ? a.outName.trim()
        : basename(srcPath).replace(/\.deck\.md$/i, "").replace(/\.md$/i, ""));
      const file = join(outDir, `${name}${extname(name).toLowerCase() === ".pptx" ? "" : ".pptx"}`);
      try {
        mkdirSync(dirname(file), { recursive: true });
        const r = await deckExport(deck, file);
        return [
          `已导出 ${r.file}(${r.slides} 页幻灯片 = 封面 + ${st.pages} 张内容页;章名进页眉,不单独出章节页)。`,
          `内容量:${st.bullets} 条要点 / ${st.tables} 张表 / ${st.steps} 组步骤 / ${st.visuals} 张图。`,
          `文件在任务仓内,可直接打开审阅;源稿 ${basename(srcPath)} 可继续改后重导。`,
        ].join("");
      } catch (err) {
        return `导出失败:${String((err as Error)?.message ?? err).slice(0, 300)}(本次未产出文件)`;
      }
    },
  };
}
