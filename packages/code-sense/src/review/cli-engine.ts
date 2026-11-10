/**
 * ocr(open-code-review)CLI 子进程评审引擎(二期)。
 * 真实协议(v1.12.13 源码 internal/model/review.go LlmComment + cmd/opencodereview/output.go
 * jsonOutput,并经真二进制实跑验证——首版 NDJSON 假设是错的,对真输出会零命中):
 *   ocr review --format json --audience agent [--commit <sha>|--from <base>]
 *   → stdout = 单一 JSON 信封 {status, llm, message, summary, tool_calls,
 *     comments:[{path, content, existing_code?, start_line, end_line, thinking?, category?, severity?}]};
 *   进度/trace 全在 stderr,JSON 独占 stdout。
 * 映射:severity critical→blocker / high|medium→warning / low→nit(白名单外诚实 warning);
 * existing_code→anchorText(喂 resolver 定位);category→rule。
 * fail-visible:二进制缺失/超时/非零退出抛类型化错误。评审是 LLM agent loop(经验证分钟级),超时默认 15min。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants } from "node:fs";
import type { Finding } from "./index";

const execFileP = promisify(execFile);

/** 二进制缺失/不可执行(detect 不过或竞态消失)。 */
export class CliEngineUnavailable extends Error {
  constructor(message: string, readonly bin: string) {
    super(message);
    this.name = "CliEngineUnavailable";
  }
}

/** 已在位但运行失败(超时被杀/超 maxBuffer/非零退出);stdout 保留给调用方取证。 */
export class CliEngineFailed extends Error {
  constructor(message: string, readonly bin: string, readonly stdout: string) {
    super(message);
    this.name = "CliEngineFailed";
  }
}

/** 探测:bin 含路径分隔符直接查可执行位;否则沿 PATH 逐目录找。零副作用(不真正起进程)。 */
export function detectCli(bin: string): boolean {
  if (!bin) return false;
  if (bin.includes("/")) {
    try {
      accessSync(bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(`${dir}/${bin}`, constants.X_OK);
      return true;
    } catch {
      /* 下一个目录 */
    }
  }
  return false;
}

export interface CliFinding {
  path: string;
  line: number;
  severity: string;
  message: string;
  rule?: string;
  /** ocr existing_code(逐字代码锚,喂 resolver)。 */
  existingCode?: string;
}

/** 评审目标(映射 ocr review 的目标 flags;uncommitted=ocr 默认发现)。 */
export interface CliTarget {
  kind: "uncommitted" | "commit" | "branch";
  /** kind=commit:完整/短 sha。 */
  commit?: string;
  /** kind=branch:基分支(--from,ocr merge-base 语义)。 */
  from?: string;
}

export interface CliEngineOpts {
  timeoutMs?: number;
  maxBufferBytes?: number;
  cwd?: string;
}

function cliArgs(target: CliTarget): string[] {
  const args = ["review", "--format", "json", "--audience", "agent"];
  if (target.kind === "commit" && target.commit) args.push("--commit", target.commit);
  if (target.kind === "branch" && target.from) args.push("--from", target.from);
  return args;
}

/** 运行 CLI 评审:stdout 按 ocr JSON 信封解析。 */
export async function runCliReview(bin: string, target: CliTarget, opts: CliEngineOpts = {}): Promise<CliFinding[]> {
  if (!detectCli(bin)) {
    throw new CliEngineUnavailable(`评审 CLI 不可用: ${bin}(不在 PATH 或不可执行)`, bin);
  }
  let res;
  try {
    res = await execFileP(bin, cliArgs(target), {
      timeout: opts.timeoutMs ?? 15 * 60_000,
      maxBuffer: opts.maxBufferBytes ?? 16 * 1024 * 1024,
      cwd: opts.cwd,
    });
  } catch (err) {
    const e = err as { killed?: boolean; message?: string; stdout?: string };
    throw new CliEngineFailed(
      `评审 CLI 运行失败${e.killed ? "(超时被杀)" : ""}: ${(e.message ?? String(err)).slice(0, 200)}`,
      bin,
      typeof e.stdout === "string" ? e.stdout : "",
    );
  }
  return parseCliOutput(res.stdout ?? "");
}

/** 真实信封结构(ocr v1.12.13 internal/model/review.go LlmComment)。 */
interface OcrComment {
  path?: string;
  content?: string;
  existing_code?: string;
  start_line?: number;
  end_line?: number;
  category?: string;
  severity?: string;
}
interface OcrEnvelope {
  status?: string;
  message?: string;
  comments?: OcrComment[];
}

/** 容错提取:跳过 stdout 里可能的非 JSON 前缀,从首个 { 行起解析整个信封;无 comments 数组=零发现。 */
export function parseCliOutput(stdout: string): CliFinding[] {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("{"));
  if (start < 0) return [];
  let env: OcrEnvelope;
  try {
    env = JSON.parse(lines.slice(start).join("\n")) as OcrEnvelope;
  } catch {
    return [];
  }
  if (!Array.isArray(env.comments)) return [];
  const out: CliFinding[] = [];
  for (const c of env.comments) {
    if (typeof c.path !== "string" || typeof c.content !== "string") continue;
    const line = [c.start_line, c.end_line].find((n) => typeof n === "number" && Number.isFinite(n) && n >= 1);
    out.push({
      path: c.path,
      line: line !== undefined ? Math.trunc(line) : 1,
      severity: typeof c.severity === "string" ? c.severity : "warning",
      message: c.content,
      ...(typeof c.category === "string" && c.category ? { rule: c.category } : {}),
      ...(typeof c.existing_code === "string" && c.existing_code.trim() ? { existingCode: c.existing_code } : {}),
    });
  }
  return out;
}

/** ocr severity 四值(critical|high|medium|low)→ finding 三档;白名单外诚实降 warning。 */
function mapSeverity(s: string): "blocker" | "warning" | "nit" {
  if (s === "critical") return "blocker";
  if (s === "low") return "nit";
  return "warning"; // high/medium/未知
}

/** 逐字锚清洗:全部非空行都带 diff "+" 前缀时剥掉(个别真代码行以 + 开头不动)。 */
function cleanAnchor(code: string): string {
  const lines = code.split("\n").filter((l) => l.trim());
  if (lines.length && lines.every((l) => l.startsWith("+"))) {
    return lines.map((l) => l.slice(1)).join("\n");
  }
  return code;
}

/** CLI 发现 → 统一 Finding(existing_code→anchorText 进 resolver 定位链)。 */
export function toFindings(finds: CliFinding[]): (Finding & { source: "cli" })[] {
  return finds.map((f) => ({
    file: f.path,
    line: Number.isFinite(f.line) && f.line >= 1 ? Math.trunc(f.line) : 1,
    severity: mapSeverity(f.severity),
    title: f.rule ?? "cli",
    detail: f.message,
    ...(f.existingCode ? { anchorText: cleanAnchor(f.existingCode) } : {}),
    source: "cli" as const,
  }));
}
