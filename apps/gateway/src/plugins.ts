/**
 * 插件体系 + 市场(ZCode 插件市场对齐;架构=资产包安装器):
 * 插件 = 命令/技能/子智能体/MCP 服务器的资产包;安装=把资产写进真实落点
 * (commands→.genie/commands/*.md;agents→.genie/agents/*.md;mcp→.genie/mcp.json;
 * skills→experience store plugin-* category),卸载=按安装台账精确回收。
 * 目录=内置精选 + .genie/plugins-catalog.json 用户扩展(用户自备 zip/url/sha256 清单)。
 * 官方快照不再随包分发:officialMarketDir 指向的 assets/official-market 缺席时,
 * loadOfficialCatalog 按设计退化为空目录,官方源条目自然消失;插件安装机制(校验+解压到
 * .genie/plugins/<name>/,skills/commands/agents/.mcp.json 分发到既有落点,台账含 pluginDir,
 * 卸载一并回收)完整保留,zip 来源由用户目录清单给出。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, cpSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import {
  PLUGIN_ABI_INVALID,
  PLUGIN_CAPABILITY_UNKNOWN,
  PLUGIN_CONSENT_REQUIRED,
  PLUGIN_KILLED,
  PLUGIN_UNPINNED,
  buildPluginAudit,
  checkCapabilities,
  consentHash,
  isKilled,
  parseKillList,
  validateManifest,
  type AuditAsset,
  type KillEntry,
  type PluginAudit,
} from "./plugin-audit.js";

export interface PluginAssetCommand { name: string; body: string }
export interface PluginAssetAgent { name: string; description: string; systemPrompt: string; tools?: string[] }
export interface PluginAssetMcp { name: string; command: string; args?: string[] }
export interface PluginAssetSkill { name: string; description: string; body: string }

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  /** 目录来源:builtin(内置精选)/official(ZCode 官方市场)/user(plugins-catalog.json)。 */
  source?: "builtin" | "official" | "user";
  /** 官方市场条目的组件类型(skill/command/agent/mcp/hook/ui);ui 型面板无运行时,仅展示。 */
  componentTypes?: string[];
  /** 市场卡片图标(本地资产相对路径;缺省面板回退首字母徽标)。 */
  icon?: string;
  /** 目录 pin 字段(user catalog 可选):分发地址/压缩包/sha256;带 url|zip 必须有 sha256。 */
  url?: string;
  zip?: string;
  sha256?: string;
  provides: {
    commands?: PluginAssetCommand[];
    agents?: PluginAssetAgent[];
    mcp?: PluginAssetMcp[];
    skills?: PluginAssetSkill[];
  };
}

export interface InstalledPlugin {
  id: string;
  version: string;
  enabled: boolean;
  installedAt: number;
  /** 安装台账(卸载按此精确回收)。 */
  artifacts: {
    commandFiles?: string[];
    agentFiles?: string[];
    mcpIds?: string[];
    skillDirs?: string[];
    /** 官方包的解压目录名(.genie/plugins/<pluginDir>;卸载整目录回收)。 */
    pluginDir?: string;
  };
  /** 授权指纹(清单声明集的 consent hash;缺失=旧台账,加载态补写 migrated)。 */
  consentHash?: string;
  /** 授权时间(ms)。 */
  consentAt?: number;
  /** 授权/可用性状态:installed(正常)/needs-consent(清单已变更待重新授权)/killed(kill list)/
   * kept-unavailable(目录中找不到清单,资产原地保留)/migrated(旧台账补指纹)。 */
  status?: "installed" | "needs-consent" | "killed" | "kept-unavailable" | "migrated";
  /** 安装审计表(逐个资产的可用性结论;host 降级可查)。 */
  audit?: PluginAudit;
}

