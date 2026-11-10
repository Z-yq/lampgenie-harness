/**
 * 自定义命令仓库(step-047 起,2026-10 ZCode 语义补全)。
 *
 * 语义来源(照搬,不自创):
 * - ZCode/apps/zcode-cli/packages/adapters/src/commands/roots.ts —— 多根 + priority(每级差 10)。
 * - ZCode/apps/zcode-cli/packages/adapters/src/commands/index.ts —— 递归扫描(≤12 层)、
 *   `dir/name.md → dir:name` 命名空间、frontmatter 扁平 YAML、名称正则、诊断、100KB 上限。
 * - ZCode/apps/zcode-cli/packages/contracts/src/commands/index.ts:114-186 —— 占位符
 *   ($ARGUMENTS / $1..$n)由面板/执行层展开,本仓库只负责「名字 + 正文 + 元数据」的发现与读写。
 *
 * 红线:
 * - 名称白名单 + 路径穿越拦截(upsert/remove 只写 project 根)。
 * - 无缓存:每次 list() 重扫磁盘(ZCode 同款,文件改动即时可见;代价是目录遍历,量级 <百文件)。
 * - 内置命令名是权威保留集(command-catalog.RESERVED_COMMAND_NAMES):自定义同名只给 warning
 *   诊断并剔除,不覆盖内置(否则内置 /help 之类会被莫名劫持)。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RESERVED_COMMAND_NAMES } from "./command-catalog.js";

export type CustomCommandSource = "project" | "user";

/** 一个命令根目录。priority 越大越优先(同名冲突时高 priority 赢);ZCode 每级差 10。 */
export interface CommandRoot {
  dir: string;
  priority: number;
  /** 显式来源标记;缺省按目录位置推断(home 下 → user,其余 → project)。 */
  source?: CustomCommandSource;
}

export interface CustomCommand {
  name: string;
  body: string;
  description?: string;
  /** frontmatter `argument-hint`:输入框占位提示。 */
  inputHint?: string;
  allowedTools?: string[];
  model?: string;
  /** frontmatter `disable-noninteractive`(非交互场景禁用该命令)。 */
  disableNonInteractive?: boolean;
  /** frontmatter `skills`:执行前需要加载的技能名。 */
  skills?: string[];
  /** 源文件绝对路径(诊断/审计用)。 */
  path?: string;
  source: CustomCommandSource;
}

export interface CommandDiagnostic {
  path: string;
  severity: "warning" | "error";
  message: string;
  /** 机器可读的小分类(ZCode 的 code 字段,便于前端按类过滤)。 */
  code?: string;
  commandName?: string;
}

export interface CommandListOutcome {
  commands: CustomCommand[];
  diagnostics: CommandDiagnostic[];
}

export interface UpsertOptions {
  description?: string;
  inputHint?: string;
  allowedTools?: string[];
  model?: string;
}

const COMMAND_EXTENSION = ".md";
/** ZCode 名称正则:小写字母/数字开头,允许 - _ 单个冒号(命名空间),≤64 字符。 */
const NAME_RE = /^[a-z0-9][a-z0-9_:-]{0,63}$/;
const MAX_COMMAND_BYTES = 100_000;
const MAX_SCAN_DEPTH = 12;
/** 无 description 时取正文首个非空行,截断长度。 */
const MAX_DESCRIPTION_LENGTH = 200;
const PRIORITY_STEP = 10;
const HOME_COMMANDS_SUFFIX = join(".genie", "commands");

/** 默认真源:user 根(home)+ project 根(仓库根),project 优先(每级差 10)。 */
export function defaultCommandRoots(options: {
  repoRoot: string;
  home?: string;
}): CommandRoot[] {
  const home = options.home ?? homedir();
  const roots: CommandRoot[] = [];
  if (home) roots.push({ dir: join(home, HOME_COMMANDS_SUFFIX), priority: PRIORITY_STEP, source: "user" });
  roots.push({ dir: join(options.repoRoot, ".genie", "commands"), priority: PRIORITY_STEP * 2, source: "project" });
  return roots;
}

function inferSource(dir: string): CustomCommandSource {
  const home = homedir();
  if (!home) return "project";
  const userCommands = resolve(join(home, HOME_COMMANDS_SUFFIX));
  const target = resolve(dir);
  return target === userCommands || target.startsWith(userCommands + sep) ? "user" : "project";
}

export class CommandStore {
  private readonly roots: CommandRoot[];

