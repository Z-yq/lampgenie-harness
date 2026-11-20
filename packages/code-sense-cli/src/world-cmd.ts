/**
 * `codesense world` —— 世界模型常驻产物的**读/建/下钻/自检**入口。
 * 三条使用姿势(对应 docs/world-model.md):
 * 1. `codesense world` 读常驻产物(L0 骨架,几 KB),**不加载索引**——开工时的第一句
 * 2. `codesense world --for "<任务>"` 按任务文本确定性打分,只给 1–3 个相关模块页(按需下钻)
 * 3. `codesense world --rebuild` / `--check` 重建 / 自检(新鲜度 + 五项质量门;这两条要读索引)
 * 分层纪律:渲染在 `@lampgenie/code-sense/world/render`、落盘与新鲜度在 `.../world/store`、
 * 下钻打分在 `.../world/drilldown`、质量指标在 `.../world/quality`。本文件只做「root 解析 +
 * 索引就绪 + 输出格式 + 退出码」,零指标逻辑。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { indexStale, loadIndex } from "@lampgenie/code-sense/callgraph/c2f";
import { WORLD_L0_MAX_BYTES } from "@lampgenie/code-sense/world/render";
import { selectModules, type ModuleHit } from "@lampgenie/code-sense/world/drilldown";
import { computeArtifactRefs, computeQuality, renderQualityReport, type QualityReport } from "@lampgenie/code-sense/world/quality";
import { refreshWorldAfterSave } from "@lampgenie/code-sense/world/refresh";
import {
  readDrillCorpus,
  readWorldManifest,
  readWorldModulePage,
  readWorldSkeleton,
  listWorldModules,
  worldFreshness,
  worldManifestPath,
  type WorldFreshness,
  type WorldManifest,
} from "@lampgenie/code-sense/world/store";
import { resolveProjectRoot } from "./registry.js";

export interface WorldCmdOptions {
 /** `--root <dir>`:显式根;缺省按注册表/索引产物向上就近解析。 */
  root?: string;
 /** 强制重建产物(需读索引)。 */
  rebuild?: boolean;
 /** `--module <name>`:只给单个模块页(不加载索引)。 */
  module?: string;
 /** `--for "<任务文本>"`:按任务文本下钻。 */
  forText?: string;
 /** `--files a.ts,b.ts`:按改动文件下钻。 */
  files?: string[];
 /** `--check`:新鲜度 + 质量门(要读索引;exit 1 = 不通过)。 */
  check?: boolean;
 /** `--json`:机器面。 */
  json?: boolean;
  quiet?: boolean;
 /** 下钻返回的模块页上限(缺省 3)。 */
  maxModules?: number;
 /** `--check` 时把该文件正文纳入 `file:line` 确定性校验。 */
  doc?: string;
}

/** root 解析:显式 --root > 注册表/索引产物就近 > cwd(与 cli.ts 既有轻量路径同口径)。 */
export function resolveWorldRoot(rootArg?: string): string {
  if (rootArg) {
    const abs = resolve(rootArg);
    if (!existsSync(abs)) throw new Error(`root 不存在: ${abs}`);
    return abs;
  }
  const hit = resolveProjectRoot(process.cwd());
  return hit?.root ?? process.cwd();
}

interface Built {
  manifest: WorldManifest;
  skeleton: string;
}

function note(o: WorldCmdOptions, msg: string): void {
  if (!o.quiet) process.stderr.write(`[codesense] ${msg}\n`);
}

/** 从索引重建产物(渲染 + 落盘 + 下钻语料)。唯一会 loadIndex 的路径之一。 */
async function buildWorld(root: string, o: WorldCmdOptions): Promise<Built | { error: string; code: number }> {
  const idx = loadIndex(root);
  if (!idx) {
    return {
      error: `索引缺失:${root}/.genie/sense-index 下没有可用 index.json——先运行 \`codesense index --register\`(全量构建约数分钟),再 \`codesense world --rebuild\``,
      code: 2,
    };
  }
 // render+write 序列复用 saveIndex 同代刷新入口(渲染 + 落盘 + 下钻语料)。
  const r = refreshWorldAfterSave(root, idx);
  if (!r.ok) return { error: `world 产物刷新失败:${r.error}`, code: 2 };
  if (r.skipped || !r.manifest) {
    return { error: "world 产物刷新失败:GENIE_WORLD_AUTOREFRESH=0 闸生效,产物未写——取消该环境变量后重试", code: 2 };
  }
  const manifest = r.manifest;
  const skeleton = readWorldSkeleton(root).text ?? "";
  note(
    o,
    `world 产物已重建: L0 ${manifest.bytes.skeleton}B(${manifest.tokens.chars4} tok@4) · L1 ${manifest.pages.length} 页 ${manifest.bytes.pages}B · 渲染 ${manifest.renderMs}ms · → ${worldManifestPath(root)}`,
  );
  if (manifest.bytes.skeleton > WORLD_L0_MAX_BYTES) {
    note(o, `[warn] L0 超预算 ${manifest.bytes.skeleton}B > ${WORLD_L0_MAX_BYTES}B(渲染器应已截断,此处如实报异常)`);
  }
  return { manifest, skeleton };
}