/** 内置精选目录(真实可用;扩展走 .genie/plugins-catalog.json)。 */
export const BUILTIN_PLUGIN_CATALOG: PluginManifest[] = [
  {
    id: "git-flow", name: "Git 工作流", version: "1.0.0", author: "genie", category: "开发",
    description: "分支态势报告 / 草拟提交信息 / 变更摘要三连命令",
    provides: {
      commands: [
        { name: "branch-report", body: "报告当前仓库分支态势:当前分支、领先/落后主干多少、最近 5 条提交、未提交变更文件数。只汇总事实。" },
        { name: "commit-draft", body: "为当前未提交变更草拟一条提交信息:动词开头一行式(≤50 字符),正文列 3 个要点;引用真实文件名,不臆造。" },
        { name: "diff-summary", body: "总结当前未提交变更:按「新增/修改/删除」三组列文件,并对每个修改文件给一行改动要点。" },
      ],
    },
  },
  {
    id: "tdd-pack", name: "测试驱动包", version: "1.1.0", author: "genie", category: "开发",
    description: "TDD 方法论技能 + 红-绿-重构推进命令",
    provides: {
      skills: [
        { name: "tdd-loop", description: "红-绿-重构循环推进:每步先测试后实现", body: "# 红绿重构推进\n1. 红:先写会失败的最小测试并跑出失败。\n2. 绿:最少实现让测试通过,不多写一行。\n3. 重构:绿灯下清理,每步保持绿。\n一次只红一个测试;重构与新增行为不混轮。" },
      ],
      commands: [
        { name: "tdd", body: "对 $ARG 走 TDD 循环:先写失败测试→跑出失败→最小实现→通过→重构。每步报告红/绿状态。" },
      ],
      agents: [
        { name: "test-driver", description: "测试驱动专员:只写测试与最小实现,步子极小", systemPrompt: "你是测试驱动专员。严格遵守红-绿-重构:先写会失败的最小测试并实际跑出失败,再写最少实现让其通过。一次只处理一个行为;绝不先写实现。", tools: [] },
      ],
    },
  },
  {
    id: "review-pack", name: "评审加強包", version: "1.0.0", author: "genie", category: "开发",
    description: "发布前检查单技能 + 深审命令",
    provides: {
      skills: [
        { name: "release-checklist", description: "发布前检查单:回归/边界/凭证/文档四组", body: "# 发布前检查\n- 回归:核心路径测试全绿;新改动对应的测试在列。\n- 边界:空输入/超长输入/并发/失败重试各查一处。\n- 凭证:diff 中无 key/token/密码;日志不回显敏感值。\n- 文档:README/AGENTS 与行为一致;新配置项有说明。" },
      ],
      commands: [
        { name: "deepreview", body: "深审当前仓库最近变更:按 正确性/风险/测试覆盖/可维护性/安全 五维度输出 findings,每条带 file:line 依据。" },
      ],
    },
  },
  {
    id: "ops-pack", name: "运维包", version: "1.0.0", author: "genie", category: "运维",
    description: "端口/进程/磁盘三查命令 + 系统排查技能",
    provides: {
      commands: [
        { name: "portcheck", body: "检查本机端口占用:ss -tlnp 输出解读,列出监听端口与进程,标注异常(未知进程/越权端口)。" },
        { name: "diskcheck", body: "检查磁盘与内存:df -h 与 free -h 输出解读,用量>80% 的分区/项标红并给清理建议。" },
      ],
      skills: [
        { name: "incident-triage", description: "故障排查五步:现状→变更→假设→最小验证→结论", body: "# 故障排查五步\n1. 现状:什么坏了、从何时起、影响面;读日志原文。\n2. 变更:最近一次相关变更(代码/配置/环境)是什么。\n3. 假设:列 2-3 个候选根因,按可能性排序。\n4. 最小验证:每个假设一个最小实验,一次只验一个。\n5. 结论:根因+证据+修复;写清为什么不是其他假设。" },
      ],
    },
  },
  {
    id: "docs-pack", name: "文档包", version: "1.0.0", author: "genie", category: "效率",
    description: "变更日志/使用说明两条文档命令",
    provides: {
      commands: [
        { name: "changelog", body: "根据最近 git 提交生成变更日志(Keep a Changelog 格式):Added/Changed/Fixed 三节,每条关联 commit 短哈希。" },
        { name: "howto", body: "为 $ARG 写一份使用说明:前置条件、三步上手、常见问题三条;基于仓库真实文件,不臆造路径。" },
      ],
    },
  },
  {
    id: "data-pack", name: "数据分析包", version: "1.0.0", author: "genie", category: "效率",
    description: "表格速览与数据体检命令",
    provides: {
      commands: [
        { name: "csvpeek", body: "速览 $ARG(csv 路径):行列数、前 5 行、每列类型推断、空值率;异常(全空列/重复表头)标注。" },
        { name: "jsonpeek", body: "速览 $ARG(json 路径):顶层结构、数组长度、关键字段采样 2 条;超大(>10MB)只读头部。" },
      ],
    },
  },
];

