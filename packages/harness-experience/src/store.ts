/**
 * 经验库 store(designs/18 §2,Hermes skills 树形态 TS 重写):
 * SKILL.md 目录树+frontmatter 校验+.usage.json sidecar+JSONL ledger(可回滚)。
 *
 * n5 多根发现(ZCode adapters/skills:多根 + priority):读路径看全部根(priority 高者赢),
 * 写路径只落最高优先级根(project)。旧单根构造 `new ExperienceStore(root)` 行为逐字不变,
 * 多根走 `ExperienceStore.fromRoots(resolveSkillRoots({projectRoot, home}))`。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, renameSync, readdirSync, rmSync, rmdirSync, type Dirent } from "node:fs";
import { join, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { withLock } from "@lampgenie/runtime/locks/file-lock";
import { SKILL_PRIORITY_STEP, type SkillRoot } from "./skill-roots.js";

export interface ExperienceFrontmatter {
  name: string;
  /** 索引描述。写入口径 ≤60 字符(见 write 校验);读取口径 ≤1024(见 MAX_SKILL_DESCRIPTION_LENGTH)。 */
  description: string;
  version: number;
  created_by: "agent" | "user";
  category: string;
  /** candidate=确定性兜底产出待确认;active=正式。 */
  status: "candidate" | "active" | "stale" | "archived" | "disabled";
  created_at: string;
  /** 何时用(ZCode `when_to_use`):手写技能的多行触发说明,进索引行 `(当: …)`。 */
  whenToUse?: string;
  /** 项目归属(designs/23 项目绑定团队:/team share 沉淀时由激活项目写入)。 */
  project?: string;
}

/** 读取侧 description 上限(ZCode MAX_DESCRIPTION_LENGTH:超长即丢弃整条技能)。
 *  与写入侧的 60 字符口径**不同且必须不同**:
 *  - 写入侧是我们自己(agent distill / experience_fold)生成的条目,短描述是纪律(索引一行能读完、路由可判);
 *  - 读取侧要兼容外部手写技能(.claude/.agents 生态搬来的 SKILL.md 常见上百字说明),
 *    只挡真正异常的巨块(>1024)以免索引被单条淹掉。 */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
/** 写入侧 description 上限(Hermes 纪律:≤60 字符,超长在索引中被截断且永不路由)。 */
export const WRITE_MAX_DESCRIPTION_LENGTH = 60;

/** 可自动加载的安全 frontmatter 键(ZCode SAFE_FRONTMATTER_KEYS + 本仓自有字段)。 */
const SAFE_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "when_to_use",
  "license",
  "metadata",
  // 本仓 renderSkillMd 自产字段(不算外来扩展键,不应让 safeToAutoLoad 变 false)
  "version",
  "created_by",
  "category",
  "status",
  "created_at",
  "project",
]);

const VALID_STATUS: ExperienceFrontmatter["status"][] = ["candidate", "active", "stale", "archived", "disabled"];

/** 解析/发现期诊断(形态照 ZCode SkillDiagnostic 裁剪)。 */
export interface SkillDiagnostic {
  /** 出问题的文件绝对路径。 */
  path: string;
  severity: "error" | "warning";
  message: string;
  /** 稳定机读码(日志与测试锚点)。 */
  code:
    | "skill_invalid_frontmatter"
    | "skill_missing_name"
    | "skill_missing_description"
    | "skill_description_too_long"
    | "skill_shadowed";
  skillName?: string;
}

/** 索引条目(store.index()/indexWithDiagnostics().skills 的元素)。 */
export interface SkillIndexEntry {
  category: string;
  name: string;
  description: string;
  whenToUse?: string;
  /** SKILL.md 绝对路径(索引行 `(file: …)` 用)。 */
  path: string;
  scope: "user" | "project";
  priority: number;
  /** 目录名(通常等于 name;手写技能的 frontmatter name 可能与目录名不同)。 */
  dirName: string;
  /** frontmatter 全部键都在安全白名单内(= 可无条件自动加载)。 */
  safeToAutoLoad: boolean;
}

