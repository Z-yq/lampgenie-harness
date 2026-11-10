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
  opts?: BoardDiagramOptions): Promise<BoardDiagramResult> {
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

    const svg = exported?.output?.files?.[0]?.text;
    if (typeof svg !== "string" || !svg.trim()) {
      return done(false, "", [...diags, errDiag("E_NO_SVG", new Error("flowkit export 未返回 SVG 文本"))]);
    }
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