  /** 兼容旧构造:单层 `.genie/commands` 目录(等价于一个 project 根)。 */
  constructor(dir: string);
  constructor(roots: CommandRoot[]);
  constructor(dirOrRoots: string | CommandRoot[]) {
    const list: CommandRoot[] =
      typeof dirOrRoots === "string"
        ? [{ dir: dirOrRoots, priority: 0 }]
        : dirOrRoots.map((r) => ({ ...r }));
    this.roots = list.map((r) => ({ ...r, dir: resolve(r.dir), source: r.source ?? inferSource(r.dir) }));
  }

  /** 语义更清楚的构造入口(app.ts 用两个根:user + project)。 */
  static fromRoots(roots: CommandRoot[]): CommandStore {
    return new CommandStore(roots);
  }

  /** 只写 project 根(priority 最高的 project;无 project 根则取最高 priority)。 */
  get projectRoot(): string | null {
    const sorted = this.sortedRoots();
    const project = sorted.find((r) => r.source === "project");
    return (project ?? sorted[0])?.dir ?? null;
  }

  /** 全部根目录(按 priority 高→低;诊断/调试用)。 */
  rootsSnapshot(): CommandRoot[] {
    return this.sortedRoots().map((r) => ({ ...r }));
  }

  /** 扫描结果 + 诊断。无缓存:每次调用重扫磁盘(ZCode 一致语义)。 */
  listWithDiagnostics(): CommandListOutcome {
    const diagnostics: CommandDiagnostic[] = [];
    const selected = new Map<string, CustomCommand>();

    for (const root of this.sortedRoots()) {
      const files = this.scanRoot(root, diagnostics);
      for (const file of files) {
        const parsed = this.parseFile(file, root, diagnostics);
        if (!parsed) continue;
        const existing = selected.get(parsed.name);
        if (existing) {
          // 高 priority 先扫先赢;被覆盖者记 warning,不报错。
          diagnostics.push({
            path: parsed.path ?? file,
            severity: "warning",
            code: "custom_command_duplicate_name",
            commandName: parsed.name,
            message: `同名自定义命令被更高优先级目录覆盖:${parsed.name}(${parsed.path ?? file})← 保留 ${existing.path ?? ""}`,
          });
          continue;
        }
        selected.set(parsed.name, parsed);
      }
    }

    // 内置命令名保留:自定义同名剔除 + warning(内置是权威目录,不可被覆盖)。
    for (const [name, command] of Array.from(selected.entries())) {
      if (!RESERVED_COMMAND_NAMES.has(name)) continue;
      selected.delete(name);
      diagnostics.push({
        path: command.path ?? "",
        severity: "warning",
        code: "custom_command_reserved_name",
        commandName: name,
        message: `自定义命令与内置命令同名,已忽略:/${name}(内置优先)`,
      });
    }

    const commands = Array.from(selected.values()).sort((a, b) => a.name.localeCompare(b.name));
    return { commands, diagnostics };
  }

  /** 自定义命令清单(已剔除内置同名;名字升序)。无缓存,每次重扫。 */
  list(): CustomCommand[] {
    return this.listWithDiagnostics().commands;
  }

  /**
   * 写入/覆盖自定义命令(只落 project 根)。
   * name 允许单个冒号分层(`git:sync` → `git/sync.md`);`..`、绝对路径、`::`、路径分隔符一律拒绝。
   */
  upsert(name: string, body: string, opts: UpsertOptions = {}): CustomCommand | { error: string } {
    const target = this.writeTarget(name);
    if ("error" in target) return target;
    if (!body || !body.trim()) return { error: "命令内容为空" };
    const root = this.projectRoot;
    if (!root) return { error: "未配置命令目录" };

    const front = frontmatterFor(opts);
    const content = front ? `---\n${front}\n---\n\n${body.trimEnd()}\n` : body.trimEnd() + "\n";
    try {
      mkdirSync(target.dir, { recursive: true });
      writeFileSync(target.file, content, "utf-8");
    } catch (err) {
      return { error: `写入失败:${err instanceof Error ? err.message : String(err)}` };
    }
    return {
      name: target.name,
      body: body.trimEnd(),
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.inputHint ? { inputHint: opts.inputHint } : {}),
      ...(opts.allowedTools?.length ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      path: target.file,
      source: "project",
    };
  }

  /** 删除(只动 project 根)。名字非法 → false。 */
  remove(name: string): boolean {
    const target = this.writeTarget(name);
    if ("error" in target) return false;
    if (!existsSync(target.file)) return false;
    try {
      rmSync(target.file);
      return true;
    } catch {
      return false;
    }
  }

  // ---- 内部:根排序 / 扫描 / 解析 ----

  private sortedRoots(): CommandRoot[] {
    return [...this.roots].sort((a, b) => b.priority - a.priority);
  }