export interface UsageTelemetry {
  use_count: number;
  view_count: number;
  patch_count: number;
  /** 技能被改过之后又被使用——自改进效果的核心证据(Hermes reuse_after_patch)。 */
  reuse_after_patch: number;
  last_used_at?: string;
  last_patched_at?: string;
}

/** 原子写(2026-10-21 四轮复审 R4-4:多 worker 并发 distill 防互吞)——tmp+rename,同文件系统原子替换。 */
function atomicWrite(file: string, data: string): void {
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now().toString(36);
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, file);
}

export class ExperienceStore {
  /** 写根(最高优先级根;单根构造时即 root 本身)。 */
  readonly root: string;
  /** 全部技能根(priority 升序)。 */
  readonly roots: SkillRoot[];
  private readonly rootsByPriorityDesc: SkillRoot[];
  private ledgerPath: string;

  /** @param roots 多根(缺省=单根 `[{root, project, +10}]`,即旧行为)。 */
  constructor(root: string, roots?: SkillRoot[]) {
    this.root = root;
    this.roots = roots && roots.length > 0
      ? [...roots].sort((a, b) => a.priority - b.priority)
      : [{ dir: root, scope: "project" as const, priority: SKILL_PRIORITY_STEP }];
    this.rootsByPriorityDesc = [...this.roots].sort((a, b) => b.priority - a.priority);
    this.ledgerPath = join(root, ".ledger.jsonl");
    mkdirSync(root, { recursive: true });
  }

  /** 多根构造:写路径=最高优先级根(通常 project),读路径=全部根(高优先级先命中)。 */
  static fromRoots(roots: SkillRoot[]): ExperienceStore {
    if (roots.length === 0) throw new Error("技能根为空:无法构造 ExperienceStore");
    const sorted = [...roots].sort((a, b) => a.priority - b.priority);
    const writeRoot = sorted[sorted.length - 1]!;
    return new ExperienceStore(writeRoot.dir, sorted);
  }

  /** 写路径目录(恒为写根)。 */
  private dirOf(category: string, name: string): string {
    return join(this.root, category, name);
  }

