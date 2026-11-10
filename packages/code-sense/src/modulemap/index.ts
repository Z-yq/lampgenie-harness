/**
 * modulemap(designs/16 §6.4):模块清单+导读。
 * 静态部分(目录结构→模块清单,evidence=ast)无 LLM;导读 LLM 注入可选。
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export const ModuleGuideSchema = z.object({
  name: z.string(),
  responsibility: z.string(),
  entryFile: z.string(),
  dependsOn: z.array(z.string()),
});
export type ModuleGuide = z.infer<typeof ModuleGuideSchema>;

/** 静态模块推导:packages/<name>/src 与 apps/<name>/src 为模块;顶层源文件归 "(root)"。
 * evidence=ast(目录结构事实);职责句=入口文件名+manifest 描述(不冒充 LLM 洞见)。
 * step-098(RC-096-A1)泛化:任一文件命中 packages|apps 快路径时保持旧行为逐字节不变;
 * 否则按语言惯例做目录拓扑聚类(Go/Java=目录即包;Python=包目录(含 __init__.py)/高内聚目录
 * 同形取 dirname;TS/JS=src 子目录聚合,无 src=前两段)——旧版在仓外恒出唯一模块 "(root)",
 * agent_alpha/poly-redash/go-cobra 三仓实锤 modulemap 不可用。 */
