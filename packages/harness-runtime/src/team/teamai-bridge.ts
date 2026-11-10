/**
 * teamai 桥接层:兼容 teamai-cli 的团队仓数据模型——
 * 已在用的团队仓(teamai.yaml/skills/rules/docs/env/hooks/manifest/culture)由 relay 克隆同步,
 * 本模块把克隆目录读成受控投影(digest)供 gateway 分发到自己的面(系统提示/面板/命令)。
 * 红线:secrets.yaml 只出 key 不出值;所有解析 fail-soft(外部手编 yaml 超集不抛错,能读多少读多少);
 * 写路径只有 push(分支+MR,对齐 teamai push 约定)。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseYamlLite } from "./yaml-lite.js";
import { readRoles, type TeamaiRole } from "./teamai-roles.js";

export interface TeamaiMeta {
  team: string;
  description: string;
  repo: string;
  reviewers: string[];
  /** teamai.yaml sharing.rules.enforced——强制注入名单。 */
  enforcedRules: string[];
}

export interface TeamaiRule {
  name: string;
  enforced: boolean;
  body: string;
}

export interface TeamaiSkill {
  ns: string;
  name: string;
  description: string;
  contributors: string[];
  body: string;
}

export interface TeamaiLearning {
  path: string;
  title: string;
  author: string;
  date: string;
  tags: string[];
  body: string;
}

export interface TeamaiEnvVar {
  key: string;
  value: string;
  description: string;
}

export interface TeamaiHook {
  id: string;
  description: string;
  event: string;
  matcher: string;
  tools: string[];
  command: string;
}

export interface TeamaiDigest {
  meta: TeamaiMeta;
  culture: string;
  rules: TeamaiRule[];
  skills: TeamaiSkill[];
  docs: string[];
  envVars: TeamaiEnvVar[];
  secretKeys: string[];
  hooks: TeamaiHook[];
  learnings: TeamaiLearning[];
  mcpRaw: string;
  modelsRaw: string;
  agentsRaw: string[];
  pulledAt: number;
 /** 角色定义( §2.6:roster/roles.yaml;缺失=[]) */
  roles: TeamaiRole[];
 /** 资源计数面( §2.6:teamai list 的数据源) */
  counts: { members: number; skills: number; rules: number; docs: number; learnings: number };
 /** 成员→roleId 映射( §2.6:面板角色徽标数据源;成员 yaml 未写 roleId=不出现在表里) */
  memberRoles: Record<string, string>;
}

const CAP = { culture: 1_500, ruleBody: 8_000, skillBody: 8_000, mcpRaw: 4_000, totalRules: 24, totalSkills: 64, totalDocs: 64, learnings: 64, learningBody: 6_000 };

/** teamai.yaml 针对性解析(嵌套形态只取三条路径:顶层标量/sharing.rules.enforced/reviewers;其余容忍)。 */
export function parseTeamaiMeta(text: string): TeamaiMeta {
  const out: TeamaiMeta = { team: "", description: "", repo: "", reviewers: [], enforcedRules: [] };
  let inEnforced = false;
  let inReviewers = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const listm = /^\s*-\s+(.+)$/.exec(line);
    if (listm && (inEnforced || inReviewers) && indent >= 2) {
      const item = listm[1]!.trim();
      if (inEnforced) out.enforcedRules.push(item);
      if (inReviewers) out.reviewers.push(item);
      continue;
    }
    inEnforced = false;
    inReviewers = false;
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1]!;
    const val = kv[2]!.trim();
    if (indent === 0) {
      if (key === "team") out.team = unq(val);
      else if (key === "description") out.description = unq(val);
      else if (key === "repo") out.repo = unq(val);
      else if (key === "reviewers") inReviewers = val === "" ;
    } else if (indent >= 2 && key === "enforced") {
      // sharing:→rules:→enforced:(无值=块式列表)
      inEnforced = val === "";
    }
  }
  return out;
}

function unq(v: string): string {
  return /^".*"$/.test(v) || /^'.*'$/.test(v) ? v.slice(1, -1) : v;
}

