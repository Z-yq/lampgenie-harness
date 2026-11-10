/**
 * 格式化:优先 LSP textDocument/formatting,兜底本机 formatter 命令,
 * 都不可用=跳过(fail-soft,不写文件)。
 * 本机 formatter 从 stdin 读、stdout 写,不落临时文件。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { findExecutable, type LanguageFamily } from "./servers.js";

export interface FormatOutcome {
  text: string;
  via: "lsp" | "black" | "prettier" | "gofmt";
}

interface Position { line: number; character: number }
export interface LspTextEdit {
  range: { start: Position; end: Position };
  newText: string;
}

/**
 * 应用 LSP TextEdit[](位置为 0-based UTF-16;倒序应用防偏移)。
 * 非法/越界编辑被夹紧;重叠按倒序结果保留(server 的正常输出不重叠)。
 */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  if (!Array.isArray(edits) || edits.length === 0) return text;
  const offsetAt = (pos: Position): number => {
    const line = Math.max(0, Math.trunc(Number(pos?.line) || 0));
    const char = Math.max(0, Math.trunc(Number(pos?.character) || 0));
    const lines = text.split("\n");
    let offset = 0;
    for (let i = 0; i < line && i < lines.length; i++) offset += lines[i]!.length + 1;
    const lineText = lines[line] ?? "";
    return Math.min(offset + char, offset + lineText.length);
  };
  const sorted = [...edits].sort((a, b) => {
    const sa = offsetAt(a.range.start), sb = offsetAt(b.range.start);
    return sb - sa;
  });
  let out = text;
  let boundary = out.length;
  for (const e of sorted) {
    const start = offsetAt(e.range.start);
    const end = offsetAt(e.range.end);
    if (start > boundary) continue; // 交叠编辑:保留先应用(靠后)的那条
    out = out.slice(0, start) + String(e.newText ?? "") + out.slice(end);
    boundary = start;
  }
  return out;
}

/** 本机命令兜底;返回格式化文本,无 formatter/失败/超时=null。 */
export async function externalFormat(input: {
  text: string;
  absPath: string;
  root: string;
  family: LanguageFamily;
  timeoutMs: number;
}): Promise<FormatOutcome | null> {
  const cmd = formatterFor(input.family, input.absPath);
  if (!cmd) return null;
  const out = await runFormatter(cmd.command, cmd.args, input.text, input.root, input.timeoutMs);
  if (out === null) return null;
  return { text: out, via: cmd.via };
}

function formatterFor(family: LanguageFamily, absPath: string): { command: string; args: string[]; via: FormatOutcome["via"] } | null {
  if (family === "py") {
    const exe = findExecutable("black");
    return exe ? { command: exe, args: ["--quiet", "-"], via: "black" } : null;
  }
  if (family === "go") {
    const exe = findExecutable("gofmt");
    return exe ? { command: exe, args: [], via: "gofmt" } : null;
  }
  const exe = findExecutable("prettier");
  return exe ? { command: exe, args: ["--stdin-filepath", absPath], via: "prettier" } : null;
}

function runFormatter(command: string, args: string[], text: string, cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let stdout = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessWithoutNullStreams;
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      done(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += c.toString("utf8");
    });
    child.stderr.on("data", () => { /* formatter 报错统一按失败处理,不向上冒泡 */ });
    child.on("error", () => done(null));
    child.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) return done(null);
      done(stdout);
    });
    try { child.stdin.end(text); } catch { done(null); }
  });
}