export function deriveModules(files: string[]): ModuleGuide[] {
  if (files.some((f) => /^(packages|apps)\/[^/]+\//.test(f))) return deriveModulesMonorepo(files);
  return deriveModulesByTopology(files);
}

/** monorepo 快路径(packages|apps 布局):旧 deriveModules 行为原样保留(含入口启发式旧口径)。 */
function deriveModulesMonorepo(files: string[]): ModuleGuide[] {
  const byModule = new Map<string, string[]>();
  for (const f of files) {
    const m = /^(packages|apps)\/([^/]+)\//.exec(f);
    const key = m ? `${m[1]}/${m[2]}` : "(root)";
    byModule.set(key, [...(byModule.get(key) ?? []), f]);
  }
  const modules: ModuleGuide[] = [];
  for (const [name, fs] of byModule) {
    // 入口:main/index/app/server/gateway 优先,否则第一个源文件(旧口径原样,不改 fast path 行为)
    const entry =
      fs.find((f) => /(^|\/)(main|index|app|server|gateway)\.[tj]sx?$/.test(f)) ??
      fs.find((f) => /\.(ts|py|go|js)$/.test(f)) ??
      fs[0]!;
    // 依赖邻居:同模块文件 import 的其他模块(从 SOURCE INDEX 风格粗扫——一期用文件路径前缀共存推断)
    const deps = [...byModule.keys()].filter((k) => k !== name && k !== "(root)");
    modules.push({
      name,
      responsibility: `静态推导:${fs.length} 个源文件,入口 ${entry.split("/").pop()}(LLM 导读未启用时占位)`,
      entryFile: entry,
      dependsOn: deps.slice(0, 6),
    });
  }
  return modules.sort((a, b) => a.name.localeCompare(b.name));
}

/** 模块清单输出上限:超出按文件数降序截断,余下并入 "(misc)"(如实登记合并口径)。 */
const TOPOLOGY_MAX_MODULES = 24;

/** 目录拓扑聚类键(语言惯例):
 * - Go/Java:目录即包 → dirname(根文件="(root)");
 * - Python:包目录(含 __init__.py)/高内聚脚本目录同为目录聚合单元 → dirname,按 2 层封顶聚合
 *   (服务级总览粒度:深层命名空间包并回一级业务目录——agent_alpha 的
 *   modules/agent_modules_v2/<8 个子系统>、offline_memorys/src/infra_layer/… 若不合并,
 *   计数排序会把 voice_interaction/ws_api 等一级服务目录挤出总览;包级细节归 code_index file 查询);
 * - TS/JS:src 子目录聚合(viz-lib/src/editor、frontend/src/components);无 src 段 → 前两段
 *   (client/app,深度≥3)否则首段;
 * - 其他扩展名(vue/html/rs/rb/php…):首段。 */
function topologyKey(f: string): string {
  const segs = f.split("/");
  if (segs.length === 1) return "(root)";
  const ext = f.slice(f.lastIndexOf("."));
  if (ext === ".go" || ext === ".java") return segs.slice(0, -1).join("/");
  if (ext === ".py") return segs.slice(0, Math.min(segs.length - 1, 2)).join("/");
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    const i = segs.lastIndexOf("src");
    if (i >= 0 && i < segs.length - 1) return segs.slice(0, Math.min(i + 2, segs.length - 1)).join("/");
    return segs.length > 2 ? segs.slice(0, 2).join("/") : segs[0]!;
  }
  return segs[0]!;
}

/** 文件→模块键的单一出处(step-118 wiki 复用;与 deriveModules 的分组口径一致)。
 * monorepo 布局(packages|apps)优先:命中包/应用按 `packages/<name>` 归组,其余 "(root)";
 * 否则走目录拓扑聚类(topologyKey)。caller 传入的 files 必须与 deriveModules 同一集合。 */
export function moduleAssignment(files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const monorepo = files.some((f) => /^(packages|apps)\/[^/]+\//.test(f));
  for (const f of files) {
    if (monorepo) {
      const m = /^(packages|apps)\/([^/]+)\//.exec(f);
      out.set(f, m ? `${m[1]}/${m[2]}` : "(root)");
    } else {
      out.set(f, topologyKey(f));
    }
  }
  return out;
}

/** 入口文件启发式:入口名优先(main/index/app/server/gateway/cli/__main__),否则第一个源文件。 */
function pickEntryFile(fs: string[]): string {
  return (
    fs.find((f) => /(^|\/)(main|index|app|server|gateway|cli|__main__)\.(ts|tsx|js|jsx|mjs|cjs|py|go|java)$/.test(f)) ??
    fs.find((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|vue|rs|rb|php)$/.test(f)) ??
    fs[0]!
  );
}

/** 通用拓扑聚类(非 packages/apps 布局):目录=模块,依赖不猜(dependsOn=[] 如实)。 */
function deriveModulesByTopology(files: string[]): ModuleGuide[] {
  const byModule = new Map<string, string[]>();
  for (const f of files) {
    const key = topologyKey(f);
    byModule.set(key, [...(byModule.get(key) ?? []), f]);
  }
  // 文件数降序(并列按名字典序——确定性);超出上限的目录并入 "(misc)",不静默丢
  const sorted = [...byModule.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const kept = sorted.slice(0, TOPOLOGY_MAX_MODULES);
  const rest = sorted.slice(TOPOLOGY_MAX_MODULES);
  const modules: ModuleGuide[] = kept.map(([name, fs]) => {
    const entry = pickEntryFile(fs);
    return {
      name,
      responsibility: `静态推导:${fs.length} 个源文件,入口 ${entry.split("/").pop()}(目录拓扑聚类;依赖未静态推导;LLM 导读未启用时占位)`,
      entryFile: entry,
      dependsOn: [],
    };
  });
  if (rest.length > 0) {
    const restFiles = rest.reduce((n, [, fs]) => n + fs.length, 0);
    modules.push({
      name: "(misc)",
      responsibility: `静态推导:其余 ${rest.length} 个目录共 ${restFiles} 个源文件(单目录文件数均少于前 ${TOPOLOGY_MAX_MODULES} 名,合并陈列不逐个展开)`,
      entryFile: rest[0]![1][0]!,
      dependsOn: [],
    });
  }
  return modules;
}

/** LLM 导读(可选注入):对模块入口采样→一页导读。 */
export async function narrateModule(
  root: string,
  mod: ModuleGuide,
  llm: { chat(prompt: string): Promise<{ content: string }> },
): Promise<string> {
  let entryText = "";
  try {
    entryText = (await readFile(join(root, mod.entryFile), "utf-8")).slice(0, 4000);
  } catch { /* 入口读不到:空导读 */ }
  const r = await llm.chat(
    `以下是模块 ${mod.name} 的入口文件片段。用三句话回答:这个模块干什么/被谁用/改动它要注意什么。只输出三句话。\n\n${entryText}`,
  );
  return r.content;
}

/** 骨架建议(EMPTY 态,designs/16 §7.1):纯 LLM 产物,evidence=suggested。 */
export const SkeletonSchema = z.object({
  modules: z.array(z.object({
    name: z.string(),
    responsibility: z.string(),
    entryFile: z.string(),
  })).max(8),
});
export type Skeleton = z.infer<typeof SkeletonSchema>;

export function skeletonPrompt(intent: string): string {
  return `用户要新建项目,意图:「${intent}」。建议初始模块结构(JSON:{"modules":[{"name","responsibility","entryFile"}]},≤6 个模块,entryFile 是建议路径)。只输出 JSON。这是建议(evidence=suggested),不冒充已存在代码。`;
}