/** hooks/hooks.yaml 块式列表解析:- id: 起头,后续缩进行为字段;tools: [a, b] 流式列表。 */
export function parseHookList(text: string): TeamaiHook[] {
  const hooks: TeamaiHook[] = [];
  let cur: Partial<TeamaiHook> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(line);
    if (item) {
      if (cur?.id) hooks.push(finalizeHook(cur));
      cur = { id: unq(item[2]!.trim()) };
      continue;
    }
    const kv = /^\s*(\w+):\s*(.*)$/.exec(line);
    if (kv && cur) {
      const key = kv[1]!;
      const val = kv[2]!.trim();
      if (key === "description") cur.description = unq(val);
      else if (key === "event") cur.event = val;
      else if (key === "matcher") cur.matcher = unq(val);
      else if (key === "command") cur.command = val;
      else if (key === "tools") cur.tools = /^\[(.*)\]$/.exec(val)?.[1]!.split(",").map((x) => unq(x.trim())).filter(Boolean) ?? [];
    }
  }
  if (cur?.id) hooks.push(finalizeHook(cur));
  return hooks;
}

function finalizeHook(cur: Partial<TeamaiHook>): TeamaiHook {
  return {
    id: cur.id ?? "",
    description: cur.description ?? "",
    event: cur.event ?? "",
    matcher: cur.matcher ?? "",
    tools: cur.tools ?? [],
    command: cur.command ?? "",
  };
}

/** env/env.yaml:variables 块式列表(key/value/description);secrets 同形态但只取 key。 */
export function parseEnvYaml(text: string): TeamaiEnvVar[] {
  const vars: TeamaiEnvVar[] = [];
  let cur: Partial<TeamaiEnvVar> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(line);
    if (item) {
      if (cur?.key) vars.push({ key: cur.key, value: cur.value ?? "", description: cur.description ?? "" });
      cur = item[1] === "key" ? { key: unq(item[2]!.trim()) } : { key: unq(item[1]!) };
      if (item[1] !== "key" && item[2]) cur.value = unq(item[2]!.trim());
      continue;
    }
    const kv = /^\s*(\w+):\s*(.*)$/.exec(line);
    if (kv && cur) {
      if (kv[1] === "value") cur.value = unq(kv[2]!.trim());
      else if (kv[1] === "description") cur.description = unq(kv[2]!.trim());
    }
  }
  if (cur?.key) vars.push({ key: cur.key, value: cur.value ?? "", description: cur.description ?? "" });
  return vars;
}

export function parseLearningMeta(text: string): { title: string; author: string; date: string; tags: string[] } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const out = { title: "", author: "", date: "", tags: [] as string[] };
  if (!m) return out;
  out.title = unq(/^title:\s*"?([^"\n]*)"??\s*$/m.exec(m[1]!)?.[1] ?? "").trim();
  out.author = (/^author:\s*(.+)$/m.exec(m[1]!)?.[1] ?? "").trim();
  out.date = (/^date:\s*(.+)$/m.exec(m[1]!)?.[1] ?? "").trim();
  const tags = /^tags:\s*\[(.*)\]\s*$/m.exec(m[1]!)?.[1] ?? "";
  out.tags = tags.split(",").map((t) => unq(t.trim())).filter(Boolean);
  return out;
}

/** learnings/ 目录 fs 扫描(已合入 master 的形态;上游分支形态由 relay 走 git 读取后补挂)。 */
export function readLearningsDir(cloneDir: string): TeamaiLearning[] {
  const root = join(cloneDir, "learnings");
  if (!existsSync(root)) return [];
  const out: TeamaiLearning[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { walk(p, `${prefix}${f}/`); continue; }
      if (!f.endsWith(".md") || out.length >= CAP.learnings) continue;
      const body = readFileSync(p, "utf-8");
      const meta = parseLearningMeta(body);
      out.push({ path: prefix + f, ...meta, body: body.slice(0, CAP.learningBody) });
    }
  };
  walk(root, "");
  return out;
}

export function scanSkillFrontmatter(text: string): { name: string; description: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { name: "", description: "" };
  const name = /^name:\s*(.+)$/m.exec(m[1]!)?.[1] ?? "";
  const desc = /^description:\s*(.+)$/m.exec(m[1]!)?.[1] ?? "";
  return { name: unq(name.trim()), description: unq(desc.trim()) };
}

/** listAll 文件(带 CONTRIBUTORS 的目录形态=teamai skill)。 */
function listDocsDir(dir: string, prefix: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) listDocsDir(p, `${prefix}${f}/`, out);
    else out.push(prefix + f);
  }
}

