/**
 * wire 扫描器:纯 fs 行/结构扫描。不读索引、不调 LLM、不写盘。
 * 扫描面(固定,见 WIRE_PATHS):
 *   协议声明  packages/protocol/src/index.ts  (z.discriminatedUnion + Envelope.extend)
 *   服务端    apps/gateway/src/server.ts       (switch (msg.type) 的 case,含 fallthrough)
 *   客户端    apps/gateway/src/panel.ts + assets/*.js  (发送调用 + 接收分支)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type {
  WireChangedInfo, WireHandler, WireOrphans, WireReceive, WireScanOptions, WireScanResult,
  WireSend, WireTypeRow, WireUnion, WireUnionKind, WireUnionMember, WireUnresolvedMember,
} from "./types.js";

export const WIRE_PATHS = {
  protocol: "packages/protocol/src/index.ts",
  server: "apps/gateway/src/server.ts",
  panel: "apps/gateway/src/panel.ts",
  assetsDir: "apps/gateway/src/assets",
} as const;

/** vendor/无 WS 协议面的静态资源不扫(minified 第三方代码只会制造噪声)。 */
const ASSET_EXCLUDE = new Set(["mermaid.min.js", "sw.js"]);

const KNOWN_LIMITS: string[] = [
  "扫描面固定:packages/protocol/src/index.ts + server.ts + panel.ts + assets/*.js;新增协议文件/其它分派文件不在面内。",
  "只认字面量:z.literal(\"...\") / type: \"...\" / case \"...\";动态 type(变量拼接、type: msg.type)不识别。",
  "服务端 handler 只认 switch (msg.type) 内的 case;if/else 分派或其它文件里的处理不计为 handler。",
  "发送点只认以 send/Send 结尾的调用(wsSafeSend/sendOrQueue/dashWsSend/termSend/send/ws.send)且实参含 type 字面量;普通 send 必须自带 v: 1,XxxSend 包装器不要求;先构造对象再 send(obj) 的变量中转,以及 type: lazy[sec] 这类动态值不识别。",
  "接收分支只认 m/msg/message.type === \"...\" 与 switch (...type) 的 case;e.kind/payload.type 等其它判别式不计。",
  "assets 只扫 *.js(排除 mermaid.min.js/sw.js);其它客户端/desktop/voice 的发送不计入「客户端发送点」。",
  "D 类(声明但面板不发送)是提示级:node-agent、desktop 或其它客户端可能发送,不必然是缺陷。",
  "--changed 按 type 字面量集合做 diff(z.literal(\"...\") / type: \"...\" / case \"...\":),不做声明标识符收集——union 成员数组行本身含全部声明名,收集它们会让任意一次协议改动报满整条 union。只对比 git HEAD 工作区 diff 与未跟踪文件;历史提交、被 .gitignore 的文件、字面量未变的字段级改动不会命中。",
  "协议 union/handler 结构扫描会屏蔽注释与字符串;发送/接收面按文本行扫描,字符串里的伪调用仍可能被计入(本仓实测未见)。",
];

// ---- 基础工具 ----

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function relPath(root: string, abs: string): string {
  return toPosix(relative(root, abs));
}