// ── 官方市场源(ZCode 官方插件市场快照; 集成)──

interface OfficialMarketEntry {
  name?: string;
  version?: string;
  category?: string;
  description?: string;
  description_i18n?: Record<string, string>;
  displayName?: string;
  displayName_i18n?: Record<string, string>;
  author?: { name?: string };
  componentTypes?: string[];
  source?: { url?: string; sha256?: string };
}

/** 快照目录:开发态 src/assets/official-market,生产环境态 dist/assets(随 gateway build 拷贝)。 */
export function officialMarketDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "assets", "official-market");
}

let officialCatalogCache: PluginManifest[] | undefined;

/** 官方清单 → PluginManifest(id=官方包名;provides 清单阶段为空,安装时从 zip 展开)。 */
export function loadOfficialCatalog(): PluginManifest[] {
  if (officialCatalogCache) return officialCatalogCache;
  const f = join(officialMarketDir(), "marketplace.json");
  let entries: OfficialMarketEntry[] = [];
  if (existsSync(f)) {
    try {
      const m = JSON.parse(readFileSync(f, "utf-8")) as { plugins?: OfficialMarketEntry[] };
      entries = Array.isArray(m.plugins) ? m.plugins.filter((p) => p && typeof p.name === "string") : [];
    } catch {
      // 坏清单容忍:退化为空目录
    }
  }
  officialCatalogCache = entries.map((e) => {
    const iconPath = join(officialMarketDir(), "icons", `${e.name}.png`);
    return {
      id: e.name!,
      // 展示名对齐 ZCode 市场:displayName_i18n(zh-CN)→displayName→包名
      name: e.displayName_i18n?.["zh-CN"] || e.displayName || e.name!,
      description: e.description_i18n?.["zh-CN"] || e.description || "",
      version: e.version || "0.0.0",
      author: e.author?.name || "ZCode 官方",
      category: e.category || "official",
      source: "official" as const,
      componentTypes: e.componentTypes,
      ...(existsSync(iconPath) ? { icon: `official-market/icons/${e.name}.png` } : {}),
      provides: {},
    };
  });
  return officialCatalogCache;
}

/** 官方包 zip 定位:快照 zips/ → 用户自拉缓存 .genie/plugins-cache/。 */
function locateOfficialZip(root: string, name: string, version: string): string | undefined {
  const rel = `${name}-${version}.zip`;
  for (const dir of [join(officialMarketDir(), "zips"), join(root, ".genie", "plugins-cache")]) {
    const zip = join(dir, rel);
    if (existsSync(zip)) return zip;
  }
  return undefined;
}

/** 官方清单条目元数据(version/sha256/url;安装校验与「未分发」提示用)。 */
export function officialEntryMeta(id: string): { version?: string; sha256?: string; url?: string } {
  const f = join(officialMarketDir(), "marketplace.json");
  if (!existsSync(f)) return {};
  try {
    const m = JSON.parse(readFileSync(f, "utf-8")) as { plugins?: OfficialMarketEntry[] };
    const hit = (m.plugins ?? []).find((p) => p.name === id);
    return hit ? { version: hit.version, sha256: hit.source?.sha256, url: hit.source?.url } : {};
  } catch {
    return {};
  }
}

/**
 * 最小 zip 解压(零依赖):central directory 遍历 + stored/deflate 两种压缩,
 * 目录条目跳过,路径穿越(../ 与绝对路径)拒绝。返回解出的相对路径。
 */
export function unzipInto(zipPath: string, destDir: string): string[] {
  const buf = readFileSync(zipPath);
  // EOCD 从尾部扫(结尾注释最长 64KB)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: EOCD 未找到(坏压缩包)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("zip: central directory 损坏");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || name.includes("..") || name.startsWith("/")) continue;
    // 本地头:数据区偏移 = localOff + 30 + 本地 name/extra 长度
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("zip: 本地头损坏");
    const lName = buf.readUInt16LE(localOff + 26);
    const lExtra = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lName + lExtra;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const content = method === 0 ? comp : method === 8 ? inflateRawSync(comp) : undefined;
    if (!content) throw new Error(`zip: 不支持的压缩方法 ${method}(${name})`);
    const dest = join(destDir, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    out.push(name);
  }
  return out;
}