/** 克隆目录 → 受控投影(fail-soft:缺文件/坏文件跳过;secrets 只取 key)。 */
export function readTeamaiAssets(cloneDir: string, pulledAt = Date.now()): TeamaiDigest {
  const metaFile = join(cloneDir, "teamai.yaml");
  const meta = existsSync(metaFile) ? parseTeamaiMeta(readFileSync(metaFile, "utf-8")) : { team: "", description: "", repo: "", reviewers: [], enforcedRules: [] };

  const cultureFile = join(cloneDir, "culture.md");
  const culture = existsSync(cultureFile) ? readFileSync(cultureFile, "utf-8").slice(0, CAP.culture) : "";

  const rules: TeamaiRule[] = [];
  const rulesDir = join(cloneDir, "rules");
  if (existsSync(rulesDir)) {
 // 两层形态都吃——扁平 rules/<name>.md(teamai 原生)与命名空间 rules/<ns>/<name>.md
 // (本仓 relay.teamai.push kind=rule 的落点,契约 §2.2)。此前只扫扁平层,
    // 导致 pushed 规则在 digest.counts.rules 里恒为 0(规则进得去团队仓、出不来投影)。
    const walk = (dir: string, prefix: string) => {
      for (const f of readdirSync(dir).sort()) {
        if (f.startsWith(".")) continue; // .removed 墓碑/隐藏文件跳过
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { walk(p, `${prefix}${f}/`); continue; }
        if (!f.endsWith(".md")) continue;
        if (rules.length >= CAP.totalRules) return;
        const stem = prefix + f.replace(/\.md$/, "");
        const base = f.replace(/\.md$/, "");
        const body = readFileSync(p, "utf-8");
        rules.push({
          name: stem,
          enforced: meta.enforcedRules.includes(f) || meta.enforcedRules.includes(stem) || meta.enforcedRules.includes(base),
          body: body.slice(0, CAP.ruleBody),
        });
      }
    };
    walk(rulesDir, "");
  }

  const skills: TeamaiSkill[] = [];
  const skillsDir = join(cloneDir, "skills");
  if (existsSync(skillsDir)) {
    for (const ns of readdirSync(skillsDir).sort()) {
      const nsDir = join(skillsDir, ns);
      if (ns.startsWith(".") || !statSync(nsDir).isDirectory()) continue; // .removed 墓碑
      for (const name of readdirSync(nsDir).sort()) {
        const skillDir = join(nsDir, name);
        const skillFile = join(skillDir, "SKILL.md");
        if (!statSync(skillDir).isDirectory() || !existsSync(skillFile)) continue;
        if (skills.length >= CAP.totalSkills) break;
        const body = readFileSync(skillFile, "utf-8");
        const fm = scanSkillFrontmatter(body);
        let contributors: string[] = [];
        const contribFile = join(skillDir, "CONTRIBUTORS");
        if (existsSync(contribFile)) contributors = readFileSync(contribFile, "utf-8").split("\n").map((x) => x.trim()).filter(Boolean);
        skills.push({ ns, name: fm.name || name, description: fm.description, contributors, body: body.slice(0, CAP.skillBody) });
      }
    }
  }

  const docs: string[] = [];
  listDocsDir(join(cloneDir, "docs"), "", docs);

  const envFile = join(cloneDir, "env", "env.yaml");
  const envVars = existsSync(envFile) ? parseEnvYaml(readFileSync(envFile, "utf-8")) : [];
  const secretsFile = join(cloneDir, "env", "secrets.yaml");
  let secretKeys: string[] = [];
  if (existsSync(secretsFile)) {
    // 红线:只出 key,值永不进 digest。
    secretKeys = parseEnvYaml(readFileSync(secretsFile, "utf-8")).map((v) => v.key);
  }

  const hooksFile = join(cloneDir, "hooks", "hooks.yaml");
  const hooks = existsSync(hooksFile) ? parseHookList(readFileSync(hooksFile, "utf-8")) : [];

  const readIf = (p: string, cap: number): string => (existsSync(join(cloneDir, p)) ? readFileSync(join(cloneDir, p), "utf-8").slice(0, cap) : "");
  const mcpRaw = readIf("mcp/mcp.yaml", CAP.mcpRaw);
  const modelsRaw = readIf("models/models.yaml", CAP.mcpRaw);
  const agentsRaw: string[] = [];
  const agentsDir = join(cloneDir, "agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).sort()) {
      if (f.endsWith(".yaml") && agentsRaw.length < 32) agentsRaw.push(readFileSync(join(agentsDir, f), "utf-8").slice(0, 2_000));
    }
  }

  // learnings:优先 fs(已合入 master);上游分支形态(refs 只在 git 里)由 relay 层补挂。
  const learnings = readLearningsDir(cloneDir);
  const roles = readRoles(cloneDir);
  const memberRoles = readMemberRoles(cloneDir);
  const counts = {
    members: countMemberFiles(cloneDir),
    skills: skills.length,
    rules: rules.length,
    docs: docs.length,
    learnings: learnings.length,
  };
  return { meta, culture, rules, skills, docs, envVars, secretKeys, hooks, learnings, mcpRaw, modelsRaw, agentsRaw, pulledAt, roles, counts, memberRoles };
}

