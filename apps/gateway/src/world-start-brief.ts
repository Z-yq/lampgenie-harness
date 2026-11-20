/**
 * 世界模型开工简报:coding 任务开工一次性注入 L0 骨架 + 真命中 L1 模块页。
 * 纪律:
 * - 纯读产物(store 函数,零索引加载),纯函数(同输入同输出,无时间戳/随机数)→ 稳定前缀,prompt cache 友好。
 * - 与 禁掉的「每条消息匹配式 orient tips」不同:这是开工一次性的项目级事实(与方向简报同性质),
 * 不是按消息猜兴趣;L1 只注入确定性词面真命中(score>0),零命中不灌 fallback 候选(宁缺勿错)。
 * - 预算硬上限 WORLD_START_BRIEF_MAX_BYTES=7168(L0≤4096 + L1≤2×1024 + 包装余量);
 * 超限先丢 L1 页(从后往前),仍超则截 L0 尾部(保头部主线/模块清单)。
 * - fail-soft:产物缺失/读失败 = 空串(零变化),绝不阻塞开工。
 */
import {
  readWorldManifest,
  readWorldSkeleton,
  readWorldModulePage,
  readDrillCorpus,
  worldFreshness,
} from "@lampgenie/code-sense/world/store";
import { selectModules } from "@lampgenie/code-sense/world/drilldown";

export const WORLD_START_BRIEF_MAX_BYTES = 7168;
const L1_MAX_PAGES = 2;
const DRILL_HINT = '> 按需下钻:code_sense action=world target="<任务文本或模块名>";单页 target="module:<名>"。\n';

export function renderWorldStartBrief(root: string, taskText: string): string {
  try {
    const manifest = readWorldManifest(root);
    if (!manifest) return "";
    const skel = readWorldSkeleton(root);
    if (!skel.text) return "";
    const fresh = worldFreshness(root, manifest);
    const staleLine = fresh.state === "fresh"
      ? ""
      : `> ⚠ 世界模型${fresh.state === "stale" ? "陈旧" : "新鲜度未知"}:${fresh.reasons.join(";").slice(0, 100)}——codesense world --rebuild 重建\n`;

 // L1:只取真命中(score>0);fallback 候选 score=0 不注入。
    let pageBlocks: string[] = [];
    const corpus = readDrillCorpus(root);
    if (corpus) {
      const hits = selectModules(corpus, { text: String(taskText ?? "") }, { max: 3 })
        .filter((h) => h.score > 0)
        .slice(0, L1_MAX_PAGES);
      for (const h of hits) {
        const page = readWorldModulePage(root, h.module);
        if (page) pageBlocks.push(`### 模块页:${h.module}(命中:${h.hits.join(", ")})\n${page.text}`);
      }
    }

    const head = "## 世界模型骨架(开工一次性注入,稳定前缀)\n";
    const assemble = (pages: string[], skeleton: string): string =>
      head + staleLine + skeleton + (pages.length > 0 ? "\n" + pages.join("\n") : "") + "\n" + DRILL_HINT;

    let text = assemble(pageBlocks, skel.text);
    while (Buffer.byteLength(text, "utf8") > WORLD_START_BRIEF_MAX_BYTES && pageBlocks.length > 0) {
      pageBlocks = pageBlocks.slice(0, -1);
      text = assemble(pageBlocks, skel.text);
    }
    if (Buffer.byteLength(text, "utf8") > WORLD_START_BRIEF_MAX_BYTES) {
      const marker = "\n…(超预算截断)";
      const overhead = Buffer.byteLength(head + staleLine + marker + "\n" + DRILL_HINT, "utf8");
      const room = Math.max(0, WORLD_START_BRIEF_MAX_BYTES - overhead);
      let sk = skel.text;
      while (Buffer.byteLength(sk, "utf8") > room && sk.length > 0) {
        sk = sk.slice(0, Math.floor(sk.length * 0.9));
      }
      text = head + staleLine + sk + marker + "\n" + DRILL_HINT;
    }
    return text;
  } catch {
    return ""; // fail-soft:任何读失败=零变化
  }
}
