/**
 * 白板 → SVG 出图(node 侧,无 DOM):serializeBoard → openflowkit create_diagram → export svg。
 * 设计约束(白板族最痛的一条):**绝不向上抛**。面板/HTTP 侧拿到的是「出图失败卡片」而不是
 * 500/未捕获 rejection,所以这里 catch 一切(动态 import 失败 / flowkit 抛错 / files[0].text 缺失 /
 * 编译诊断 error),统一收敛成 ok:false + diagnostics。
 * flowkit 包(@openflowkit/openflowkit-mcp@0.2.4)是 ~800KB 纯 ESM,首调用 import 有百毫秒级开销,
 * 故模块内缓存 import promise(warmupBoardDiagram 供 server 启动预热),失败不缓存(下次重试)。
 */

import type { BoardDoc } from "@lampgenie/protocol";
import { serializeBoard } from "./board-ofk.js";
import { createBoardElkLayout } from "./board-layout-elk.js";

export interface BoardDiagramDiagnostic {
  line: number;
  code: string;
  severity: string;
  message: string;
}

export interface BoardDiagramResult {
  ok: boolean;
  /** `<svg ...>...</svg>`;失败时空串。 */
  svg: string;
  /** flowkit 编译/导出诊断 + 本地兜底诊断;ok=false 时非空。 */
  diagnostics: BoardDiagramDiagnostic[];
  elapsedMs: number;
}

/** flowkit agent 模块最小面(声明文件在 openflowkit-agent.d.ts,此处再收窄一次便于自检)。 */
interface OfkAgent {
  createAgentDocument(kind: string): any;
  createFileCapabilities(opts: Record<string, unknown>): Promise<any>;
  compileWorkspace: any;
  findAgentOp(name: string): any;
  runAgentOp(op: any, input: Record<string, unknown>, ctx: Record<string, unknown>): Promise<any>;
}

const MODULE_ID = "@openflowkit/openflowkit-mcp/dist/generated/openflowkit-agent.js";

let ofkPromise: Promise<OfkAgent> | null = null;

/** 动态 import + 进程内单例;失败清缓存,便于下次重试(预热失败不该毒化后续出图)。 */
function loadOfk(): Promise<OfkAgent> {
  if (!ofkPromise) {
    ofkPromise = (import(/* @vite-ignore */ MODULE_ID) as Promise<OfkAgent>).catch((err: unknown) => {
      ofkPromise = null;
      throw err;
    });
  }
  return ofkPromise;
}

/** 预热:只触发动态 import,失败静默(出图时才把错误报给用户)。 */
export async function warmupBoardDiagram(): Promise<void> {
  try {
    await loadOfk();
  } catch {
    /* 静默:预热不是功能路径 */
  }
}

/** 把任意 throw 值转成诊断项。 */
function errDiag(code: string, err: unknown): BoardDiagramDiagnostic {
  const message = err instanceof Error ? err.message : String(err);
  return { line: 0, code, severity: "error", message };
}

/** 回退类诊断用 warning:降级出图仍算成功,不能因此把 ok 打成 false。 */
function warnDiag(code: string, err: unknown): BoardDiagramDiagnostic {
  const message = err instanceof Error ? err.message : String(err);
  return { line: 0, code, severity: "warning", message };
}

/** flowkit 诊断 → 本模块诊断(缺字段兜底,防 undefined 传染到 JSON 响应)。 */
function normDiag(d: any): BoardDiagramDiagnostic {
  return {
    line: typeof d?.line === "number" ? d.line : 0,
    code: typeof d?.code === "string" ? d.code : "E_UNKNOWN",
    severity: typeof d?.severity === "string" ? d.severity : "warning",
    message: typeof d?.message === "string" ? d.message : String(d?.message ?? d),
  };
}

/**
 * flowkit 的节点文字折行只对「文字安全框 == 节点框」的形状生效(rect/rounded,见其 pp):
 * 其余形状(diamond/ellipse/hexagon/cylinder/...)走 inset 安全框分支,直接返回默认
 * sizingPolicy(overflow="visible"),长 label/summary 会单行冲出图形边界。
 * 这里在 create_diagram 之后、export 之前给非矩形节点显式打开 wrap,交给库自己折行。
 */
const WRAP_READY_SHAPES = new Set(["", "rect", "rounded"]);

/** 形状 → 文字左右内边距(按节点宽度取比例 + 下限):让折行后的行宽落在图形内接区域内。 */
const SHAPE_TEXT_PADDING: Record<string, (width: number) => number> = {
  diamond: (w) => Math.max(12, Math.round(w * 0.24)),
  circle: (w) => Math.max(10, Math.round(w * 0.2)),
  ellipse: (w) => Math.max(10, Math.round(w * 0.1)),
  hexagon: (w) => Math.max(10, Math.round(w * 0.14)),
  parallelogram: (w) => Math.max(10, Math.round(w * 0.14)),
  cloud: (w) => Math.max(10, Math.round(w * 0.14)),
  queue: (w) => Math.max(10, Math.round(w * 0.1)),
  cylinder: (w) => Math.max(10, Math.round(w * 0.08)),
  doc: (w) => Math.max(10, Math.round(w * 0.08)),
  note: (w) => Math.max(10, Math.round(w * 0.08)),
  mobile: (w) => Math.max(10, Math.round(w * 0.1)),
  browser: (w) => Math.max(10, Math.round(w * 0.08)),
  component: (w) => Math.max(10, Math.round(w * 0.1)),
  person: (w) => Math.max(10, Math.round(w * 0.08)),
};

