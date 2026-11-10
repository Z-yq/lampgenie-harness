/**
 * 输入边界防御:
 * ①read guard 顺序——realpath 归一(防 symlink 绕过)→ device/proc → stat special →
 *   denylist → binary(调用方在整读前做 head 探测)→ read;
 * ②单行 2000 字符 clamp(标记「…(+N 字符已截断)」计入额度);
 * ③编辑比例守卫(edit-ratio-guard):new_string 为空或不足 old_string 一半、且删行 > 20 时拒绝,
 *   防「放宽匹配后静默删大段」。
 * 阈值全部集中在本文件常量(便于单测与调参),工具实现只引用不重复写字面量。
 * 守卫**不受 permission mode 影响**:auto(完全访问)只放开路径围栏,不放开设备/管道/伪文件与
 * 「静默删大段」——这两类是进程级风险(读 /dev/zero 挂死、FIFO 永久阻塞、/proc/<pid>/environ 泄密)。
 */
import { promises as fsp, type Stats } from "node:fs";

/** 单行输出上限(字符,含截断标记)。 */
export const MAX_LINE_CHARS = 2000;
/** 编辑比例守卫:new_string 长度下限比例(相对 old_string)。 */
export const EDIT_RATIO_MIN_NEW_RATIO = 0.5;
/** 编辑比例守卫:被删行数阈值(> 该值才进入比例判定)。 */
export const EDIT_RATIO_MIN_DELETED_LINES = 20;
/** 二进制 head 探测字节数(整读之前只嗅探前缀)。 */
export const BINARY_PROBE_BYTES = 8000;

/** 伪文件系统/设备前缀(真实路径按段匹配,`/dev/null` 也不放行:read_file 不做 I/O 重定向)。 */
export const PSEUDO_FS_PREFIXES = ["/proc", "/sys", "/dev", "/run"];
/** 敏感文件 denylist(真实路径 includes 匹配;段都是绝对路径片段,不会误伤项目内同名文件). */
export const READ_DENYLIST = [
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/sudoers",
  "/etc/ssh/ssh_host_",
  "/.ssh/id_rsa",
  "/.ssh/id_ed25519",
  "/.ssh/id_ecdsa",
  "/.aws/credentials",
  "/.kube/config",
  "/.gnupg/",
];

export type ReadGuard =
  | { ok: true; realPath: string; size: number }
  | { ok: false; kind: "missing" }
  | { ok: false; kind: "denied"; reason: string };

/** 统一分隔符(POSIX 运行态下的真实路径已用 "/",Windows 反斜杠归一后仍能做前缀段判定)。 */
function normPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 按路径段判前缀(`/dev` 命中 `/dev/zero`,不误伤 `/devfoo`)。 */
function underPrefix(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(prefix + "/");
}

/** FIFO/socket/字符设备/块设备 → 中文类型名;普通文件/目录返回 null。 */
function specialKind(st: Stats): string | null {
  if (st.isFIFO()) return "FIFO 管道";
  if (st.isSocket()) return "socket";
  if (st.isCharacterDevice()) return "字符设备";
  if (st.isBlockDevice()) return "块设备";
  return null;
}

/**
 * read guard(①②③):调用方在**任何读之前**调用,只拿真实路径与大小。
 * 顺序:realpath 归一 → device/proc → stat special → denylist。
 * 返回 missing 时调用方沿用各自「文件不存在」文案(不吞掉既有的可读错误);denied 时直接把原因给模型。
 * 目录不在此拒(留给调用方的 isFile 判定,保持既有错误文案零漂移)。
 */
export async function readGuardPath(absPath: string): Promise<ReadGuard> {
  let real: string;
  try {
    real = await fsp.realpath(absPath);
  } catch {
    return { ok: false, kind: "missing" };
  }
  const norm = normPath(real);
  // ① 设备/伪文件系统(/dev/zero 会读挂死、/proc/<pid>/environ 泄密)
  for (const prefix of PSEUDO_FS_PREFIXES) {
    if (underPrefix(norm, prefix)) {
      return { ok: false, kind: "denied", reason: `拒绝读取:设备/管道/伪文件系统路径(${norm})` };
    }
  }
  // ② stat special(打开 FIFO 会永久阻塞,open 前必须靠 stat 拦下)
  let st: Stats;
  try {
    st = await fsp.stat(real);
  } catch {
    return { ok: false, kind: "missing" };
  }
  const special = specialKind(st);
  if (special) {
    return { ok: false, kind: "denied", reason: `拒绝读取:设备/管道/伪文件路径(${special}:${norm})` };
  }
  // ③ denylist(系统敏感文件:密钥/凭证/影子口令)
  const hit = READ_DENYLIST.find((d) => norm.includes(d));
  if (hit) {
    return { ok: false, kind: "denied", reason: `拒绝读取:命中敏感文件 denylist(${hit})` };
  }
  return { ok: true, realPath: real, size: Number(st.size) || 0 };
}