export class PluginSystem {
  private installed = new Map<string, InstalledPlugin>();

  constructor(
    private readonly root: string,
    private readonly mcpAdd: (i: { name: string; command: string; args?: string[] }) => unknown,
    private readonly mcpRemove: (id: string) => boolean) {
    const f = join(root, ".genie", "plugins.json");
    if (existsSync(f)) {
      try {
        const arr = JSON.parse(readFileSync(f, "utf-8")) as InstalledPlugin[];
        for (const p of arr) if (p && p.id) this.installed.set(p.id, p);
      } catch {
        // 坏文件容忍
      }
    }
    // 加载态对账(kill list / 清单可得性 / 授权指纹);任何异常不外抛,只 persist 一次
    this.reconcileLoaded();
  }

  /** kill list(每次现读;坏文件=空——运维兜底不阻断正常安装)。 */
  private killList(): KillEntry[] {
    try {
      const f = join(this.root, ".genie", "plugin-kill-list.json");
      if (!existsSync(f)) return [];
      return parseKillList(readFileSync(f, "utf-8"));
    } catch {
      return [];
    }
  }

  /** pin 校验:官方条目必须有 sha256;user 条目带 url/zip 必须有 sha256;builtin 豁免。 */
  private pinIssue(m: PluginManifest): string | undefined {
    if (m.source === "official") {
      if (!officialEntryMeta(m.id).sha256) return `${PLUGIN_UNPINNED}: ${m.id} 官方条目缺少 sha256(无法定版)`;
      return undefined;
    }
    if (m.source === "user" && (m.url || m.zip) && !m.sha256) {
      return `${PLUGIN_UNPINNED}: ${m.id} 目录条目带 url/zip 但缺少 sha256(无法定版)`;
    }
    return undefined;
  }

  /** 安装前闸门(kill list → ABI → 能力 → pin):全部在写任何资产之前,fail-closed。 */
  private preflight(m: PluginManifest): { error: string } | undefined {
    const killed = isKilled(this.killList(), m.id, m.version);
    if (killed) return { error: `${PLUGIN_KILLED}: ${m.id}${killed.reason ? "(" + killed.reason + ")" : ""}` };
    const abi = validateManifest(m);
    if (!abi.ok) {
      const first = abi.issues[0];
      return { error: `${PLUGIN_ABI_INVALID}: ${first?.path ?? ""}: ${first?.message ?? "清单结构非法"}` };
    }
    const cap = checkCapabilities(m);
    if (!cap.ok) return { error: `${PLUGIN_CAPABILITY_UNKNOWN}: ${cap.unknown.join(",")}` };
    const pin = this.pinIssue(m);
    if (pin) return { error: pin };
    return undefined;
  }

  /**
   * 加载态对账(构造器末尾一次;任何异常都不得抛):
   * kill 命中 → 停用+回收资产(保留台账);清单不可读 → kept-unavailable(资产与 enabled 不动);
   * 无指纹(旧台账) → 补写指纹 migrated,保持 enabled;指纹不符 → needs-consent 停用(资产不激活不重写)。
   */
  private reconcileLoaded(): void {
    let dirty = false;
    try {
      const kills = this.killList();
      for (const rec of this.installed.values()) {
        try {
          if (isKilled(kills, rec.id, rec.version)) {
            if (rec.status !== "killed") {
              this.removeArtifactsOnly(rec);
              rec.status = "killed";
              rec.enabled = false;
              dirty = true;
            }
            continue;
          }
          const m = this.manifest(rec.id);
          if (!m) {
            if (rec.status !== "kept-unavailable") { rec.status = "kept-unavailable"; dirty = true; }
            continue;
          }
          const h = consentHash(m);
          if (!rec.consentHash) {
            rec.consentHash = h;
            rec.consentAt = rec.consentAt ?? Date.now();
            rec.status = "migrated";
            dirty = true;
            continue;
          }
          if (rec.consentHash !== h) {
            if (rec.enabled) this.removeArtifactsOnly(rec);
            rec.status = "needs-consent";
            rec.enabled = false;
            dirty = true;
          }
        } catch {
          // 单条记录异常不影响其它记录与启动
        }
      }
    } catch {
      // kill list / 目录读取异常:保持现状
    }
    if (dirty) {
      try {
        this.persist();
      } catch {
        // 落盘失败不阻断启动
      }
    }
  }

