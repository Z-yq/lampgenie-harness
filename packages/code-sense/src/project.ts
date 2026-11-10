/**
 * 项目状态判定(designs/16 §7 五态)+ 源文件枚举。
 * 确定性:文件计数即可判定。
 */
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export type ProjectState = "EMPTY" | "SEEDLING" | "GROWING" | "MATURE" | "LEGACY";

/** 架构层激活的最小文件数(SEEDLING 上限)。 */
export const SEEDLING_MAX = 10;
/** MATURE 阈值(GROWING 上限);一期固定,大仓标定见 designs/16 §13。 */
export const MATURE_MIN = 50;

/** 源文件扩展名(2026-10-22 P0:补齐 C/C++ 与其它已适配/常见语言)。
 *  旧表缺 .c/.h/.cpp/.hpp 等,导致纯 C/C++ 仓 scan.files 只剩个别 .py,techStack/目录拓扑/
 *  成熟度三处同时失真(saadk_c 280 文件 → `.py×1`、`(根)×1`、SEEDLING)。 */
const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".rs", ".rb", ".php", ".vue", ".html",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx", ".m", ".mm", ".cs", ".kt", ".kts",
  ".scala", ".swift", ".dart", ".lua", ".pl", ".pm", ".ex", ".exs", ".erl", ".hrl",
]);

/** 构建文件(相对路径另存;不混入 techStack 的语言统计,拓扑仍只数源文件)。 */
const BUILD_FILE_NAMES = new Set(["CMakeLists.txt", "Makefile", "makefile", "GNUmakefile", "meson.build", "BUILD", "BUILD.bazel", "WORKSPACE"]);
const BUILD_FILE_EXTS = new Set([".cmake", ".mk", ".bazel"]);

function isBuildFile(name: string): boolean {
  if (BUILD_FILE_NAMES.has(name)) return true;
  const i = name.lastIndexOf(".");
  return i >= 0 && BUILD_FILE_EXTS.has(name.slice(i));
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".pnpm", "vendor", "ref", "coverage", ".venv", "__pycache__",
]);

export interface ProjectScan {
  state: ProjectState;
  sourceFiles: number;
  /** 相对根的源文件列表(截断至 2000,防大仓内存)。 */
  files: string[];
  /** 构建系统文件(CMake/Make/meson/bazel;截断至 200)。加子系统/模块时必须改的那一面。 */
  buildFiles: string[];
}

export async function scanProject(root: string): Promise<ProjectScan> {
  const files: string[] = [];
  const buildFiles: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length > 2000 || depth > 12) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (SOURCE_EXT.has(extOf(e.name))) {
        files.push(relative(root, full));
        if (files.length > 2000) return;
      } else if (isBuildFile(e.name) && buildFiles.length < 200) {
        buildFiles.push(relative(root, full));
      }
    }
  }
  await walk(root, 0);

  const n = files.length;
  let state: ProjectState;
  if (n === 0) state = "EMPTY";
  else if (n <= SEEDLING_MAX) state = "SEEDLING";
  else if (n < MATURE_MIN) state = "GROWING";
  else state = "MATURE";
  // LEGACY:盲区文件存在时由 callgraph 统计升级(一期:非 TS/JS 源文件存在即 LEGACY 候选,
  // 由 adapter 层在解析时精确判定)
  return { state, sourceFiles: n, files, buildFiles };
}

/** 升级为 LEGACY(当存在解析失败/盲区文件时)。 */
export function withBlindspots(scan: ProjectScan, blindspotCount: number): ProjectState {
  if (blindspotCount > 0) return "LEGACY";
  return scan.state;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i);
}