  private scanRoot(root: CommandRoot, diagnostics: CommandDiagnostic[]): string[] {
    try {
      const info = statSync(root.dir);
      if (!info.isDirectory()) return [];
    } catch {
      return []; // 根不存在 = 空根(不是错误;user 根默认可能没有)
    }
    return this.scanDirectory(root.dir, 0, new Set<string>(), diagnostics);
  }

  private scanDirectory(
    dir: string,
    depth: number,
    visited: Set<string>,
    diagnostics: CommandDiagnostic[],
  ): string[] {
    if (depth > MAX_SCAN_DEPTH) return [];
    let realDir: string;
    try {
      // symlink 环防护:按 realpath 去重。
      realDir = realpathSync(dir);
    } catch {
      return [];
    }
    if (visited.has(realDir)) return [];
    visited.add(realDir);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      diagnostics.push({
        path: dir,
        severity: "warning",
        code: "custom_command_scan_failed",
        message: `命令目录扫描失败:${err instanceof Error ? err.message : String(err)}`,
      });
      return [];
    }

    const out: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = statSync(path);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // 悬空 symlink / 无权限:跳过该条目,其余命令照常
        }
      }
      if (isDirectory) {
        out.push(...this.scanDirectory(path, depth + 1, visited, diagnostics));
      } else if (isFile && entry.name.toLowerCase().endsWith(COMMAND_EXTENSION)) {
        out.push(path);
      }
    }
    return out.sort();
  }

  private parseFile(path: string, root: CommandRoot, diagnostics: CommandDiagnostic[]): CustomCommand | null {
    const name = commandNameFromPath(path, root.dir);
    if (!NAME_RE.test(name)) {
      diagnostics.push({
        path,
        severity: "warning",
        code: "custom_command_invalid_name",
        commandName: name,
        message: `自定义命令名非法,已跳过:${name}(须小写字母/数字开头,允许 - _ 与单个冒号,≤64 字符)`,
      });
      return null;
    }
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return null;
    }
    if (size > MAX_COMMAND_BYTES) {
      diagnostics.push({
        path,
        severity: "warning",
        code: "custom_command_too_large",
        commandName: name,
        message: `命令文件超过 ${MAX_COMMAND_BYTES} 字节,已跳过:${name}(${size} 字节)`,
      });
      return null;
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err) {
      diagnostics.push({
        path,
        severity: "warning",
        code: "custom_command_read_failed",
        message: `命令文件读取失败:${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }

    const frontmatter = extractFrontmatter(raw);
    const parsed = frontmatter ? parseFlatYaml(frontmatter) : { values: {}, keys: [] };
    const body = stripFrontmatter(raw).trim();
    const description =
      truncate(parseScalar(parsed.values.description) ?? firstLine(body) ?? "", MAX_DESCRIPTION_LENGTH) || undefined;
    if (!description && !body) {
      diagnostics.push({
        path,
        severity: "warning",
        code: "custom_command_empty",
        commandName: name,
        message: `自定义命令既无 description 也无正文,已跳过:${name}`,
      });
      return null;
    }

    return {
      name,
      body,
      ...(description ? { description } : {}),
      ...(parseScalar(parsed.values["argument-hint"])
        ? { inputHint: parseScalar(parsed.values["argument-hint"]) }
        : {}),
      ...(parseList(parsed.values["allowed-tools"]).length
        ? { allowedTools: parseList(parsed.values["allowed-tools"]) }
        : {}),
      ...(parseScalar(parsed.values.model) ? { model: parseScalar(parsed.values.model) } : {}),
      disableNonInteractive: parseBoolean(parsed.values["disable-noninteractive"]),
      ...(parseList(parsed.values.skills).length ? { skills: parseList(parsed.values.skills) } : {}),
      path,
      source: root.source ?? inferSource(root.dir),
    };
  }

  /** 写入目标解析:project 根 + 冒号分层子目录;穿越拦截。 */
  private writeTarget(name: string): { name: string; dir: string; file: string } | { error: string } {
    const normalized = normalizeCommandName(name);
    const invalid = validateCommandName(normalized);
    if (invalid) return { error: invalid };
    const root = this.projectRoot;
    if (!root) return { error: "未配置命令目录" };
    const segments = normalized.split(":");
    const dir = join(root, ...segments.slice(0, -1));
    const file = join(dir, segments[segments.length - 1] + COMMAND_EXTENSION);
    // 双保险:落盘路径必须在根内(resolve 后前缀校验,防任何漏网穿越)。
    const rootPrefix = resolve(root) + sep;
    if (!resolve(file).startsWith(rootPrefix)) return { error: "命令路径越界,拒绝写入" };
    return { name: normalized, dir, file };
  }
}

// ============================================================
// 名称
// ============================================================

/** `dir/name.md` → `dir:name`(ZCode 命名空间规则),统一小写、去前导 `/`。 */
export function commandNameFromPath(path: string, rootDir: string): string {
  const rel = relative(rootDir, path);
  const withoutExtension = rel.slice(0, -COMMAND_EXTENSION.length);
  return normalizeCommandName(withoutExtension.split(/[\\/]+/).join(":"));
}

export function normalizeCommandName(name: string): string {
  return String(name ?? "").trim().replace(/^\/+/, "").toLowerCase();
}

/** 自定义命令名校验;返回错误文案或 null(合法)。 */
export function validateCommandName(name: string): string | null {
  const n = normalizeCommandName(name);
  if (!n) return "命令名不能为空";
  if (isAbsolute(n)) return "命令名不能是绝对路径";
  if (n.includes("..")) return "命令名不能包含 ..(防路径穿越)";
  if (/[\\/]/.test(n)) return "命令名不能包含路径分隔符,分层请用冒号,如 git:sync";
  if (n.includes("::")) return "命令名不能包含连续冒号";
  const segments = n.split(":");
  if (segments.some((s) => s.length === 0)) return "命令名冒号两侧不能为空";
  if (!NAME_RE.test(n)) return "命令名须为小写字母/数字开头(≤64 字符),允许 - _ 与单个冒号分层,如 deploy / git:sync";
  return null;
}

// ============================================================
// frontmatter(扁平 YAML,含 > / | block scalar;不引 yaml 库)
// ============================================================

/** 取 `---` 包裹的 frontmatter 文本;无则 null。 */
export function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

/** 去掉 frontmatter,返回正文(body)。 */
export function stripFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return content;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return content;
  return lines.slice(endIndex + 1).join("\n");
}

/**
 * 手写扁平 YAML 解析(只支持 `key: scalar` 与 `key: >` / `key: |` block scalar)。
 * - 未知键照收(不报错,兼容 ZCode 未来字段);
 * - 嵌套/多行列表不解析(命令 frontmatter 约定为扁平标量,列表用逗号或 [a, b])。
 */
export function parseFlatYaml(text: string): { values: Record<string, string>; keys: string[] } {
  const values: Record<string, string> = {};
  const keys: string[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // 孤立缩进行:上一个标量已消费,忽略
    const separator = line.indexOf(":");
    if (separator <= 0) continue; // 非 key: value 行,跳过(不阻断整份文件)
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    keys.push(key);

    const block = /^([|>])([+-]?)(\d?)$/.exec(raw);
    if (block) {
      const style = block[1];
      const collected: string[] = [];
      let indent: number | null = null;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const candidate = lines[j] ?? "";
        if (candidate.trim().length === 0) {
          collected.push("");
          continue;
        }
        const leading = /^[ \t]*/.exec(candidate)?.[0].length ?? 0;
        if (leading === 0) break;
        if (indent === null) indent = leading;
        collected.push(candidate.slice(Math.min(indent, leading)));
      }
      i = j - 1;
      while (collected.length && collected[collected.length - 1] === "") collected.pop();
      values[key] = style === "|" ? collected.join("\n") : foldBlock(collected);
      continue;
    }

    values[key] = unquote(raw);
  }

  return { values, keys };
}

/** `>` 折叠标量:相邻行以空格合并,空行折算为换行。 */
function foldBlock(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    if (line === "") {
      out += "\n";
      continue;
    }
    out += out.length === 0 || out.endsWith("\n") ? line : " " + line;
  }
  return out.trim();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseBoolean(value: string | undefined): boolean {
  const scalar = parseScalar(value)?.toLowerCase();
  return scalar === "true" || scalar === "yes";
}

function parseList(value: string | undefined): string[] {
  const scalar = parseScalar(value);
  if (!scalar) return [];
  return scalar
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 无 description 时的兜底:正文首个非空行(去 markdown 标题/列表前缀)。 */
function firstLine(body: string): string | undefined {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim())
    .find(Boolean);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/** upsert 的 frontmatter 生成(只写显式给出的键;空=无 frontmatter)。 */
function frontmatterFor(opts: UpsertOptions): string {
  const lines: string[] = [];
  if (opts.description) lines.push(`description: ${opts.description}`);
  if (opts.inputHint) lines.push(`argument-hint: ${opts.inputHint}`);
  if (opts.allowedTools?.length) lines.push(`allowed-tools: ${opts.allowedTools.join(", ")}`);
  if (opts.model) lines.push(`model: ${opts.model}`);
  return lines.join("\n");
}