  private persist(): void {
    const f = join(this.root, ".genie", "plugins.json");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify([...this.installed.values()], null, 2) + "\n");
  }

  /** 市场目录 = 内置 + 官方市场快照 + 用户扩展(.genie/plugins-catalog.json)。 */
  catalog(): PluginManifest[] {
    const extra: PluginManifest[] = [];
    const f = join(this.root, ".genie", "plugins-catalog.json");
    if (existsSync(f)) {
      try {
        const arr = JSON.parse(readFileSync(f, "utf-8")) as PluginManifest[];
        for (const p of arr) if (p && p.id && p.provides) extra.push(p);
      } catch {
        // 坏目录容忍
      }
    }
    const byId = new Map<string, PluginManifest>();
    for (const p of [...BUILTIN_PLUGIN_CATALOG, ...loadOfficialCatalog(), ...extra]) byId.set(p.id, p);
    return [...byId.values()];
  }

  manifest(id: string): PluginManifest | undefined {
    return this.catalog().find((p) => p.id === id);
  }

  listInstalled(): InstalledPlugin[] {
    return [...this.installed.values()].sort((a, b) => b.installedAt - a.installedAt);
  }

  private writeAgentMd(a: PluginAssetAgent): string {
    return "---" + "\n" +
      "name: " + a.name + "\n" +
      "description: " + a.description.replace(/[\n\r]/g, " ") + "\n" +
      (a.tools?.length ? "tools: " + a.tools.join(",") + "\n" : "") +
      "---" + "\n\n" + a.systemPrompt + "\n";
  }

  /** 安装:资产写进真实落点(命令/agent 文件、MCP 注册、技能入库);官方包走 zip 展开。 */
  install(id: string): InstalledPlugin | { error: string } {
    const m = this.manifest(id);
    if (!m) return { error: "目录中无此插件:" + id };
    if (this.installed.has(id)) return { error: "已安装(如需重装先卸载)" };
    // kill list / ABI / 能力 / pin 全在写资产之前(fail-closed)
    const gate = this.preflight(m);
    if (gate) return gate;
    if (m.source === "official") return this.installOfficialPackage(m);
    const artifacts: InstalledPlugin["artifacts"] = {};
    const outcomes: AuditAsset[] = [];
    // 命令
    if (m.provides.commands?.length) {
      artifacts.commandFiles = [];
      const dir = join(this.root, ".genie", "commands");
      mkdirSync(dir, { recursive: true });
      for (const c of m.provides.commands) {
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(c.name)) return { error: "命令名非法:" + c.name };
        const rel = c.name + ".md";
        writeFileSync(join(dir, rel), c.body.trimEnd() + "\n", "utf-8");
        artifacts.commandFiles.push(rel);
        outcomes.push({ kind: "command", name: c.name, status: "ok" });
      }
    }
    // 子智能体
    if (m.provides.agents?.length) {
      artifacts.agentFiles = [];
      const dir = join(this.root, ".genie", "agents");
      mkdirSync(dir, { recursive: true });
      for (const a of m.provides.agents) {
        const rel = a.name + ".md";
        writeFileSync(join(dir, rel), this.writeAgentMd(a), "utf-8");
        artifacts.agentFiles.push(rel);
        outcomes.push({ kind: "agent", name: a.name, status: "ok" });
      }
    }
    // MCP 服务器(宿主注册失败=该资产降级,继续装其它资产,不整包回滚)
    if (m.provides.mcp?.length) {
      artifacts.mcpIds = [];
      for (const s of m.provides.mcp) {
        let r: { id?: string; error?: string } | undefined;
        try {
          r = this.mcpAdd({ name: s.name, command: s.command, args: s.args }) as { id?: string; error?: string };
        } catch (e) {
          outcomes.push({ kind: "mcp", name: s.name, status: "degraded", reason: (e as Error).message });
          continue;
        }
        if (r && r.error) {
          outcomes.push({ kind: "mcp", name: s.name, status: "degraded", reason: r.error });
          continue;
        }
        if (r && r.id) artifacts.mcpIds.push(r.id);
        outcomes.push({ kind: "mcp", name: s.name, status: "ok" });
      }
    }
    // 技能(experience store plugin-* category;SKILL.md 形态与 store 兼容)
    if (m.provides.skills?.length) {
      artifacts.skillDirs = [];
      for (const sk of m.provides.skills) {
        const dir = join(this.root, ".genie", "experiences", "plugin-" + id, sk.name);
        mkdirSync(dir, { recursive: true });
        const fm = "---" + "\n" +
          "category: plugin-" + id + "\n" +
          "name: " + sk.name + "\n" +
          "description: " + sk.description.slice(0, 60) + "\n" +
          "version: 1\n" +
          "created_by: user\n" +
          "created_at: " + new Date().toISOString() + "\n" +
          "status: active\n" +
          "---" + "\n\n" + sk.body + "\n";
        writeFileSync(join(dir, "SKILL.md"), fm, "utf-8");
        artifacts.skillDirs.push("plugin-" + id + "/" + sk.name);
        outcomes.push({ kind: "skill", name: sk.name, status: "ok" });
      }
    }
    // 全部资产降级/跳过(且本应有资产)→ 宿主不可用:回收已写资产,不写台账(不抛)
    if (outcomes.length && !outcomes.some((o) => o.status === "ok")) {
      this.removeArtifactsOnly({ id, version: m.version, enabled: true, installedAt: 0, artifacts });
      return { error: "host-unavailable" };
    }
    const now = Date.now();
    const rec: InstalledPlugin = {
      id, version: m.version, enabled: true, installedAt: now, artifacts,
      consentHash: consentHash(m), consentAt: now, status: "installed",
      audit: buildPluginAudit(m, outcomes),
    };
    this.installed.set(id, rec);
    this.persist();
    return rec;
  }

  /**
   * 官方包安装:zip 定位(快照/缓存)→sha256 校验→解压 .genie/plugins/<id>/(包结构
   * 完整保留:references/scripts 等运行资产随包)→commands/agents/skills/.mcp.json
   * 分发到既有落点。任一步失败回滚已写资产。
   */
  private installOfficialPackage(m: PluginManifest): InstalledPlugin | { error: string } {
    // 同样走闸门(解压前就拒:kill list / ABI / 能力 / pin 缺 sha256)
    const gate = this.preflight(m);
    if (gate) return gate;
    const meta = officialEntryMeta(m.id);
    const zip = locateOfficialZip(this.root, m.id, m.version);
    if (!zip) {
      return {
        error: `包体不可用(${m.id} ${meta.version ?? m.version}):市场快照不再随包分发,请在用户目录清单(.genie/plugins-catalog.json)里提供 zip/url 与 sha256`,
      };
    }
    if (meta.sha256) {
      const actual = createHash("sha256").update(readFileSync(zip)).digest("hex");
      if (actual !== meta.sha256) return { error: `sha256 校验失败(${m.id});请重跑 scripts/fetch-official-market.ts 刷新快照` };
    }
    const pluginsRoot = join(this.root, ".genie", "plugins");
    const tmp = join(pluginsRoot, ".tmp-" + randomUUID().slice(0, 8));
    let files: string[];
    try {
      files = unzipInto(zip, tmp);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      return { error: "解压失败:" + (e as Error).message };
    }
    if (!files.length) { rmSync(tmp, { recursive: true, force: true }); return { error: "空插件包:" + m.id }; }
    // zip 惯例有一层顶层包目录(<name>/...);单根且为目录则下钻
    let pkgDir = tmp;
    const tops = readdirSync(tmp);
    if (tops.length === 1 && statSync(join(tmp, tops[0]!)).isDirectory()) pkgDir = join(tmp, tops[0]!);
    const artifacts: InstalledPlugin["artifacts"] = {};
    const outcomes: AuditAsset[] = [];
    const fail = (msg: string): { error: string } => {
      this.removeArtifactsOnly({ id: m.id, version: m.version, enabled: true, installedAt: 0, artifacts });
      rmSync(tmp, { recursive: true, force: true });
      return { error: msg };
    };
    // commands/*.md → .genie/commands/(存在即冲突,防覆盖他人资产)
    const cmdDir = join(pkgDir, "commands");
    if (existsSync(cmdDir)) {
      artifacts.commandFiles = [];
      const dest = join(this.root, ".genie", "commands");
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(cmdDir)) {
        if (!f.endsWith(".md")) continue;
        if (existsSync(join(dest, f))) return fail("命令文件已存在(与其他插件/用户文件冲突):" + f);
        cpSync(join(cmdDir, f), join(dest, f));
        artifacts.commandFiles.push(f);
        outcomes.push({ kind: "command", name: f.replace(/\.md$/, ""), status: "ok" });
      }
    }
    // agents/*.md → .genie/agents/
    const agentDir = join(pkgDir, "agents");
    if (existsSync(agentDir)) {
      artifacts.agentFiles = [];
      const dest = join(this.root, ".genie", "agents");
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(agentDir)) {
        if (!f.endsWith(".md")) continue;
        if (existsSync(join(dest, f))) return fail("子智能体文件已存在(与其他插件/用户文件冲突):" + f);
        cpSync(join(agentDir, f), join(dest, f));
        artifacts.agentFiles.push(f);
        outcomes.push({ kind: "agent", name: f.replace(/\.md$/, ""), status: "ok" });
      }
    }
    // skills/<skill>/SKILL.md → experiences plugin-<id>/<skill>/(整目录含内部 references)
    const skillsDir = join(pkgDir, "skills");
    if (existsSync(skillsDir)) {
      artifacts.skillDirs = [];
      for (const s of readdirSync(skillsDir)) {
        if (!existsSync(join(skillsDir, s, "SKILL.md"))) continue;
        const rel = "plugin-" + m.id + "/" + s;
        const dest = join(this.root, ".genie", "experiences", rel);
        if (existsSync(dest)) return fail("技能目录已存在:" + rel);
        cpSync(join(skillsDir, s), dest, { recursive: true });
        artifacts.skillDirs.push(rel);
        outcomes.push({ kind: "skill", name: s, status: "ok" });
      }
    }
    // .mcp.json → mcpAdd(仅 stdio 型带 command 的;disabled 跳过)
    const mcpFile = join(pkgDir, ".mcp.json");
    if (existsSync(mcpFile)) {
      try {
        const mc = JSON.parse(readFileSync(mcpFile, "utf-8")) as {
          mcpServers?: Record<string, { command?: string; args?: string[]; disabled?: boolean }>;
        };
        const servers = Object.entries(mc.mcpServers ?? {}).filter(([, c]) => c?.command && !c.disabled);
        if (servers.length) {
          artifacts.mcpIds = [];
          for (const [name, cfg] of servers) {
            let r: { id?: string; error?: string } | undefined;
            try {
              r = this.mcpAdd({ name, command: cfg.command!, args: cfg.args }) as { id?: string; error?: string };
            } catch (e) {
              outcomes.push({ kind: "mcp", name, status: "degraded", reason: (e as Error).message });
              continue;
            }
            if (r && r.error) {
              outcomes.push({ kind: "mcp", name, status: "degraded", reason: r.error });
              continue;
            }
            if (r && r.id) artifacts.mcpIds.push(r.id);
            outcomes.push({ kind: "mcp", name, status: "ok" });
          }
        }
      } catch (e) {
        // 坏 .mcp.json:MCP 部分跳过(skipped),其余资产照装
        outcomes.push({ kind: "mcp", name: "(mcp.json)", status: "skipped", reason: (e as Error).message });
      }
    }
    // 全部资产降级/跳过 → 宿主不可用:回滚已写资产,不落包目录、不写台账
    if (outcomes.length && !outcomes.some((o) => o.status === "ok")) return fail("host-unavailable");
    // 包目录定稿(覆盖旧残留)+ 台账
    mkdirSync(pluginsRoot, { recursive: true });
    rmSync(join(pluginsRoot, m.id), { recursive: true, force: true });
    renameSync(pkgDir, join(pluginsRoot, m.id));
    rmSync(tmp, { recursive: true, force: true });
    artifacts.pluginDir = m.id;
    const now = Date.now();
    const rec: InstalledPlugin = {
      id: m.id, version: m.version, enabled: true, installedAt: now, artifacts,
      consentHash: consentHash(m), consentAt: now, status: "installed",
      audit: buildPluginAudit(m, outcomes),
    };
    this.installed.set(m.id, rec);
    this.persist();
    return rec;
  }

  /** 卸载:按台账精确回收(只删自己装进去的)。 */
  uninstall(id: string): boolean {
    const rec = this.installed.get(id);
    if (!rec) return false;
    for (const rel of rec.artifacts.commandFiles ?? []) {
      const p = join(this.root, ".genie", "commands", rel);
      if (existsSync(p)) rmSync(p);
    }
    for (const rel of rec.artifacts.agentFiles ?? []) {
      const p = join(this.root, ".genie", "agents", rel);
      if (existsSync(p)) rmSync(p);
    }
    for (const mid of rec.artifacts.mcpIds ?? []) this.mcpRemove(mid);
    for (const rel of rec.artifacts.skillDirs ?? []) {
      const p = join(this.root, ".genie", "experiences", rel);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      // 空分类目录顺手清理(fs.rm 删目录必须 recursive;裸 rmSync 对目录抛 EISDIR
 // 且被 catch 吞掉——多技能插件的分类目录曾长期静默残留, 修复)
      const cat = dirname(p);
      try {
        if (existsSync(cat) && readdirSync(cat).length === 0) rmSync(cat, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }
    // 官方包解压目录(包结构整体回收)
    if (rec.artifacts.pluginDir) {
      const p = join(this.root, ".genie", "plugins", rec.artifacts.pluginDir);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
    this.installed.delete(id);
    this.persist();
    return true;
  }

  /** 启停:停用=移除资产但保留台账(记录 disabled);启用=重写资产。 */
  toggle(id: string, enabled: boolean): InstalledPlugin | { error: string } {
    const rec = this.installed.get(id);
    if (!rec) return { error: "未安装:" + id };
    if (enabled && rec.status === "killed") return { error: `${PLUGIN_KILLED}: ${id}(kill list 命中,禁止启用)` };
    if (enabled && rec.status === "needs-consent") {
      return { error: `${PLUGIN_CONSENT_REQUIRED}: ${id} 清单已变更,请重新授权(reconsent)` };
    }
    if (enabled && !rec.enabled) {
      // 重装资产(保留原 installedAt)
      this.installed.delete(id);
      const r = this.install(id);
      if ("error" in r) { this.installed.set(id, rec); this.persist(); return r; }
      const nr = r as InstalledPlugin;
      nr.installedAt = rec.installedAt;
      this.installed.set(id, nr);
      this.persist();
      return nr;
    }
    if (!enabled && rec.enabled) {
      const keep = { ...rec, enabled: false };
      this.removeArtifactsOnly(rec);
      this.installed.set(id, keep);
      this.persist();
      return keep;
    }
    return rec;
  }

  /**
   * 重新授权:仅对 needs-consent / kept-unavailable 且清单可读的记录生效。
   * 重新走 install 流程(重新校验 + 写资产 + 新指纹),保留原 installedAt。
   */
  reconsent(id: string): InstalledPlugin | { error: string } {
    const rec = this.installed.get(id);
    if (!rec) return { error: "未安装:" + id };
    if (rec.status !== "needs-consent" && rec.status !== "kept-unavailable") {
      return { error: "无需重新授权:" + id };
    }
    const m = this.manifest(id);
    if (!m) return { error: "目录中无此插件:" + id };
    this.removeArtifactsOnly(rec);
    this.installed.delete(id);
    const r = this.install(id);
    if ("error" in r) {
      this.installed.set(id, rec);
      this.persist();
      return r;
    }
    const nr = r as InstalledPlugin;
    nr.installedAt = rec.installedAt;
    this.installed.set(id, nr);
    this.persist();
    return nr;
  }

  private removeArtifactsOnly(rec: InstalledPlugin): void {
    for (const rel of rec.artifacts.commandFiles ?? []) {
      const p = join(this.root, ".genie", "commands", rel);
      if (existsSync(p)) rmSync(p);
    }
    for (const rel of rec.artifacts.agentFiles ?? []) {
      const p = join(this.root, ".genie", "agents", rel);
      if (existsSync(p)) rmSync(p);
    }
    for (const mid of rec.artifacts.mcpIds ?? []) this.mcpRemove(mid);
    for (const rel of rec.artifacts.skillDirs ?? []) {
      const p = join(this.root, ".genie", "experiences", rel);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      const cat = dirname(p);
      try {
        if (existsSync(cat) && readdirSync(cat).length === 0) rmSync(cat, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }
    if (rec.artifacts.pluginDir) {
      const p = join(this.root, ".genie", "plugins", rec.artifacts.pluginDir);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
  }
}