  /** 读路径解析:按 priority 降序找第一个带 SKILL.md 的目录;找不到再按 frontmatter name 兜底线性找
   *  (手写技能目录名与 name 不一致时仍可用索引里的名字读到全文)。 */
  private resolveDir(category: string, name: string): string | null {
    for (const root of this.rootsByPriorityDesc) {
      const dir = join(root.dir, category, name);
      if (existsSync(join(dir, "SKILL.md"))) return dir;
    }
    for (const root of this.rootsByPriorityDesc) {
      const catDir = join(root.dir, category);
      if (!existsSync(catDir)) continue;
      let entries: Dirent<string>[];
      try {
        entries = readdirSync(catDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = join(catDir, e.name, "SKILL.md");
        if (!existsSync(p)) continue;
        const parsed = parseSkillFile(readFileSync(p, "utf-8"), { path: p, category, dirName: e.name });
        if (parsed.fm?.name === name) return join(catDir, e.name);
      }
    }
    return null;
  }

  /** 技能目录绝对路径(多根解析后;skill_view 展开 `${GENIE_SKILL_DIR}` 用)。 */
  skillDir(category: string, name: string): string | null {
    return this.resolveDir(category, name);
  }

  /** upsert 一条经验(fold-in:同 category+name 即覆盖更新,version+1)。
   * R4-C8 修复:写路径整体挂文件锁(多实例并发写 ledger 交错);异步化(内部实现移 writeLocked)。 */
  async write(fm: Omit<ExperienceFrontmatter, "version" | "created_at" | "status"> & { status?: "candidate" | "active" }, body: string): Promise<ExperienceFrontmatter> {
    // 自旋等锁(withLock 是非阻塞尝试,拿不到返回 undefined;并发写方等待而非失败)
    const lockPath = join(this.root, ".write.lock");
    for (let attempt = 0; attempt < 100; attempt++) {
      const r = await withLock(lockPath, () => Promise.resolve(this.writeLocked(fm, body)));
      if (r !== undefined) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error("经验库写锁等待超时(5s)");
  }

  private writeLocked(fm: Omit<ExperienceFrontmatter, "version" | "created_at" | "status"> & { status?: "candidate" | "active" }, body: string): ExperienceFrontmatter {
    if (fm.description.length > WRITE_MAX_DESCRIPTION_LENGTH) {
      throw new Error(`description 超 ${WRITE_MAX_DESCRIPTION_LENGTH} 字符(${fm.description.length})——索引会被截断且永不路由`);
    }
    const dir = this.dirOf(fm.category, fm.name);
    const existing = this.readAtWriteRoot(fm.category, fm.name);
    const full: ExperienceFrontmatter = {
      ...fm,
      version: existing ? existing.version + 1 : 1,
      status: fm.status ?? "active",
      created_at: existing?.created_at ?? new Date().toISOString(),
    };
    mkdirSync(dir, { recursive: true });
    const prevHash = existing ? this.contentHash(this.readBody(fm.category, fm.name)) : null;
    atomicWrite(join(dir, "SKILL.md"), renderSkillMd(full, body));
    // sidecar
    const sidecar = join(dir, ".usage.json");
    const usage: UsageTelemetry = existing
      ? this.usage(fm.category, fm.name)
      : { use_count: 0, view_count: 0, patch_count: 0, reuse_after_patch: 0 };
    usage.patch_count += 1;
    usage.last_patched_at = new Date().toISOString();
    atomicWrite(sidecar, JSON.stringify(usage, null, 2));
    // ledger(变更审计+可回滚)
    this.appendLedger({
      at: new Date().toISOString(), action: "write",
      category: fm.category, name: fm.name, version: full.version,
      prevHash, newHash: this.contentHash(body),
    });
    return full;
  }

  /** 写根内的既有条目(version 递增只看写根:用户根的副本不参与 project 侧版本号)。 */
  private readAtWriteRoot(category: string, name: string): ExperienceFrontmatter | null {
    const p = join(this.dirOf(category, name), "SKILL.md");
    if (!existsSync(p)) return null;
    return parseSkillFile(readFileSync(p, "utf-8"), { path: p, category, dirName: name }).fm;
  }

  read(category: string, name: string): ExperienceFrontmatter | null {
    const dir = this.resolveDir(category, name);
    if (!dir) return null;
    const p = join(dir, "SKILL.md");
    return parseSkillFile(readFileSync(p, "utf-8"), { path: p, category, dirName: basename(dir) }).fm;
  }

  readBody(category: string, name: string): string {
    const dir = this.resolveDir(category, name);
    if (!dir) return "";
    return splitFrontmatter(readFileSync(join(dir, "SKILL.md"), "utf-8")).body;
  }

  usage(category: string, name: string): UsageTelemetry {
    const dir = this.resolveDir(category, name);
    const p = dir ? join(dir, ".usage.json") : "";
    if (!p || !existsSync(p)) return { use_count: 0, view_count: 0, patch_count: 0, reuse_after_patch: 0 };
    return JSON.parse(readFileSync(p, "utf-8")) as UsageTelemetry;
  }

  /** 删除一条经验(面板删除入口):resolveDir 定位实际目录(多根 + frontmatter name≠dirName 兜底),
   *  rmSync 递归删整目录(SKILL.md+.usage.json 级联),ledger 记 delete(可审计);不存在返回 false。 */
  remove(category: string, name: string): boolean {
    const dir = this.resolveDir(category, name);
    if (!dir) return false;
    const fm = this.read(category, name);
    rmSync(dir, { recursive: true, force: true });
    // 空类目目录顺手清理(best-effort:非空/跨设备失败即留着,不影响索引)
    try { rmdirSync(dirname(dir)); } catch { /* 非空或不可删:保留 */ }
    this.appendLedger({
      at: new Date().toISOString(), action: "delete",
      category, name, version: fm?.version ?? 1, prevHash: null, newHash: null,
    });
    return true;
  }

  /** 注入/加载计数(patch 之后的使用计入 reuse_after_patch)。 */
  bumpUse(category: string, name: string, kind: "use" | "view" = "use"): void {
    const dir = this.resolveDir(category, name);
    if (!dir) return;
    const u = this.usage(category, name);
    if (kind === "use") {
      const patchedRecently = u.last_patched_at && (!u.last_used_at || u.last_patched_at > u.last_used_at);
      if (patchedRecently) u.reuse_after_patch += 1;
      u.use_count += 1;
      u.last_used_at = new Date().toISOString();
    } else {
      u.view_count += 1;
    }
    atomicWrite(join(dir, ".usage.json"), JSON.stringify(u, null, 2));
  }

  /** 已禁用清单(step-044 恢复入口)。注意:disabled 条目被 index 过滤,故这里独立扫根。 */
  disabledEntries(): { category: string; name: string }[] {
    const out: { category: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const root of this.rootsByPriorityDesc) {
      if (!existsSync(root.dir)) continue;
      for (const cat of readdirSync(root.dir, { withFileTypes: true })) {
        if (!cat.isDirectory() || cat.name.startsWith(".")) continue;
        for (const skill of readdirSync(join(root.dir, cat.name), { withFileTypes: true })) {
          if (!skill.isDirectory()) continue;
          const p = join(root.dir, cat.name, skill.name, "SKILL.md");
          if (!existsSync(p)) continue;
          const fm = parseSkillFile(readFileSync(p, "utf-8"), { path: p, category: cat.name, dirName: skill.name }).fm;
          if (!fm || fm.status !== "disabled") continue;
          const key = `${cat.name}/${fm.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ category: cat.name, name: fm.name });
        }
      }
    }
    return out;
  }

  /** 索引(向后兼容签名:返回 skills 数组;需要诊断用 indexWithDiagnostics)。 */
  index(): SkillIndexEntry[] {
    return this.indexWithDiagnostics().skills;
  }

  /**
   * 索引 + 诊断(n5):按根 priority 降序扫描(高优先级先占位),
   *  - frontmatter 有问题的条目丢弃并记 error(缺 description / description >1024 / 缺 name);
   *  - 同名(`<category>/<name>`)被高优先级根压过的记 warning(skill_shadowed);
   *  - archived/disabled 不进索引。
   */
  indexWithDiagnostics(): { skills: SkillIndexEntry[]; diagnostics: SkillDiagnostic[] } {
    const skills: SkillIndexEntry[] = [];
    const diagnostics: SkillDiagnostic[] = [];
    const selected = new Map<string, SkillIndexEntry>();
    for (const root of this.rootsByPriorityDesc) {
      if (!existsSync(root.dir)) continue;
      let catDirs: Dirent<string>[];
      try {
        catDirs = readdirSync(root.dir, { withFileTypes: true });
      } catch {
        diagnostics.push({ path: root.dir, severity: "warning", code: "skill_invalid_frontmatter", message: `技能根不可读,已跳过: ${root.dir}` });
        continue;
      }
      for (const cat of catDirs) {
        if (!cat.isDirectory() || cat.name.startsWith(".")) continue;
        const catDir = join(root.dir, cat.name);
        let skillDirs: Dirent<string>[];
        try {
          skillDirs = readdirSync(catDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sk of skillDirs) {
          if (!sk.isDirectory()) continue;
          const path = join(catDir, sk.name, "SKILL.md");
          if (!existsSync(path)) continue;
          const parsed = parseSkillFile(readFileSync(path, "utf-8"), { path, category: cat.name, dirName: sk.name });
          diagnostics.push(...parsed.diagnostics);
          const fm = parsed.fm;
          if (!fm) continue;
          if (fm.status === "archived" || fm.status === "disabled") continue;
          // candidate 不进索引(2026-10-29 token 轮 P3)。
          //
          // candidate 是 distill.ts 的**确定性兜底**产出:failed 任务的 journal 原文转储 +
          // description = `失败任务候选经验:${task.instruction.slice(0,50)}`。实测剩余 9 条全是这种,
          // 索引行长这样:「incidents/task-24fb3f55: 失败任务候选经验:做个小功能」——
          // ① 描述是被截断的用户原话,不含任何知识,模型无法据它判断「该不该读」;
          // ② 正文是 `subagent.event {...}` 这类原始事件,读了也没有可复用规则;
          // ③ 它们占着索引行额度,还把真正的 active 经验挤向截断/降级分支。
          // 语义上也成立:status 注释写的是「candidate=确定性兜底产出待确认;active=正式」——
          // 待确认的半成品本就不该出现在「可用技能目录」里。
          // 可回退:GENIE_SKILL_INDEX_CANDIDATE=on 让候选条目重新进索引(排查用)。
          const showCandidate = String(process.env.GENIE_SKILL_INDEX_CANDIDATE ?? "").toLowerCase() === "on";
          if (fm.status === "candidate" && !showCandidate) continue;
          const key = `${cat.name}/${fm.name}`;
          const winner = selected.get(key);
          if (winner) {
            diagnostics.push({
              path,
              severity: "warning",
              code: "skill_shadowed",
              skillName: fm.name,
              message: `同名技能 ${key} 被更高优先级根(${winner.path},scope=${winner.scope})覆盖,本条被压过: ${path}`,
            });
            continue;
          }
          const entry: SkillIndexEntry = {
            category: cat.name,
            name: fm.name,
            description: fm.description,
            ...(fm.whenToUse ? { whenToUse: fm.whenToUse } : {}),
            path,
            scope: root.scope,
            priority: root.priority,
            dirName: sk.name,
            safeToAutoLoad: parsed.safeToAutoLoad,
          };
          selected.set(key, entry);
          skills.push(entry);
        }
      }
    }
    skills.sort((a, b) => `${a.category}/${a.name}`.localeCompare(`${b.category}/${b.name}`));
    return { skills, diagnostics };
  }

  /** 全文读取(bump view)。 */
  view(category: string, name: string): string | null {
    if (!this.read(category, name)) return null;
    this.bumpUse(category, name, "view");
    return this.readBody(category, name);
  }

  /** 回滚到上一版(ledger 最后一条 write 的 prevHash blob)。 */
  rollback(category: string, name: string): boolean {
    const entries = this.ledger()
      .filter((e) => e.category === category && e.name === name && e.action === "write" && e.version > 1)
      .reverse();
    const prev = entries[0];
    if (!prev || !prev.prevHash) return false;
    const blobPath = join(this.root, ".blobs", `${prev.prevHash}.md`);
    if (!existsSync(blobPath)) return false;
    const dir = this.resolveDir(category, name) ?? this.dirOf(category, name);
    writeFileSync(join(dir, "SKILL.md"),
      renderSkillMd({ ...this.read(category, name)!, version: prev.version - 1 } as ExperienceFrontmatter, readFileSync(blobPath, "utf-8")), "utf-8");
    this.appendLedger({ at: new Date().toISOString(), action: "rollback", category, name, version: prev.version - 1, prevHash: null, newHash: prev.prevHash });
    return true;
  }

  /** 状态推进(curator 用)。 */
  setStatus(category: string, name: string, status: ExperienceFrontmatter["status"]): void {
    const fm = this.read(category, name);
    if (!fm) return;
    const dir = this.resolveDir(category, name) ?? this.dirOf(category, name);
    const body = this.readBody(category, name);
    writeFileSync(join(dir, "SKILL.md"), renderSkillMd({ ...fm, status }, body), "utf-8");
    this.appendLedger({ at: new Date().toISOString(), action: "write", category, name, version: fm.version, prevHash: null, newHash: this.contentHash(body) });
  }

  /** ledger 追加的公共口(curator archive 等外部动作)。 */
  appendLedgerPublic(e: LedgerEntry): void { this.appendLedger(e); }

  ledger(): LedgerEntry[] {
    if (!existsSync(this.ledgerPath)) return [];
    return readFileSync(this.ledgerPath, "utf-8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry);
  }

  private appendLedger(e: LedgerEntry): void {
    appendFileSync(this.ledgerPath, JSON.stringify(e) + "\n", "utf-8");
    if (e.newHash) {
      // blob 快照(内容寻址)
      const blobs = join(this.root, ".blobs");
      mkdirSync(blobs, { recursive: true });
      writeFileSync(join(blobs, `${e.newHash}.md`), this.readBody(e.category, e.name), "utf-8");
    }
  }

  private contentHash(body: string): string {
    return createHash("sha256").update(body).digest("hex").slice(0, 16);
  }
}

export interface LedgerEntry {
  at: string; action: "write" | "rollback" | "archive" | "restore" | "delete";
  category: string; name: string; version: number;
  prevHash: string | null; newHash: string | null;
}

function renderSkillMd(fm: ExperienceFrontmatter, body: string): string {
  const projectLine = fm.project ? `\nproject: ${fm.project}` : "";
  const whenLine = fm.whenToUse ? `\nwhen_to_use: ${quoteIfNeeded(fm.whenToUse)}` : "";
  return `---\nname: ${fm.name}\ndescription: ${quoteIfNeeded(fm.description)}${whenLine}\nversion: ${fm.version}\ncreated_by: ${fm.created_by}\ncategory: ${fm.category}\nstatus: ${fm.status}\ncreated_at: ${fm.created_at}${projectLine}\n---\n\n${body}`;
}

/** 单行值若含冒号/引号/换行会破坏 flat YAML,统一折成单行并加引号(写入侧自保)。 */
function quoteIfNeeded(v: string): string {
  const oneLine = v.replace(/\r?\n/g, " ").trim();
  if (/^[^\s"'#>|[{!&*%@`-][^:]*$/.test(oneLine) && !/:\s/.test(oneLine)) return oneLine;
  return `"${oneLine.replace(/"/g, '\\"')}"`;
}

// ---- frontmatter 解析(ZCode adapters/skills/index.ts 移植:手写 flat YAML) ----

/** 拆 frontmatter 与正文(BOM/CRLF 容错;无 frontmatter 返回 body=原文)。 */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: null, body: normalized };
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return { frontmatter: null, body: normalized };
  let body = lines.slice(endIndex + 1).join("\n");
  if (body.startsWith("\n")) body = body.slice(1);
  return { frontmatter: lines.slice(1, endIndex).join("\n"), body };
}

/**
 * 手写 flat YAML 解析:只认顶层 `key: value`,支持 `|` / `>` block scalar。
 * 为什么不用全量 YAML:技能 frontmatter 是模型/人写的扁平表,引 yaml 库=多一个依赖与一条
 * 解析失败路径;取舍依据:「Agent 侧只读顶层 description: > 会只剩 >」,故只认字符串体。
 */
export function parseFlatYaml(
  frontmatter: string,
  path: string,
  diagnostics: SkillDiagnostic[],
): { values: Record<string, string>; keys: string[] } {
  const values: Record<string, string> = {};
  const keys: string[] = [];
  const lines = frontmatter.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // 缩进行属于上一个键的 block scalar 或非法缩进,跳过

    const separator = line.indexOf(":");
    if (separator <= 0) {
      diagnostics.push({
        code: "skill_invalid_frontmatter",
        severity: "warning",
        path,
        message: `frontmatter 第 ${index + 1} 行无法解析(缺 key:): ${line.slice(0, 80)}`,
      });
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    keys.push(key);
    const blockStyle = parseBlockScalarStyle(value);
    if (blockStyle) {
      const block = readBlockScalar(lines, index + 1, blockStyle);
      values[key] = block.value;
      index = block.nextIndex - 1;
    } else {
      values[key] = value;
    }
  }
  return { values, keys };
}

function parseBlockScalarStyle(value: string): "folded" | "literal" | null {
  if (/^>[+-]?$/.test(value)) return "folded";
  if (/^\|[+-]?$/.test(value)) return "literal";
  return null;
}

function readBlockScalar(
  lines: string[],
  startIndex: number,
  style: "folded" | "literal",
): { value: string; nextIndex: number } {
  const rawLines: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length > 0 && !/^\s/.test(line)) break;
    rawLines.push(line);
    index += 1;
  }