/** 只读前缀字节(④binary 探测用):不整读大文件;特殊文件已在 readGuardPath 拦下。 */
export async function readHeadBytes(absPath: string, n: number = BINARY_PROBE_BYTES): Promise<Buffer> {
  const fh = await fsp.open(absPath, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** 二进制启发(空字节探测):与 file-tools.looksBinary 同口径,供两个 read_file 入口共用。 */
export function looksBinaryBytes(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/** code point 安全切片:末端落在代理对中间时回退一位(与 file-tools.safeTruncate 同语义,避免
 *  JSON 序列化出孤立代理被上游 400)。 */function safeSlice(text: string, n: number): string {
  if (n >= text.length) return text;
  if (n <= 0) return "";
  const c = text.charCodeAt(n - 1);
  return text.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/**
 * 单行 clamp:超 MAX_LINE_CHARS 时截断并附「…(+N 字符已截断)」。
 * **标记计入额度**——返回串总长恒 ≤ max(上游模型/面板按行长设限,标记外溢等于没限住)。
 * 两遍算:标记长度取决于 N(位数),先按初值算 keep,再按真实 N 修正。
 */
export function clampLine(text: string, max: number = MAX_LINE_CHARS): string {
  if (text.length <= max) return text;
  let keep = max;
  let out = "";
  for (let i = 0; i < 4; i++) {
    const marker = `…(+${text.length - keep} 字符已截断)`;
    const body = safeSlice(text, Math.max(0, max - marker.length));
    out = body + marker;
    if (body.length === keep) break;
    keep = body.length;
  }
  return out.length <= max ? out : safeSlice(out, max);
}

/** 被删行数:去公共前缀行与后缀行后,old_string 剩余的中间行数(纯函数,便于单测)。 */
export function deletedLineCount(oldStr: string, newStr: string): number {
  const o = oldStr.split("\n");
  const n = newStr.split("\n");
  let p = 0;
  while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let s = 0;
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;
  return o.length - p - s;
}

/**
 * 编辑比例守卫:返回拒绝文案(含 `edit-ratio-guard`)或 null(放行)。
 * 触发条件 = 删行数 > EDIT_RATIO_MIN_DELETED_LINES 且 new_string 长度 < old_string ×
 * EDIT_RATIO_MIN_NEW_RATIO(空串天然命中)。两个条件同时成立才算「放宽匹配后删大段」——
 * 只删几行(≤ 阈值)或 new 仍保留大半内容(改写而非删除)一律放行。
 */
export function checkEditRatio(oldStr: string, newStr: string): string | null {
  if (!oldStr) return null;
  const deleted = deletedLineCount(oldStr, newStr);
  if (deleted <= EDIT_RATIO_MIN_DELETED_LINES) return null;
  const minLen = Math.floor(oldStr.length * EDIT_RATIO_MIN_NEW_RATIO);
  if (newStr.length >= minLen) return null;
  const ratio = oldStr.length ? Math.round((newStr.length / oldStr.length) * 100) : 0;
  return (
    `错误:edit-ratio-guard 拒绝本次编辑——old_string ${oldStr.split("\n").length} 行中删掉 ${deleted} 行` +
    `(阈值 ${EDIT_RATIO_MIN_DELETED_LINES} 行),new_string ${newStr.length}/${oldStr.length} 字符(${ratio}%,` +
    `低于 ${Math.round(EDIT_RATIO_MIN_NEW_RATIO * 100)}%)。疑似放宽匹配后静默删大段:` +
    `若确需大段改写,改用 write_file 整体重写;若只改片段,请把 old_string 收窄到真正要改的部分。`
  );
}