function staleBanner(fresh: WorldFreshness): string {
  if (fresh.state === "fresh") return "";
  const tag = fresh.state === "stale" ? "陈旧" : "新鲜度未知";
  return [
    `> ⚠ 世界模型${tag}:${fresh.reasons.join(";")}`,
    "> 修复:`codesense world --rebuild`(索引本身过期时先 `codesense index`)",
  ].join("\n");
}

function budgetLine(m: WorldManifest | null, fresh: WorldFreshness): string {
  const idxAt = m ? new Date(m.fp.builtAt).toISOString().replace("T", " ").slice(0, 19) : "(无)";
  const at = m ? new Date(m.at).toISOString().replace("T", " ").slice(0, 19) : "(无)";
  return [
    `<!-- world · ${fresh.state} · index builtAt=${idxAt} · rendered=${at} ·`,
    `L0=${m?.bytes.skeleton ?? 0}B · L1=${m?.bytes.pages ?? 0}B(${m?.pages.length ?? 0} 页) ·`,
    `tokens≈${m?.tokens.chars4 ?? 0}(@4)/${m?.tokens.cjkAware ?? 0}(CJK-aware) -->`,
  ].join(" ");
}

/** 下钻:读语料打分(语料缺失或有 --rebuild 时先建)。 */
async function drill(
  root: string,
  o: WorldCmdOptions,
): Promise<{ error: string; code: number } | { hits: ModuleHit[]; pages: { module: string; text: string }[]; fallback: boolean }> {
  let corpus = readDrillCorpus(root);
  if (!corpus) {
    note(o, "下钻语料缺失(drill.json),先建一次产物");
    const built = await buildWorld(root, o);
    if ("error" in built) return built;
    corpus = readDrillCorpus(root);
    if (!corpus) return { error: "下钻语料构建失败(drill.json 未落盘)", code: 2 };
  }
  const max = o.maxModules ?? 3;
  const hits = selectModules(corpus, { text: o.forText, files: o.files }, { max });
  const pages: { module: string; text: string }[] = [];
  for (const h of hits) {
    const page = readWorldModulePage(root, h.module);
    if (page) pages.push({ module: page.module, text: page.text });
  }
  if (hits.length > 0) return { hits, pages, fallback: false };

 // 零词面命中(典型:纯中文任务文本 vs 英文标识符)——不猜语义,给「按规模」的确定性候选,
 // 由调用方自己 --module 指定。这条兜底必须**明说是兜底**,不能伪装成命中。
  const order = listWorldModules(root).slice(0, max);
  const fbHits: ModuleHit[] = order.map((m) => ({ module: m, slug: m, score: 0, hits: ["fallback:按规模候选(零词面命中)"] }));
  for (const h of fbHits) {
    const page = readWorldModulePage(root, h.module);
    if (page) pages.push({ module: page.module, text: page.text });
  }
  return { hits: fbHits, pages, fallback: true };
}