  const indent = rawLines.reduce<number | null>((current, line) => {
    if (line.trim().length === 0) return current;
    const lineIndent = leadingWhitespaceLength(line);
    return current === null ? lineIndent : Math.min(current, lineIndent);
  }, null);
  const contentLines = rawLines.map((line) => (line.trim().length === 0 ? "" : line.slice(indent ?? 0)));
  return {
    value: style === "folded" ? foldBlockScalarLines(contentLines) : contentLines.join("\n").trim(),
    nextIndex: index,
  };
}

function leadingWhitespaceLength(value: string): number {
  const match = /^(\s*)/.exec(value);
  return match?.[1]?.length ?? 0;
}

/** `>` folded:同段内换行折成空格,空行分段。 */
function foldBlockScalarLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

/** 标量取值:去空白,成对引号剥掉;空串→undefined。 */
function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export interface ParsedSkillFile {
  /** null = 该文件按纪律丢弃(诊断里必有 error)。 */
  fm: ExperienceFrontmatter | null;
  diagnostics: SkillDiagnostic[];
  frontmatterKeys: string[];
  safeToAutoLoad: boolean;
}

/**
 * 解析一个 SKILL.md(n5 读取纪律):
 *  - 有 frontmatter 但缺 name / 缺 description / description >1024 → 丢弃 + error 诊断;
 *  - 无 frontmatter → 手写兜底:name=目录名、description=""(不报错,避免设置页出现无修复价值的红点);
 *  - 其它字段宽松:version/created_by/category/status/created_at 缺省补默认值。
 */