/**
 * roster/members/*.yaml → username→roleId( §2.6)。
 * 只取 roleId(角色命名空间),不取 role(权限位 owner/reviewer/member)——两者同名不同义。
 */
function readMemberRoles(cloneDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = join(cloneDir, "roster", "members");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (f.startsWith(".") || !f.endsWith(".yaml")) continue;
    try {
      const raw = parseYamlLite(readFileSync(join(dir, f), "utf-8"));
      const username = String(raw.username ?? f.replace(/\.yaml$/, ""));
      const roleId = raw.roleId === undefined ? "" : String(raw.roleId);
      if (username && roleId) out[username] = roleId;
    } catch { /* 手编越界 yaml 跳过,不影响其它成员 */ }
  }
  return out;
}

/** roster/members/*.yaml 计数(只数文件,不解析成员内容)。 */
function countMemberFiles(cloneDir: string): number {
  const dir = join(cloneDir, "roster", "members");
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (f.startsWith(".") || !f.endsWith(".yaml")) continue;
    if (statSync(join(dir, f)).isFile()) n += 1;
  }
  return n;
}

/** 资源枚举面(teamai list 的数据源):技能/规则/文档/经验的扁平清单。 */
export function teamaiList(digest: TeamaiDigest): { kind: string; name: string; ns?: string }[] {
  const out: { kind: string; name: string; ns?: string }[] = [];
  for (const s of digest.skills ?? []) out.push({ kind: "skill", name: s.name, ns: s.ns });
  for (const r of digest.rules ?? []) out.push({ kind: "rule", name: r.name });
  for (const d of digest.docs ?? []) out.push({ kind: "doc", name: d });
  for (const l of digest.learnings ?? []) out.push({ kind: "learning", name: l.path });
  return out;
}

function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** cloneDir 侧按同一 key 口径收集资源全路径(digest key 与之一一对应)。 */
function cloneResourcePaths(cloneDir: string): Map<string, string> {
  const known = new Map<string, string>();
  // rules:扁平 rules/<name>.md 与命名空间 rules/<ns>/<name>.md 都收(两处口径必须同源,
 // 否则 status 会把已进 digest 的嵌套规则误报为 removed)。。
  const rulesDir = join(cloneDir, "rules");
  if (existsSync(rulesDir)) {
    const walkRules = (dir: string, keyPrefix: string) => {
      for (const f of readdirSync(dir).sort()) {
        if (f.startsWith(".")) continue;
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { walkRules(p, `${keyPrefix}${f}/`); continue; }
        if (f.endsWith(".md")) known.set(`rules/${keyPrefix}${f}`, p);
      }
    };
    walkRules(rulesDir, "");
  }
  const walk = (dir: string, keyPrefix: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      if (f.startsWith(".")) continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, `${keyPrefix}${f}/`);
      else known.set(keyPrefix + f, p);
    }
  };
  const skillsDir = join(cloneDir, "skills");
  if (existsSync(skillsDir)) {
    for (const ns of readdirSync(skillsDir).sort()) {
      if (ns.startsWith(".") || !statSync(join(skillsDir, ns)).isDirectory()) continue;
      for (const name of readdirSync(join(skillsDir, ns)).sort()) {
        const f = join(skillsDir, ns, name, "SKILL.md");
        if (existsSync(f)) known.set(`skills/${ns}/${name}/SKILL.md`, f);
      }
    }
  }
  walk(join(cloneDir, "docs"), "docs/");
  const learningsDir = join(cloneDir, "learnings");
  if (existsSync(learningsDir)) {
    for (const [k, p] of [...cloneResourcePathsOf(learningsDir, "learnings/")]) known.set(k, p);
  }
  return known;
}