/** 退出码:0=正常/通过;1=--check 未通过;2=索引未就绪/参数错。 */
export async function worldCmd(o: WorldCmdOptions): Promise<number> {
  let root: string;
  try {
    root = resolveWorldRoot(o.root);
  } catch (e) {
    process.stderr.write(`[codesense] ${(e as Error).message}\n`);
    return 2;
  }

  const reading = o.module !== undefined || o.forText !== undefined || (o.files?.length ?? 0) > 0;

 // 1) 需要产物但产物缺失 / 显式 --rebuild → 建
  let manifest = readWorldManifest(root);
  let fresh = worldFreshness(root, manifest);
  const needBuild = o.rebuild || (!reading && manifest === null);
  if (needBuild && !o.check) {
    const built = await buildWorld(root, o);
    if ("error" in built) {
      process.stderr.write(`[codesense] ${built.error}\n`);
      return built.code;
    }
    manifest = built.manifest;
    fresh = worldFreshness(root, manifest);
  }

 // 2) --check:新鲜度(完整 indexStale)+ 五项质量门
  if (o.check) {
    const idx = loadIndex(root);
    const skelRead = readWorldSkeleton(root);
    const freshFull: WorldFreshness = { ...fresh };
    const reasons = [...fresh.reasons];
    let idxStale = false;
    if (idx) {
      idxStale = indexStale(root, idx);
      if (idxStale) reasons.push("索引已过期(源码变动)— `codesense index` 后 `world --rebuild`");
    } else {
      reasons.push("索引缺失,无法自检质量门");
    }
    freshFull.state = reasons.length === 0 ? "fresh" : "stale";
    freshFull.reasons = reasons;

    let quality: QualityReport | null = null;
    if (idx) {
      let docText: string | undefined;
      if (o.doc) {
        const p = resolve(o.doc);
        if (!existsSync(p)) {
          process.stderr.write(`[codesense] --doc 文件不存在: ${p}\n`);
          return 2;
        }
        docText = readFileSync(p, "utf-8");
      }
      quality = computeQuality(idx, docText === undefined ? {} : { docText });
    }

 // 产物锚点校验(零索引加载:只读 skeleton.md + 模块页文本;与 idx 是否在场无关)
    const artifactRefs = computeArtifactRefs(root);

    const pass = freshFull.state === "fresh" && (quality?.pass.all ?? false) && artifactRefs.pass;
    if (o.json) {
      process.stdout.write(
        JSON.stringify(
          { root, manifest, fresh: freshFull, indexStale: idxStale, quality, artifactRefs, pass, skeletonBytes: skelRead.manifest?.bytes.skeleton ?? 0 },
          null,
          2,
        ) + "\n",
      );
    } else {
      const lines: string[] = [budgetLine(manifest, freshFull)];
      const banner = staleBanner(freshFull);
      if (banner) lines.push(banner);
      if (quality) lines.push("", renderQualityReport(quality));
      const arPreview = artifactRefs.bad.slice(0, 3).map((b) => `${b.ref}(${b.reason})`).join(";");
      lines.push(
        "",
        `产物锚点: ${artifactRefs.pass ? "✅ 通过" : "❌ 未通过"} · ${
          artifactRefs.checked ? `共 ${artifactRefs.total} 条,坏 ${artifactRefs.bad.length} 条` : "未校验(无产物)"
        }${arPreview ? ` — ${arPreview}${artifactRefs.bad.length > 3 ? ";…" : ""}` : ""}`,
      );
      lines.push("", `总判定: ${pass ? "✅ 通过(产物新鲜 + 质量门全绿 + 产物锚点全真)" : "❌ 未通过(见上面每条原因)"}`);
      process.stdout.write(lines.join("\n") + "\n");
    }
    return pass ? 0 : 1;
  }

 // 3) 单模块页(不加载索引)
  if (o.module !== undefined) {
    const page = readWorldModulePage(root, o.module);
    if (!page) {
      const mods = listWorldModules(root);
      process.stderr.write(
        `[codesense] 没有模块 \`${o.module}\` 的页面。已产出的模块(${mods.length}):${mods.slice(0, 30).join(", ")}${mods.length > 30 ? " …" : ""}\n`,
      );
      return 2;
    }
    const text = o.json
      ? JSON.stringify({ root, module: page.module, bytes: page.manifestPage?.bytes ?? null, fresh, markdown: page.text }, null, 2)
      : [budgetLine(manifest, fresh), staleBanner(fresh), "", page.text].filter((s) => s.length > 0).join("\n");
    process.stdout.write(text + "\n");
    return 0;
  }

 // 4) 按需下钻
  if (reading) {
    const r = await drill(root, o);
    if ("error" in r) {
      process.stderr.write(`[codesense] ${r.error}\n`);
      return r.code;
    }
    if (o.json) {
      process.stdout.write(JSON.stringify({ root, fresh, hits: r.hits, pages: r.pages }, null, 2) + "\n");
      return 0;
    }
    if (r.hits.length === 0) {
      process.stdout.write(
        `没有模块与给定${o.forText ? `任务文本「${o.forText}」` : "文件清单"}匹配(零命中不猜——用 \`codesense world\` 看模块清单后 --module 指定)。\n`,
      );
      return 0;
    }
    const out: string[] = [budgetLine(manifest, fresh), staleBanner(fresh)];
    out.push(
      r.fallback
        ? `零词面命中(${o.forText ? `任务文本「${o.forText}」` : "文件清单"}与模块名/目录/文件名/符号名无交集)——不猜语义,下面是**按规模**的候选(自行 --module 指定):`
        : `命中 ${r.hits.length} 个模块(确定性词面打分,零 LLM):`,
    );
    for (const h of r.hits)
      out.push(r.fallback ? `- ${h.module} · ${h.hits[0]}` : `- ${h.module} · 分数 ${h.score} · ${h.hits.join(" ")}`);
    for (const p of r.pages) out.push("", p.text.trimEnd());
    process.stdout.write(out.filter((s) => s.length > 0).join("\n") + "\n");
    return 0;
  }

 // 5) 默认:L0 骨架(不加载索引)
  const skel = readWorldSkeleton(root);
  if (!skel.text) {
    process.stderr.write(`[codesense] 产物缺失且无法构建:${root}\n`);
    return 2;
  }
  if (o.json) {
    process.stdout.write(JSON.stringify({ root, manifest: skel.manifest, fresh: skel.fresh, markdown: skel.text }, null, 2) + "\n");
    return 0;
  }
  const hint = "> 下钻:`codesense world --module <name>` 单模块页 · `codesense world --for \"<任务文本>\"` 按需选模块 · `codesense world --rebuild` 重建";
  process.stdout.write([budgetLine(skel.manifest, skel.fresh), staleBanner(skel.fresh), "", skel.text.trimEnd(), "", hint].filter((s) => s.length > 0).join("\n") + "\n");
  return 0;
}