export function parseSkillFile(
  text: string,
  opts: { path: string; category: string; dirName: string },
): ParsedSkillFile {
  const { frontmatter, body } = splitFrontmatter(text);
  void body;
  const diagnostics: SkillDiagnostic[] = [];
  if (frontmatter === null) {
    return {
      fm: {
        name: opts.dirName,
        description: "",
        version: 1,
        created_by: "user",
        category: opts.category,
        status: "active",
        created_at: new Date().toISOString(),
      },
      diagnostics,
      frontmatterKeys: [],
      safeToAutoLoad: true,
    };
  }

  const { values, keys } = parseFlatYaml(frontmatter, opts.path, diagnostics);
  const rawName = parseScalar(values.name);
  if (!rawName) {
    diagnostics.push({
      code: "skill_missing_name",
      severity: "error",
      path: opts.path,
      message: `frontmatter 缺少 name: ${opts.path}`,
    });
    return { fm: null, diagnostics, frontmatterKeys: keys, safeToAutoLoad: false };
  }
  // 缺 description = 键不存在(取值后为空串视为「给了但没内容」,与写入侧 ≤60 校验口径自洽)
  if (!("description" in values)) {
    diagnostics.push({
      code: "skill_missing_description",
      severity: "error",
      path: opts.path,
      skillName: rawName,
      message: `frontmatter 缺少 description: ${opts.path}`,
    });
    return { fm: null, diagnostics, frontmatterKeys: keys, safeToAutoLoad: false };
  }
  const description = parseScalar(values.description) ?? "";
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    diagnostics.push({
      code: "skill_description_too_long",
      severity: "error",
      path: opts.path,
      skillName: rawName,
      message: `description 超 ${MAX_SKILL_DESCRIPTION_LENGTH} 字符(${description.length}),整条丢弃: ${rawName}`,
    });
    return { fm: null, diagnostics, frontmatterKeys: keys, safeToAutoLoad: false };
  }

  const rawStatus = parseScalar(values.status);
  const status = (VALID_STATUS as string[]).includes(rawStatus ?? "")
    ? (rawStatus as ExperienceFrontmatter["status"])
    : "active";
  const version = Number(parseScalar(values.version) ?? 1);
  const fm: ExperienceFrontmatter = {
    name: rawName,
    description,
    version: Number.isFinite(version) && version > 0 ? version : 1,
    created_by: parseScalar(values.created_by) === "user" ? "user" : "agent",
    category: parseScalar(values.category) ?? opts.category,
    status,
    created_at: parseScalar(values.created_at) ?? new Date().toISOString(),
    ...(parseScalar(values.when_to_use) ? { whenToUse: parseScalar(values.when_to_use) } : {}),
    ...(parseScalar(values.project) ? { project: parseScalar(values.project) } : {}),
  };
  return {
    fm,
    diagnostics,
    frontmatterKeys: keys,
    safeToAutoLoad: keys.every((k) => SAFE_FRONTMATTER_KEYS.has(k)),
  };
}
