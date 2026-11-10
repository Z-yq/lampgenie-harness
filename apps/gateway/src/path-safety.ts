/**
 * 路径围栏判定(2026-10-27,Windows 桌面端口径统一)。
 *
 * 背景:面板/IDE 的沙箱检查原先写成 `abs.startsWith(absRoot + "/")` —— POSIX 下成立,
 * Windows 下 realpath 返回反斜杠(`E:\proj\a.ts`),前缀恒不匹配 → 文件读/图片取数/嵌套写
 * 全部被误判「路径越界」(0.0.4 安装包实测:file.read 全 missing、/ide/asset 全 403、
 * file.write 仅项目根一层可写)。
 *
 * 改为 path.relative 判定:按平台分隔符/盘符/UNC 语义比较,Windows 大小写不敏感由
 * node:path 的 win32 实现负责;**不解析符号链接**(调用方先 realpath,本函数只做归属判断)。
 */

import { posix, win32, type PlatformPath } from "node:path";

/** 默认路径方言:Windows 用 win32(接受 `/` 与 `\`,大小写不敏感),其余 POSIX。 */
function defaultPathMod(): PlatformPath {
  return process.platform === "win32" ? win32 : posix;
}

/**
 * child 是否等于 parent 或位于其下(目录归属判定)。
 * - 相等(含尾部分隔符差异)→ true
 * - 跨盘符 / 跨 UNC share / 任何 `..` 逃逸 → false
 * - `..foo` 这类名字以两个点开头的文件 → true(不是逃逸)
 * @param pathMod 注入 path.win32 / path.posix 供跨平台单测;缺省按运行平台。
 */
export function isPathInside(parent: string, child: string, pathMod: PlatformPath = defaultPathMod()): boolean {
  if (!parent || !child) return false;
  const p = trimTrailingSep(parent, pathMod);
  const c = trimTrailingSep(child, pathMod);
  if (p === c) return true;
  const rel = pathMod.relative(p, c);
  if (rel === "") return true;
  if (pathMod.isAbsolute(rel)) return false; // 跨盘符/跨 share:relative 返回绝对路径(必须用同一方言判断)
  // 只按当前方言的分隔符判逃逸(POSIX 下反斜杠是合法文件名字符)
  return !(rel === ".." || rel.startsWith(".." + pathMod.sep));
}

/** 去掉尾部分隔符(保留根 `E:\`、`/`、UNC `\\server\share` 自身)。 */
function trimTrailingSep(p: string, pathMod: PlatformPath): string {
  let s = p;
  while (s.length > 1 && (s.endsWith("/") || s.endsWith("\\"))) {
    const cut = s.slice(0, -1);
    // 根目录剥到空/盘符前缀就停(E:\ → E: 会让 relative 语义变错)
    if (cut === "" || /^[a-zA-Z]:$/.test(cut) || /^[\\/]{2}[^\\/]+$/.test(cut)) break;
    s = cut;
  }
  return s;
}