/** learnings 目录单独走 .md 过滤(walk 通用版不限后缀,learnings 只认 md)。 */
function cloneResourcePathsOf(dir: string, keyPrefix: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(dir).sort()) {
    if (f.startsWith(".")) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      for (const [k, v] of cloneResourcePathsOf(p, `${keyPrefix}${f}/`)) out.set(k, v);
    } else if (f.endsWith(".md")) out.set(keyPrefix + f, p);
  }
  return out;
}

/** digest 侧资源 key→body(body 为截断视图,超大文件可能误报 changed,与 ref 的 hash 面同口径近似)。 */
function digestResourceBodies(digest: TeamaiDigest): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of digest.rules ?? []) out.set(`rules/${r.name}.md`, r.body ?? "");
  for (const s of digest.skills ?? []) out.set(`skills/${s.ns}/${s.name}/SKILL.md`, s.body ?? "");
  for (const d of digest.docs ?? []) out.set(`docs/${d}`, "");
  for (const l of digest.learnings ?? []) out.set(`learnings/${l.path}`, l.body ?? "");
  return out;
}

/**
 * 本地(克隆目录)vs digest 的内容 diff(对齐 teamai status 语义):
 * added=仓里有而 digest 无;removed=digest 有而仓里无;changed=同名不同内容(sha1 比对)。
 * 三数组均排序返回,便于面板/断言稳定。
 */