/** 给非矩形节点写 sizingPolicy.overflow="wrap"(+ 形状相关 textPadding);返回命中节点数。 */
function applyTextWrapPolicy(document: any): number {
  let hit = 0;
  const pages = Array.isArray(document?.pages) ? document.pages : [];
  for (const page of pages) {
    const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
    for (const node of nodes) {
      const content = node?.content;
      if (!content || typeof content !== "object") continue;
      const shape = typeof content.shape === "string" ? content.shape : "";
      if (WRAP_READY_SHAPES.has(shape)) continue;
      const width = typeof node?.size?.width === "number" ? node.size.width : 0;
 // D2:maxLines 不再写死 4——按节点实际高度推行数(每行 ~18px,减去上下 padding),
 // note 等高节点(n8 height 指令撑开)能显示全部行;低节点仍自然被裁。
      const height = typeof node?.size?.height === "number" ? node.size.height : 88;
      const maxLines = Math.max(2, Math.min(40, Math.floor((height - 16) / 18)));
      content.sizingPolicy = {
        version: 1,
        mode: "fixed",
        minSize: { width: 24, height: 24 },
        maxSize: { width: 1600, height: 1200 },
        overflow: "wrap",
        clipContent: false,
        maxLines,
      };
      const padOf = SHAPE_TEXT_PADDING[shape];
      const pad = padOf ? padOf(width) : 0;
      if (pad > 0) node.appearance = { ...(node.appearance ?? {}), textPadding: pad };
      hit++;
    }
  }
  return hit;
}

/** 布局器最小面(`{ run(graph, signal) }`;headlessElkLayout / createBoardElkLayout 都满足)。 */
interface BoardLayoutLike {
  run(graph: any, signal?: AbortSignal): Promise<any>;
}

/** 出图可选参数。 */
export interface BoardDiagramOptions {
  theme?: "light" | "dark";
  /** 目标宽高比(w/h),默认 1.6(接近 16:9)。只影响 wrapping 布局的折行决策。 */
  aspectRatio?: number;
  /** 逃生口:外部注入布局器(测试注入失败 / 高级用法);缺省用 createBoardElkLayout。 */
  layout?: BoardLayoutLike;
}

/**
 * 出图主入口。
 * @param doc 白板文档(BoardDocZ 校验过的形态;本函数不再校验,容错由 BoardDocZ 上游负责)
 * @param opts theme 缺省 light;aspectRatio 缺省 1.6
 */
