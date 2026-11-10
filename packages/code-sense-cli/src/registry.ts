/**
 * codesense 管理注册表(用户级):~/.codesense/registry.json。
 * 存储位置决策:
 *  - 注册表=用户级(os.homedir()):root 的价值在「任何目录下就近解析出所属项目」——
 *    项目内 .codesense/ 有先有鸡问题(init 之前不存在、无法被发现),且 aa/bb/整仓的
 *    跨目录复用天然是用户态视角;lampgenie-harness 同类先例(.zcode/config.json)也是
 *    workspace/用户级。Windows/macOS/Linux 统一走 os.homedir()+path.join,无硬编码路径。
 *  - 每仓文件指纹 sidecar 放项目内 <root>/.genie/sense-index/<hash>/files.json
 *    (与索引产物同目录):指纹与索引同进退(仓移动/清理 .genie 时一起消失,不会出现
 *    「注册表说有、盘上已无」的悬挂态),注册表本体只存轻量元数据。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { indexDir, loadIndex, type C2fIndex } from "@lampgenie/code-sense";

export interface RegistryEntry {
  /** 绝对路径(path.resolve 规范化,无尾分隔符)。 */
  root: string;
  name: string;
  registeredAt: number;
  lastIndexedAt: number;
  stats: { files: number; nodes: number; edges: number };
  lastBuild: { reused: number; scanned: number; buildMs: number; mode: "incremental" | "full" };
}

export interface Registry {
  version: 1;
  roots: RegistryEntry[];
}

export function registryDir(): string {
  return join(homedir(), ".codesense");
}

export function registryPath(): string {
  return join(registryDir(), "registry.json");
}

export function loadRegistry(): Registry {
  try {
    const raw = JSON.parse(readFileSync(registryPath(), "utf-8")) as Registry;
    if (raw && Array.isArray(raw.roots)) return { version: 1, roots: raw.roots };
  } catch {
    // 首次/损坏:空表起家(损坏不炸,下一次 upsert 覆盖)
  }
  return { version: 1, roots: [] };
}