export function teamaiStatus(digest: TeamaiDigest, cloneDir: string): { added: string[]; removed: string[]; changed: string[] } {
  const fsSide = cloneResourcePaths(cloneDir);
  const digestSide = digestResourceBodies(digest);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  // docs 在 digest 里只有文件名、没有正文(既有语义),跳过内容比对,只做增删。
  const bodyless = (k: string) => k.startsWith("docs/");
  for (const key of fsSide.keys()) {
    if (!digestSide.has(key)) {
      added.push(key);
      continue;
    }
    if (bodyless(key)) continue;
    const body = digestSide.get(key) ?? "";
    if (sha1(body) !== sha1(readFileSync(fsSide.get(key)!, "utf-8"))) changed.push(key);
  }
  for (const key of digestSide.keys()) if (!fsSide.has(key)) removed.push(key);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export interface TeamaiFinding {
  level: "ok" | "warn" | "error";
  code: string;
  message: string;
}

/**
 * 团队仓健康度检查(设计对齐 teamai doctor,只查团队仓本身,不碰本地 AI 工具目录):
 * teamai.yaml 存在 / roster/members 非空且每份 yaml 可解析 / roles.yaml 的 skills·rules 引用可解析 /
 * learnings 目录或 teamai-learnings 分支存在。
 */
export function teamaiDoctor(cloneDir: string): { ok: boolean; findings: TeamaiFinding[] } {
  const findings: TeamaiFinding[] = [];

  if (existsSync(join(cloneDir, "teamai.yaml"))) {
    findings.push({ level: "ok", code: "teamai_yaml_ok", message: "teamai.yaml 存在" });
  } else {
    findings.push({ level: "error", code: "teamai_yaml_missing", message: "缺 teamai.yaml(不是团队仓根)" });
  }

  const membersDir = join(cloneDir, "roster", "members");
  const memberFiles = existsSync(membersDir)
    ? readdirSync(membersDir).filter((f) => f.endsWith(".yaml") && !f.startsWith(".")).sort()
    : [];
  if (!existsSync(membersDir)) {
    findings.push({ level: "error", code: "members_dir_missing", message: "缺 roster/members 目录" });
  } else if (memberFiles.length === 0) {
    findings.push({ level: "error", code: "members_empty", message: "roster/members 为空" });
  } else {
    let bad = 0;
    for (const f of memberFiles) {
      try {
        const parsed = parseYamlLite(readFileSync(join(membersDir, f), "utf-8"));
        if (!parsed || typeof parsed !== "object") bad += 1;
      } catch {
        bad += 1;
        findings.push({ level: "error", code: "member_unparsable", message: `成员文件不可解析:roster/members/${f}` });
      }
    }
    if (bad === 0) findings.push({ level: "ok", code: "members_ok", message: `成员 ${memberFiles.length} 份,yaml 均可解析` });
  }

  const roles = readRoles(cloneDir);
  if (roles.length === 0) {
    findings.push({ level: "warn", code: "roles_empty", message: "无 roster/roles.yaml 或角色为空(角色面未启用)" });
  } else {
    const skillNames = resolvableSkills(cloneDir);
    const ruleNames = resolvableRules(cloneDir);
    let refsOk = true;
    for (const role of roles) {
      for (const ref of role.skills) {
        if (!skillNames.has(ref)) {
          refsOk = false;
          findings.push({ level: "warn", code: "role_skill_missing", message: `角色 ${role.id} 引用技能不存在:${ref}` });
        }
      }
      for (const ref of role.rules) {
        if (!ruleNames.has(ref)) {
          refsOk = false;
          findings.push({ level: "warn", code: "role_rule_missing", message: `角色 ${role.id} 引用规则不存在:${ref}` });
        }
      }
    }
    if (refsOk) findings.push({ level: "ok", code: "role_refs_ok", message: `${roles.length} 个角色的 skills/rules 引用均可解析` });
  }

  const learningsDir = join(cloneDir, "learnings");
  if (existsSync(learningsDir)) {
    findings.push({ level: "ok", code: "learnings_dir_ok", message: "learnings/ 目录存在" });
  } else if (hasGitBranch(cloneDir, "teamai-learnings")) {
    findings.push({ level: "ok", code: "learnings_branch_ok", message: "learnings 走 teamai-learnings 分支" });
  } else {
    findings.push({ level: "warn", code: "learnings_missing", message: "既无 learnings/ 目录也无 teamai-learnings 分支" });
  }

  return { ok: findings.every((f) => f.level !== "error"), findings };
}

/** 技能引用可解析面:同时接受 `name` 与 `<ns>/<name>` 两种写法。 */
function resolvableSkills(cloneDir: string): Set<string> {
  const out = new Set<string>();
  const skillsDir = join(cloneDir, "skills");
  if (!existsSync(skillsDir)) return out;
  for (const ns of readdirSync(skillsDir)) {
    if (ns.startsWith(".") || !statSync(join(skillsDir, ns)).isDirectory()) continue;
    for (const name of readdirSync(join(skillsDir, ns))) {
      if (!existsSync(join(skillsDir, ns, name, "SKILL.md"))) continue;
      out.add(name);
      out.add(`${ns}/${name}`);
    }
  }
  return out;
}

/** 规则引用可解析面:同时接受 `name`、`name.md`、`<ns>/<name>`。 */
function resolvableRules(cloneDir: string): Set<string> {
  const out = new Set<string>();
  const rulesDir = join(cloneDir, "rules");
  if (!existsSync(rulesDir)) return out;
  const walk = (dir: string, prefix: string) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".")) continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        walk(p, `${prefix}${f}/`);
        continue;
      }
      if (!f.endsWith(".md")) continue;
      const stem = prefix + f.replace(/\.md$/, "");
      out.add(stem);
      out.add(`${stem}.md`);
      out.add(stem.split("/").pop()!);
    }
  };
  walk(rulesDir, "");
  return out;
}

/** 本地 git 分支存在性(fail-soft:非 git 目录/无 git 一律 false)。 */
function hasGitBranch(cloneDir: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", cloneDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/** teamai push 分支名约定(对齐 teamai-cli:teamai/push/<user>/<yyyyMMdd-HHmmss>)。 */
export function teamaiPushBranch(username: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const safeUser = String(username).replace(/[^A-Za-z0-9_-]/g, "") || "unknown";
  return `teamai/push/${safeUser}/${ts}`;
}

/** 名称安全校验(push 写路径防穿越:ns/name 只许安全字符)。 */
export function safeSkillPath(ns: string, name: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,48}$/i.test(ns) || !/^[a-z0-9][a-z0-9_-]{0,48}$/i.test(name)) return null;
  return `${ns}/${name}`;
}