function readText(root: string, rel: string): string | null {
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function isCommentOnly(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/");
}

function isIgnorable(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/");
}

function stripCommentsOnly(text: string): string {
  const out = text.split("");
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    const nx = text[i + 1];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "/" && nx === "/") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && nx === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < text.length) {
        if (text[i] === "*" && text[i + 1] === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          break;
        }
        if (text[i] !== "\n") out[i] = " ";
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 结构扫描用:注释与字符串内容都替换为空格(保留换行,长度不变)。 */
function maskStructure(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const nx = text[i + 1];
    if (ch === "/" && nx === "/") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && nx === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < text.length) {
        if (text[i] === "*" && text[i + 1] === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          break;
        }
        if (text[i] !== "\n") out[i] = " ";
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      out[i] = " ";
      i++;
      while (i < text.length) {
        const c = text[i]!;
        if (c === "\\") {
          out[i] = " ";
          if (i + 1 < text.length && text[i + 1] !== "\n") out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (c === q) {
          out[i] = " ";
          i++;
          break;
        }
        if (c !== "\n") out[i] = " ";
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 从 openIndex 的开放符号找到匹配闭合符号;跳过字符串/注释。 */
function findMatching(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]!;
    const nx = text[i + 1];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && nx === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && nx === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切分(忽略字符串/注释与嵌套括号)。 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    const nx = body[i + 1];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && nx === "/") {
      while (i < body.length && body[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && nx === "*") {
      i += 2;
      while (i < body.length && !(body[i] === "*" && body[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function stripComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ").trim();
}

function firstTypeLiteral(text: string): { type: string; index: number } | null {
  // discriminatedUnion 的判别键既有 type(WS 消息)也有 kind(AnnotateNoteZ 形态);
  // 两种都算内联成员,避免新协议 union 被记成 unresolved。
  const m = /\b(?:type|kind)\s*:\s*z\.literal\(\s*(["'])([^"']+)\1\s*\)/.exec(text);
  if (!m) return null;
  return { type: m[2]!, index: m.index };
}

function unionKind(name: string): WireUnionKind {
  const lower = name.toLowerCase();
  if (lower.includes("client")) return "client";
  if (lower.includes("server")) return "server";
  return "unknown";
}

// ---- 协议声明 ----

interface ProtocolDecl {
  name: string;
  type: string;
  file: string;
  line: number;
  typeLine: number;
}

interface ProtocolScan {
  file: string;
  unions: WireUnion[];
  decls: Map<string, ProtocolDecl>;
  unresolved: WireUnresolvedMember[];
}

function scanProtocol(root: string): ProtocolScan | null {
  const text = readText(root, WIRE_PATHS.protocol);
  if (text === null) return null;
  const file = WIRE_PATHS.protocol;
  const masked = maskStructure(text);
  const decls = new Map<string, ProtocolDecl>();

  // 先收声明:export const Name = Envelope.extend(...)
  const declRe = /export\s+const\s+(\w+)\s*=\s*Envelope\.extend\s*\(/g;
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(masked)) !== null) {
    const open = masked.indexOf("(", dm.index + dm[0].length - 1);
    if (open < 0) continue;
    const close = findMatching(masked, open, "(", ")");
    if (close < 0) continue;
    const span = text.slice(open + 1, close);
    const t = firstTypeLiteral(span);
    if (!t) continue;
    const typeIndex = open + 1 + t.index;
    decls.set(dm[1]!, {
      name: dm[1]!,
      type: t.type,
      file,
      line: lineAt(text, dm.index),
      typeLine: lineAt(text, typeIndex),
    });
  }

  // 再收 union
  const unions: WireUnion[] = [];
  const unresolved: WireUnresolvedMember[] = [];
  const unionRe = /(?:export\s+)?const\s+(\w+)\s*=\s*z\.discriminatedUnion\s*\(/g;
  let um: RegExpExecArray | null;
  while ((um = unionRe.exec(masked)) !== null) {
    const openBracket = masked.indexOf("[", um.index);
    if (openBracket < 0) continue;
    const closeBracket = findMatching(masked, openBracket, "[", "]");
    if (closeBracket < 0) continue;
    const unionName = um[1]!;
    const body = text.slice(openBracket + 1, closeBracket);
    const members: WireUnionMember[] = [];
    for (const raw of splitTopLevel(body)) {
      const cleaned = stripComments(raw);
      if (!cleaned) continue;
      const ident = /^([A-Za-z_$][\w$]*)$/.exec(cleaned);
      if (ident) {
        const d = decls.get(ident[1]!);
        if (!d) {
          unresolved.push({ union: unionName, text: cleaned.slice(0, 120), line: lineAt(text, openBracket) });
          continue;
        }
        members.push({ type: d.type, declName: d.name, file, line: d.typeLine, inline: false });
        continue;
      }
      const t = firstTypeLiteral(cleaned);
      if (t) {
        const rawIndex = Math.max(0, body.indexOf(raw));
        const local = firstTypeLiteral(raw);
        const typeAt = rawIndex + (local ? local.index : 0);
        members.push({
          type: t.type,
          file,
          line: lineAt(text, openBracket + 1 + typeAt),
          inline: true,
        });
        continue;
      }
      const rawIndex = body.indexOf(raw);
      unresolved.push({
        union: unionName,
        text: cleaned.slice(0, 120),
        line: lineAt(text, openBracket + 1 + Math.max(0, rawIndex)),
      });
    }
    unions.push({
      name: unionName,
      kind: unionKind(unionName),
      file,
      line: lineAt(text, um.index),
      members,
    });
    unionRe.lastIndex = Math.max(unionRe.lastIndex, closeBracket + 1);
  }

  return { file, unions, decls, unresolved };
}

// ---- 服务端 handler ----

interface CaseEntry {
  type: string;
  line: number;
  lineIndex: number;
  afterColon: string;
}

function scanHandlers(root: string): WireHandler[] {
  const text = readText(root, WIRE_PATHS.server);
  if (text === null) return [];
  const file = WIRE_PATHS.server;
  const lines = text.split("\n");
  const handlers: WireHandler[] = [];

  // 定位 switch (msg.type) 块:按缩进找同层的闭合 `}`(不依赖花括号计数,
  // 避免正则字面量/模板字符串里的 { } 把结构扫描带偏)。找不到=退化全文件 case。
  let startLine = 0;
  let endLine = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s*switch\s*\(\s*(?:msg|m|message|data|payload)\.type\s*\)\s*\{/.test(line)) continue;
    const indent = (line.match(/^\s*/)?.[0] ?? "").length;
    startLine = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === "}" && (l.match(/^\s*/)?.[0] ?? "").length <= indent) {
        endLine = j;
        break;
      }
    }
    break;
  }

  const entries: CaseEntry[] = [];
  for (let i = startLine; i <= endLine && i < lines.length; i++) {
    const orig = lines[i]!;
    const cm = /^\s*case\s+(["'])([^"']+)\1\s*:/.exec(orig);
    if (!cm) continue;
    entries.push({ type: cm[2]!, line: i + 1, lineIndex: i, afterColon: orig.slice(cm[0].length) });
  }

  const isIgnorableBetween = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) if (!isIgnorable(lines[i] ?? "")) return false;
    return true;
  };
  const afterIsEmpty = (e: CaseEntry): boolean => {
    const a = e.afterColon.trim();
    return a === "" || a.startsWith("//") || a.startsWith("/*") || a.startsWith("*");
  };

  let k = 0;
  while (k < entries.length) {
    let end = k;
    while (end + 1 < entries.length) {
      const cur = entries[end]!;
      const next = entries[end + 1]!;
      if (!afterIsEmpty(cur)) break;
      if (!isIgnorableBetween(cur.lineIndex + 1, next.lineIndex)) break;
      end++;
    }
    const group = entries.slice(k, end + 1).map((e) => e.type);
    const handlerLine = entries[end]!.line;
    for (const e of entries.slice(k, end + 1)) {
      handlers.push({ type: e.type, file, line: e.line, handlerLine, group });
    }
    k = end + 1;
  }
  return handlers;
}

// ---- 客户端发送/接收 ----

function clientFiles(root: string): string[] {
  const files: string[] = [];
  if (existsSync(join(root, WIRE_PATHS.panel))) files.push(WIRE_PATHS.panel);
  const assetsAbs = join(root, WIRE_PATHS.assetsDir);
  if (existsSync(assetsAbs)) {
    try {
      for (const name of readdirSync(assetsAbs).sort()) {
        if (!name.endsWith(".js") || ASSET_EXCLUDE.has(name)) continue;
        files.push(`${WIRE_PATHS.assetsDir}/${name}`);
      }
    } catch {
      /* 目录不可读=如实缺席 */
    }
  }
  return files;
}

function scanSends(root: string, files: string[]): WireSend[] {
  const sends: WireSend[] = [];
  for (const file of files) {
    const text = readText(root, file);
    if (text === null) continue;
    const lines = text.split("\n");
    const stripped = stripCommentsOnly(text);
    const re = /\b(?:ws\.send|sendOrQueue|([A-Za-z_$][\w$]*[sS]end))\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const name = m[1] ?? (m[0].startsWith("sendOrQueue") ? "sendOrQueue" : "ws.send");
      const before = stripped.slice(Math.max(0, m.index - 24), m.index);
      if (/\bfunction\s*$/.test(before)) continue;
      const open = m.index + m[0].length - 1;
      const close = findMatching(text, open, "(", ")");
      if (close < 0) continue;
      const call = text.slice(m.index, close + 1);
      // 普通 send 必须自带 v: 1;XxxSend 包装器(termSend 等)在函数体内补 v,只认 type 字面量。
      const wrapperName = /Send$/.test(name) && name !== "send";
      if (!wrapperName && !/\bv\s*:\s*1\b/.test(call)) continue;
      const typeMatch = /\btype\s*:\s*(["'])([^"']+)\1/.exec(call);
      if (!typeMatch) continue;
      const typeRel = call.indexOf(typeMatch[0]);
      if (typeRel < 0) continue;
      const typeLine = lineAt(text, m.index + typeRel);
      const lineText = (lines[typeLine - 1] ?? "").trimStart();
      if (lineText.startsWith("//")) continue;
      sends.push({ type: typeMatch[2]!, file, line: typeLine, call: name });
    }
  }
  return sends;
}

function scanReceives(root: string, files: string[]): WireReceive[] {
  const receives: WireReceive[] = [];
  for (const file of files) {
    const text = readText(root, file);
    if (text === null) continue;
    const lines = text.split("\n");
    const eqRe = /\b(?:m|msg|message)\.type\s*===\s*(["'])([^"']+)\1/g;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isCommentOnly(line)) continue;
      eqRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = eqRe.exec(line)) !== null) {
        receives.push({ type: m[2]!, file, line: i + 1, form: "if" });
      }
    }

    // switch (X.type) 形态(当前仓没有,保留能力;只认消息对象判别式)
    const switchRe = /\bswitch\s*\(\s*((?:m|msg|message|payload|data)\.type)\s*\)\s*\{/g;
    let sm: RegExpExecArray | null;
    while ((sm = switchRe.exec(text)) !== null) {
      const open = text.indexOf("{", sm.index + sm[0].length - 1);
      const close = open >= 0 ? findMatching(text, open, "{", "}") : -1;
      if (close < 0) continue;
      const from = lineAt(text, open);
      const to = lineAt(text, close);
      for (let i = from - 1; i < to && i < lines.length; i++) {
        const cm = /^\s*case\s+(["'])([^"']+)\1\s*:/.exec(lines[i]!);
        if (cm) receives.push({ type: cm[2]!, file, line: i + 1, form: "case", discriminator: sm[1] });
      }
    }
  }
  return receives;
}

// ---- git --changed ----

function runGit(root: string, args: string[]): { ok: boolean; out: string; error?: string } {
  try {
    const out = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (e) {
    const err = e as { message?: string; stdout?: string; stderr?: string };
    return { ok: false, out: "", error: (err.stderr || err.message || String(e)).trim().slice(0, 400) };
  }
}

function relevantRel(rel: string): boolean {
  const p = toPosix(rel);
  return p === WIRE_PATHS.protocol || p === WIRE_PATHS.server || p === WIRE_PATHS.panel || p.startsWith(WIRE_PATHS.assetsDir + "/");
}

/** 只收 type 字面量三种形态(z.literal / type: / case),**不做大写标识符收集**。
 * 旧实现按 changed 行收集 decls 里的大写标识符:union 成员数组行(如 `[Ping, TrackView, ...]`)
 * 本身包含全部声明名,任何一次协议改动都会把整条 union 报成 changed(经验证 153 types)。 */
function typeLiteralsIn(text: string): string[] {
  const out = new Set<string>();
  const zRe = /\bz\.literal\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
  const typeRe = /\btype\s*:\s*(["'])([^"'\\\n]+)\1/g;
  const caseRe = /\bcase\s+(["'])([^"'\\\n]+)\1\s*:/g;
  for (const line of text.split("\n")) {
    if (isCommentOnly(line)) continue;
    let m: RegExpExecArray | null;
    zRe.lastIndex = 0;
    while ((m = zRe.exec(line)) !== null) out.add(m[2]!);
    typeRe.lastIndex = 0;
    while ((m = typeRe.exec(line)) !== null) out.add(m[2]!);
    caseRe.lastIndex = 0;
    while ((m = caseRe.exec(line)) !== null) out.add(m[2]!);
  }
  return [...out];
}

/** HEAD 版本文件内容;文件在 HEAD 不存在(新增/未跟踪)→ null(按空集处理)。 */
function gitShow(root: string, rel: string): string | null {
  const r = runGit(root, ["show", `HEAD:${rel}`]);
  return r.ok ? r.out : null;
}

function scanChanged(root: string, knownTypes: Set<string>): WireChangedInfo {
  const status = runGit(root, ["status", "--porcelain"]);
  if (!status.ok) {
    return {
      enabled: true,
      files: [],
      types: [],
      added: [],
      removed: [],
      touched: [],
      gitError: status.error ?? "git status 失败",
      filtered: false,
      note: "git 不可用或当前目录不是 git 仓:--changed 已降级为全量展示",
    };
  }
  const files: string[] = [];
  const untracked = new Set<string>();
  for (const raw of status.out.split("\n")) {
    if (!raw.trim()) continue;
    let p = raw.slice(3).trim();
    if (p.includes(" -> ")) p = p.slice(p.lastIndexOf(" -> ") + 4);
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1);
    p = toPosix(p);
    if (!p) continue;
    files.push(p);
    if (raw.startsWith("??")) untracked.add(p);
  }

  // ① 逐文件做「HEAD 字面量集合 ↔ 工作区字面量集合」diff。文件未改动时两集合相等,
  //    不做 diff 行的启发式猜测——这是精度修复的核心(旧实现按 changed 行收集标识符)。
  const addedRaw = new Set<string>();
  const removedRaw = new Set<string>();
  for (const p of files) {
    if (!relevantRel(p)) continue;
    const workText = readText(root, p);
    const workSet = new Set(workText === null ? [] : typeLiteralsIn(workText));
    const headText = untracked.has(p) ? null : gitShow(root, p);
    const headSet = new Set(headText === null ? [] : typeLiteralsIn(headText));
    for (const t of workSet) if (!headSet.has(t)) addedRaw.add(t);
    for (const t of headSet) if (!workSet.has(t)) removedRaw.add(t);
  }

  // ② touched:两版都存在、且出现在 diff 增删行上的字面量(字段级改动若没动字面量所在行,
  //    不算 touched——已知边界里如实说明)。
  const touchedRaw = new Set<string>();
  const diffPaths = [WIRE_PATHS.protocol, WIRE_PATHS.server, WIRE_PATHS.panel, WIRE_PATHS.assetsDir]
    .filter((p) => existsSync(join(root, p)));
  let diff = runGit(root, ["diff", "HEAD", "--no-color", "--unified=0", "--", ...diffPaths]);
  let diffNote: string | undefined;
  if (!diff.ok) {
    diff = runGit(root, ["diff", "--no-color", "--unified=0", "--", ...diffPaths]);
    diffNote = "git HEAD 不可用,已退化为工作区 diff(暂存区改动可能遗漏)";
  }
  if (diff.ok) {
    for (const line of diff.out.split("\n")) {
      if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
      const body = line.slice(1);
      if (isCommentOnly(body)) continue;
      for (const t of typeLiteralsIn(body)) touchedRaw.add(t);
    }
  }

  // ③ 与当前 wire 面已知 type 对账:added/touched 必须能在结构面找到归属(协议 union 成员 /
  //    handler / 发送 / 接收),否则只是 wire 文件里的无关字符串。removed 已不在当前协议里,
  //    无法用结构面复核,按字面量差集如实列出(已知边界说明)。
  const added = [...addedRaw].filter((t) => knownTypes.has(t)).sort();
  const touched = [...touchedRaw]
    .filter((t) => !addedRaw.has(t) && !removedRaw.has(t) && knownTypes.has(t))
    .sort();
  const removed = [...removedRaw].sort();
  const types = [...new Set([...added, ...removed, ...touched])].sort();

  const note = diff.ok ? diffNote : "git diff 失败,仅用 git status/未跟踪文件;结果可能不完整";
  return {
    enabled: true,
    files,
    types,
    added,
    removed,
    touched,
    filtered: true,
    ...(note ? { note } : {}),
  };
}

// ---- 对账与组装 ----

function buildRows(
  unions: WireUnion[],
  handlers: WireHandler[],
  sends: WireSend[],
  receives: WireReceive[],
): { rows: WireTypeRow[]; orphans: WireOrphans } {
  const unionTypeSet = new Set<string>();
  const clientTypes = new Map<string, { file: string; line: number }>();
  for (const u of unions) {
    for (const m of u.members) {
      unionTypeSet.add(m.type);
      if (u.kind === "client" && !clientTypes.has(m.type)) clientTypes.set(m.type, { file: m.file, line: m.line });
    }
  }

  const handlerByType = new Map<string, WireHandler[]>();
  for (const h of handlers) {
    const arr = handlerByType.get(h.type) ?? [];
    arr.push(h);
    handlerByType.set(h.type, arr);
  }
  const sendByType = new Map<string, WireSend[]>();
  for (const s of sends) {
    const arr = sendByType.get(s.type) ?? [];
    arr.push(s);
    sendByType.set(s.type, arr);
  }
  const recvByType = new Map<string, WireReceive[]>();
  for (const r of receives) {
    const arr = recvByType.get(r.type) ?? [];
    arr.push(r);
    recvByType.set(r.type, arr);
  }

  const allTypes = new Set<string>([...unionTypeSet, ...handlerByType.keys(), ...sendByType.keys(), ...recvByType.keys()]);
  const rows: WireTypeRow[] = [];
  for (const type of [...allTypes].sort()) {
    const us = unions
      .filter((u) => u.members.some((m) => m.type === type))
      .map((u) => ({ name: u.name, kind: u.kind, file: u.file, line: u.line }));
    const declaredAt = unions.flatMap((u) => u.members.filter((m) => m.type === type).map((m) => ({ file: m.file, line: m.line })));
    const hs = handlerByType.get(type) ?? [];
    const ss = sendByType.get(type) ?? [];
    const rs = recvByType.get(type) ?? [];
    let status: WireTypeRow["status"] = "ok";
    if (us.length === 0) status = "orphan:undeclared";
    else if (clientTypes.has(type) && hs.length === 0) status = "orphan:no-handler";
    else if (clientTypes.has(type) && ss.length === 0) status = "hint:never-sent";
    rows.push({ type, unions: us, declaredAt, handlers: hs, sends: ss, receives: rs, status });
  }

  const handlerTypes = new Set(handlers.map((h) => h.type));
  const sendTypes = new Set(sends.map((s) => s.type));
  const declaredNoHandler = [...clientTypes.entries()]
    .filter(([t]) => !handlerTypes.has(t))
    .map(([type, loc]) => ({ type, file: loc.file, line: loc.line }))
    .sort((a, b) => a.type.localeCompare(b.type));
  const handlerUndeclared = handlers.filter((h) => !unionTypeSet.has(h.type));
  const sendUndeclared = sends.filter((s) => !unionTypeSet.has(s.type));
  const declaredNeverSent = [...clientTypes.entries()]
    .filter(([t]) => !sendTypes.has(t))
    .map(([type, loc]) => ({ type, file: loc.file, line: loc.line }))
    .sort((a, b) => a.type.localeCompare(b.type));
  const receiveUndeclared = receives.filter((r) => !unionTypeSet.has(r.type));

  return {
    rows,
    orphans: { declaredNoHandler, handlerUndeclared, sendUndeclared, declaredNeverSent, receiveUndeclared },
  };
}

export function scanWire(rootInput: string, opts: WireScanOptions = {}): WireScanResult {
  const root = resolve(rootInput);
  const protocol = scanProtocol(root);
  const unions = protocol?.unions ?? [];
  const handlers = scanHandlers(root);
  const files = clientFiles(root);
  const sends = scanSends(root, files);
  const receives = scanReceives(root, files);
  const { rows, orphans } = buildRows(unions, handlers, sends, receives);

  const changed = opts.changed ? scanChanged(root, new Set(rows.map((r) => r.type))) : undefined;
  const filterSet = changed && changed.filtered ? new Set(changed.types) : null;
  const filteredRows = filterSet ? rows.filter((r) => filterSet.has(r.type)) : rows;
  const filteredOrphans: WireOrphans = filterSet
    ? {
        declaredNoHandler: orphans.declaredNoHandler.filter((o) => filterSet.has(o.type)),
        handlerUndeclared: orphans.handlerUndeclared.filter((o) => filterSet.has(o.type)),
        sendUndeclared: orphans.sendUndeclared.filter((o) => filterSet.has(o.type)),
        declaredNeverSent: orphans.declaredNeverSent.filter((o) => filterSet.has(o.type)),
        receiveUndeclared: orphans.receiveUndeclared.filter((o) => filterSet.has(o.type)),
      }
    : orphans;

  const unresolved = protocol?.unresolved ?? [];
  const knownLimits = [...KNOWN_LIMITS];
  if (!protocol) knownLimits.push(`协议文件缺席: ${WIRE_PATHS.protocol}(声明面对账为空)`);
  if (!existsSync(join(root, WIRE_PATHS.server))) knownLimits.push(`服务端文件缺席: ${WIRE_PATHS.server}(handler 面对账为空)`);
  if (unresolved.length > 0) knownLimits.push(`union 有 ${unresolved.length} 个成员未能解析为 type 字面量(见 unresolved,不猜)`);
  if (changed?.gitError) knownLimits.push(`--changed 降级: ${changed.gitError}`);

  // --changed 生效时 stats 也按过滤后的集合计算(旧口径:type 表已过滤,stats 仍是全量
  // 151/265/125,读起来像「改了这么多」——诚实性缺陷)。
  const keptHandlers = filterSet ? handlers.filter((h) => filterSet.has(h.type)) : handlers;
  const keptSends = filterSet ? sends.filter((s) => filterSet.has(s.type)) : sends;
  const keptReceives = filterSet ? receives.filter((r) => filterSet.has(r.type)) : receives;
  const keptUnions = filterSet ? unions.filter((u) => u.members.some((m) => filterSet.has(m.type))) : unions;
  const memberships = keptUnions.reduce(
    (n, u) => n + (filterSet ? u.members.filter((m) => filterSet.has(m.type)).length : u.members.length),
    0);
  return {
    query: "wire",
    root,
    protocolFiles: protocol ? [protocol.file] : [],
    unions,
    handlers,
    sends,
    receives,
    types: filteredRows,
    orphans: filteredOrphans,
    ...(changed ? { changed } : {}),
    stats: {
      unions: keptUnions.length,
      memberships,
      uniqueTypes: filteredRows.length,
      handlers: keptHandlers.length,
      sends: keptSends.length,
      receives: keptReceives.length,
      orphanDeclaredNoHandler: filteredOrphans.declaredNoHandler.length,
      orphanHandlerUndeclared: filteredOrphans.handlerUndeclared.length,
      orphanSendUndeclared: filteredOrphans.sendUndeclared.length,
      orphanDeclaredNeverSent: filteredOrphans.declaredNeverSent.length,
      orphanReceiveUndeclared: filteredOrphans.receiveUndeclared.length,
    },
    unresolved,
    knownLimits,
  };
}
