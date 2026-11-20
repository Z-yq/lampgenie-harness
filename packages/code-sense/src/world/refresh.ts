/**
 * world 产物同代刷新:索引落盘 → L0 skeleton / L1 modules / drill.json 同步重建。
 * 触发点 = saveIndex(callgraph/c2f.ts)尾部。CLI(incremental.ts)与网关 sense-index-worker
 * 都在 saveIndex 之后立刻 process.exit,所以刷新必须**同步**完成,不能 fire-and-forget 异步。
 * 失败降级 = fail-open:本函数永不抛错;刷新失败时产物留 stale,消费侧 store.worldFreshness /
 * world-cmd staleBanner 既有感知会如用户反馈陈旧,索引落盘本身不受影响。
 * env 闸:GENIE_WORLD_AUTOREFRESH=0 → 直接跳过(不写任何文件),返回 {ok:true, skipped:true}。
 * 环纪律:c2f ↔ render 存在静态环(render.ts 值导入 queryEntryPointsMeta),全部是调用期使用、
 * 函数声明提升,ESM/esbuild 安全。本文件顶层只定义、零调用零副作用;C2fIndex 仅 type-only 导入。
 */
import type { C2fIndex } from "../callgraph/c2f.js";
import { renderWorldSkeleton, renderWorldModulePages } from "./render.js";
import { buildDrillCorpus } from "./drilldown.js";
import { writeWorldArtifact, writeDrillCorpus, type WorldManifest } from "./store.js";

export interface WorldRefreshResult {
  ok: boolean;
 /** env 闸生效时为 true(未写任何文件)。 */
  skipped?: boolean;
 /** 刷新总耗时(渲染 + 落盘 + 下钻语料),ms。 */
  ms?: number;
  manifest?: WorldManifest;
  error?: string;
}

/** 同步刷新 world 产物;永不抛错(fail-open)。序列与 world-cmd buildWorld 原实现一致。 */
export function refreshWorldAfterSave(root: string, idx: C2fIndex): WorldRefreshResult {
  if (process.env.GENIE_WORLD_AUTOREFRESH === "0") return { ok: true, skipped: true };
  try {
    const t0 = Date.now();
    const skeleton = renderWorldSkeleton(idx);
    const pages = renderWorldModulePages(idx);
    const corpus = buildDrillCorpus(idx, pages.map((p) => p.module));
    const manifest = writeWorldArtifact(root, { skeleton, pages, renderMs: Date.now() - t0 });
    writeDrillCorpus(root, corpus);
    return { ok: true, ms: Date.now() - t0, manifest };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