export async function renderBoardSvg(
  doc: BoardDoc,
  opts?: BoardDiagramOptions,
): Promise<BoardDiagramResult> {
  const t0 = performance.now();
  const done = (ok: boolean, svg: string, diagnostics: BoardDiagramDiagnostic[]): BoardDiagramResult => ({
    ok,
    svg,
    diagnostics,
    elapsedMs: Math.round(performance.now() - t0),
  });

  try {
    if (!doc || !Array.isArray(doc.nodes) || doc.nodes.length === 0) {
      return done(false, "", [{ line: 0, code: "E_EMPTY", severity: "error", message: "板上没有节点" }]);
    }

    // 序列化阶段的清洗 records 只作为「警告说明」带出:它们不是 error,不拦 ok。
    const { ofk, warnings } = serializeBoard(doc);
    const diags: BoardDiagramDiagnostic[] = warnings.map((w) => ({
      line: 0,
      code: "W_SANITIZE",
      severity: "warning",
      message: w,
    }));

    const ofkMod = await loadOfk();
 // 布局优先级:wrapping 布局(自实现 layered + MULTI_EDGE 折行 + aspectRatio)
    // → headlessElkLayout(写死 INCLUDE_CHILDREN、无 wrapping,长链板会排成单列长条)
    // → deterministicLayout(compileWorkspace 默认;只按声明顺序串行摆放,最差但绝不白屏)。
    // 任何一级抛错都降一级并记诊断,绝不让整张图出不来。
    const headless = (ofkMod as { headlessElkLayout?: unknown }).headlessElkLayout as BoardLayoutLike | undefined;
    const wrapLayout: BoardLayoutLike = opts?.layout ?? createBoardElkLayout({ aspectRatio: opts?.aspectRatio ?? 1.6 });

    /** 用指定布局器跑一遍 create_diagram + export(每步都新建 document,失败就整步重来)。 */
    const runWith = async (layout: BoardLayoutLike | null): Promise<any> => {
      const capabilities = {
        ...(await ofkMod.createFileCapabilities({})),
        compileWorkspace: (text: string, options?: Record<string, unknown>) =>
          ofkMod.compileWorkspace(text, layout ? { ...(options ?? {}), layout } : (options ?? {})),
      };
      const doc0 = ofkMod.createAgentDocument("board");
      const pid = doc0?.pages?.[0]?.id;
      if (!pid) throw new Error("flowkit: createAgentDocument 未返回 pageId");
      const created = await ofkMod.runAgentOp(
        ofkMod.findAgentOp("create_diagram"),
        { dsl: ofk },
        { document: doc0, pageId: pid, capabilities },
      );
 // 排版完成(尺寸定稿)后、导出前打开非矩形节点的折行;export 用的就是这份 document。
      applyTextWrapPolicy(created?.document ?? doc0);
      diags.push(...((created?.output?.diagnostics ?? []) as any[]).map(normDiag));
      return ofkMod.runAgentOp(
        ofkMod.findAgentOp("export"),
        { format: "svg", scope: "page", theme: opts?.theme ?? "light" },
        { document: created?.document ?? doc0, pageId: pid, capabilities },
      );
    };

    let exported: any;
    try {
      exported = await runWith(wrapLayout);
    } catch (err) {
      diags.push(warnDiag("W_LAYOUT_WRAP_FALLBACK", err));
      if (!headless) {
        diags.push(warnDiag("W_LAYOUT_FALLBACK", err));
        exported = await runWith(null);
      } else {
        try {
          exported = await runWith(headless);
        } catch (err2) {
          diags.push(warnDiag("W_LAYOUT_FALLBACK", err2));
          exported = await runWith(null);
        }
      }
    }
    diags.push(...((exported?.output?.diagnostics ?? []) as any[]).map(normDiag));

    const svgRaw = exported?.output?.files?.[0]?.text;
    if (typeof svgRaw !== "string" || !svgRaw.trim()) {
      return done(false, "", [...diags, errDiag("E_NO_SVG", new Error("flowkit export 未返回 SVG 文本"))]);
    }
 // G4 修复(容器视觉):flowkit 给根容器(dsl-*)画一张几乎包住全图的大框
 // (经验证 3256×1974 vs viewBox 3400×2100)——「全图都在一个组里」不携带任何分组信息,
 // 只产生一条横贯大灰框+空标题;子组(01/02/03)浅色主题下 fill=rgba(241,245,249,.52)
 // 是高饱和亮蓝底(约 86% 不透明度),压过节点卡的存在感。后处理两步:
 // ① 根容器框(面积 ≥ 85% viewBox)= 非语义装饰 → 摘除(标题空,无信息损失);
 // ② 其余组容器 fill 降为 0.04~0.10 透明度(留分区感,不抢节点卡的视觉主体)。
    const svg = postProcessContainers(svgRaw);
    const hasError = diags.some((d) => d.severity === "error");
    return done(!hasError && svg.trim().startsWith("<svg"), svg, diags);
  } catch (err) {
    // 动态 import 失败单独标码:便于区分「依赖缺失」与「DSL/渲染失败」。
    const code = err instanceof Error && /Cannot find|ERR_MODULE_NOT_FOUND|import/i.test(err.message)
      ? "E_IMPORT"
      : "E_RENDER";
    return done(false, "", [errDiag(code, err)]);
  }
}

/** 容器视觉后处理( G4):根容器框摘除 + 子组填充降透明度。纯字符串处理,失败原样返回。 */
function postProcessContainers(svg: string): string {
  try {
    const vb = svg.match(/viewBox="([\d.\-\s]+)"/);
    if (!vb || !vb[1]) return svg;
    const parts = vb[1].trim().split(/\s+/).map(Number);
    const vw = parts[2] ?? NaN, vh = parts[3] ?? NaN;
    if (!Number.isFinite(vw) || !Number.isFinite(vh)) return svg;
    const vbArea = vw * vh;
 // flowkit 组框形:<rect x="0" y="0" width="W" height="H" rx="12" fill="rgba(241,245,249,0.08)" stroke="#cbd5e1" .../>
    let rootStripped = 0, fillsSoftened = 0;
    let out = svg.replace(/<rect x="0" y="0" width="([\d.]+)" height="([\d.]+)"([^>]*fill="rgba\(241,245,249,[^"]*\)"[^>]*)\/>/g, (full, wS, hS, attrs) => {
      const w = Number(wS), h = Number(hS);
      if (!(w > 0 && h > 0)) return full;
      const area = w * h;
      if (area >= vbArea * 0.85) { rootStripped += 1; return ""; } // ① 根容器:摘框
 // ② 子组:fill 透明度统一压到 0.06(dark 观感基准;light 原为 .52 过重)
      fillsSoftened += 1;
      return `<rect x="0" y="0" width="${wS}" height="${hS}"${String(attrs).replace(/fill="rgba\(241,245,249,[^"]*\)"/, 'fill="rgba(241,245,249,0.06)"')}/>`;
    });
    if (rootStripped || fillsSoftened) {
      out = out.replace(/<!-- -->/g, ""); // 无 marker 占位(保 future 扩展),不动其余
    }
    return out;
  } catch {
    return svg;
  }
}