export function saveRegistry(reg: Registry): void {
  mkdirSync(registryDir(), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
}

/** 路径规范化:绝对化+去尾分隔符(注册表匹配键)。 */
export function normalizeRoot(p: string): string {
  let r = resolve(p);
  while (r.length > 3 && r.endsWith(sep)) r = r.slice(0, -sep.length);
  return r;
}

export function upsertRoot(entry: RegistryEntry): void {
  const reg = loadRegistry();
  const i = reg.roots.findIndex((e) => normalizeRoot(e.root) === entry.root);
  if (i >= 0) reg.roots[i] = entry;
  else reg.roots.push(entry);
  saveRegistry(reg);
}

/** 注销(--purge 的数据删除由调用方做,这里只动注册表)。返回是否命中。 */
export function removeRoot(root: string): RegistryEntry | null {
  const norm = normalizeRoot(root);
  const reg = loadRegistry();
  const i = reg.roots.findIndex((e) => normalizeRoot(e.root) === norm);
  if (i < 0) return null;
  const [gone] = reg.roots.splice(i, 1);
  saveRegistry(reg);
  return gone ?? null;
}

/** 就近解析:从 startDir 逐级向上找注册表命中(最近优先);无注册命中再退
 * 「.genie/sense-index 索引产物在盘」的隐式根(零配置兼容 lampgenie-harness 形态)。 */
export function resolveProjectRoot(startDir: string): { root: string; source: "registry" | "index-artifact" } | null {
  const reg = loadRegistry();
  const registered = new Set(reg.roots.map((e) => normalizeRoot(e.root)));
  let dir = normalizeRoot(startDir);
  let artifactHit: string | null = null;
  for (;;) {
    if (registered.has(dir)) return { root: dir, source: "registry" };
    if (!artifactHit && existsSync(join(dir, ".genie", "sense-index"))) artifactHit = dir;
    const parent = dirnameOf(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return artifactHit ? { root: artifactHit, source: "index-artifact" } : null;
}

function dirnameOf(p: string): string {
  return resolve(p, ".."); // 根目录的自父级=自身,由调用方的 parent===dir 终止
}

/** 与 target 重叠的已登记 root(自身/祖先/后代),近者优先(路径更深更先)。
 * 增量复用的先验来源。 */
export function overlappingRoots(target: string): RegistryEntry[] {
  const t = normalizeRoot(target);
  const hit = loadRegistry().roots
    .filter((e) => {
      const p = normalizeRoot(e.root);
      return p === t || p.startsWith(t + sep) || t.startsWith(p + sep);
    })
    .sort((a, b) => normalizeRoot(b.root).length - normalizeRoot(a.root).length);
  return hit;
}

/** prior root 相对 target 的路径映射段:
 *  - prior === target → ""(同根,相对路径直用)
 *  - prior 是 target 的后代(如 target=/ws, prior=/ws/aa)→ "aa"(carry 时加前缀)
 *  - prior 是 target 的祖先(如 target=/ws/aa, prior=/ws)→ prior 下 target 子树的段 "aa"
 *    (carry 时剥前缀;只复用 prior 索引里落在 target 子树内的文件)
 * 不重叠=undefined(调用方保证不出现)。 */
export function priorSegment(target: string, priorRoot: string): string {
  const t = normalizeRoot(target);
  const p = normalizeRoot(priorRoot);
  if (p === t) return "";
  if (p.startsWith(t + sep)) return relative(t, p).split(sep).join("/");
  return relative(p, t).split(sep).join("/");
}

// ---- 指纹 sidecar(与索引同目录) ----

export interface FileFingerprint { mtime: number; size: number }
export interface FingerprintSidecar {
  /** v2:键=规范化绝对路径(realpath)——同一物理目录经不同父 cwd/路径拼写(符号链接)发起
   * 的 init/增量命中同一批指纹键;root=构建时的规范化绝对根。v1(相对路径键)载入即拒,
 * 诚实走全量并落 v2(二期)。 */
  version: 2;
  root: string;
  builtAt: number;
  /** 规范化绝对路径 → 指纹。 */
  files: Record<string, FileFingerprint>;
  /** 产出这批指纹的抽取器版本(engine INDEX_EXTRACTOR_VERSION;旧 sidecar 无此字段=
   * 隐式 v1)。增量复用闸必须比对它:源码未变但抽取器升级时指纹仍「相等」,不能复用
 * 旧抽取结果(验收缺口 1);不一致=版本迁移,全量重扫一次后落本字段。 */
  extractorVersion?: number;
  /** 全量构建时已知的类节点 rel id(增量合并重分类时的类豁免集;缺省=启发式兜底)。 */
  classes?: string[];
}

export function sidecarPath(root: string): string {
  return join(indexDir(root), "files.json");
}

/** 规范化绝对路径:realpath 解符号链接;失败(断链/竞争)退 resolve。 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function readSidecarAt(path: string, canon: string): FingerprintSidecar | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as FingerprintSidecar;
    if (!raw || raw.version !== 2 || !raw.files) return null; // v1/损坏:不可复用,诚实走全量
    if (raw.root === canon) return raw;
    // 迁移重映射:键都在(旧)根之下,整键换根前缀(旧根→当前根)。mtime/size 是物理文件
    // 属性,mv 不变——重映射只影响查得到查不到,指纹相等性仍是正确性闸门。
    // 父目录改名与叶子目录改名统一覆盖(不做「当前根须以旧根为前缀」的误判闸)。
    const oldRoot = raw.root;
    if (!oldRoot) return null;
    const files: Record<string, FileFingerprint> = {};
    let hit = 0;
    for (const [k, fp] of Object.entries(raw.files)) {
      if (k.startsWith(oldRoot + "/")) {
        files[canon + k.slice(oldRoot.length)] = fp;
        hit++;
      } else if (k === oldRoot) {
        files[canon] = fp;
        hit++;
      }
    }
    return hit > 0 ? { ...raw, root: canon, files } : null;
  } catch {
    return null;
  }
}

/** 载入 sidecar(v2)。indexDir 按根路径 hash——项目整体迁移(目录 mv/改名)后产物随目录
 * 走进旧 hash 子目录:精确路径未命中时扫描 sense-index 下各 hash 子目录的 files.json,
 * 取「可重映射到当前根」的最新者(诚实:无任何可重映射=v1 或损坏=走全量)。 */
export function loadSidecar(root: string): FingerprintSidecar | null {
  const canon = canonicalPath(root);
  const direct = readSidecarAt(sidecarPath(root), canon);
  if (direct) return direct;
  try {
    const base = join(root, ".genie", "sense-index");
    let best: FingerprintSidecar | null = null;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const cand = readSidecarAt(join(base, e.name, "files.json"), canon);
      if (cand && (!best || cand.builtAt > best.builtAt)) best = cand;
    }
    return best;
  } catch {
    return null;
  }
}

/** 索引产物发现式载入(迁移形态配套):index.json 与 sidecar 同目录,hash 随根路径变——
 * 迁移后精确路径未命中时扫描取最新。索引内 id/路径都是根相对口径,与根拼写无关,
 * 可安全用于增量搬运(指纹相等性仍是复用的正确性闸门)。 */
export function loadIndexMigrated(root: string): C2fIndex | null {
  const direct = loadIndex(root);
  if (direct) return direct;
  try {
    const base = join(root, ".genie", "sense-index");
    let best: C2fIndex | null = null;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        const cand = JSON.parse(readFileSync(join(base, e.name, "index.json"), "utf-8")) as C2fIndex;
        if (cand && Array.isArray(cand.nodes) && (!best || cand.builtAt > best.builtAt)) best = cand;
      } catch {
        continue;
      }
    }
    return best;
  } catch {
    return null;
  }
}

export function saveSidecar(root: string, sidecar: FingerprintSidecar): void {
  const dir = indexDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(sidecarPath(root), JSON.stringify(sidecar));
}

/** 当前盘上指纹(mtime+size;drvfs/网络盘 mtime 粒度足够区分编辑,size 兜底截断误判)。 */
export function statFingerprint(abs: string): FileFingerprint | null {
  try {
    const st = statSync(abs);
    return { mtime: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** 注销 + 可选清数据(整个 .genie/sense-index 目录——含迁移后遗留的旧 hash 子目录)。 */
export function purgeRootData(root: string): void {
  rmSync(join(root, ".genie", "sense-index"), { recursive: true, force: true });
}

/** 注册表条目构造(统计读现成索引,缺索引=零值)。 */
export function makeEntry(root: string, extra?: Partial<RegistryEntry>): RegistryEntry {
  const idx = loadIndex(root);
  return {
    root,
    name: basename(root),
    registeredAt: Date.now(),
    lastIndexedAt: Date.now(),
    stats: { files: idx ? Object.keys(idx.byFile).length : 0, nodes: idx?.nodes.length ?? 0, edges: idx?.edges.length ?? 0 },
    lastBuild: { reused: 0, scanned: 0, buildMs: 0, mode: "full" },
    ...extra,
  };
}
