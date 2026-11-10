/**
 * 项目注册表(ZCode tabStore 的服务端等价物,ZCode packages/ui/src/store/tabStore.ts 形态移植):
 * 项目=workspace(path/label/availability);添加=校验绝对路径+存在+目录,realpath 去重;
 * 启动期一次性可用性校验(运行期不重检,ZCode 同语义);JSON 持久化;默认项目=harness 本体不可移除。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Journal, NewEvent } from "@lampgenie/core";
import { REMOTE_PROJECT_PREFIX, parseRemoteProject, remoteProjectLabel, remoteWslFromUncPath, type RemoteSshProject } from "./remote-project.js";

export type ProjectAvailability = "available" | "unavailable-local-directory" | "unavailable-remote-unverified" | "unavailable-remote-unreachable";

export interface ProjectEntry {
  id: string;
  /** 绝对路径(realpath 归一)。 */
  path: string;
  label: string;
  availability: ProjectAvailability;
  addedAt: number;
  /** 展示分类(2026-10-26,ZCode WorkspacePurpose 对齐):conversation=Agent cwd 兜底
   * (harness 根,不作为项目显示);project=用户显式添加的项目(显示在列表)。 */
  purpose?: "project" | "conversation";
}

export const HARNESS_PROJECT_ID = "__harness__";

interface Persisted {
  projects: ProjectEntry[];
  activeProjectId: string;
}

/** 路径可用性(ZCode:启动期一次,不持久化校验结果到下个会话的重检策略)。 */
function checkAvailability(path: string): ProjectAvailability {
  try {
    return statSync(path).isDirectory() ? "available" : "unavailable-local-directory";
  } catch {
    return "unavailable-local-directory";
  }
}

export class ProjectRegistry {
  private projects = new Map<string, ProjectEntry>();
  private activeProjectId: string;

  constructor(
    private readonly harnessRoot: string,
    /** 持久化文件;null=会话内态不落盘(测试/内存 journal 形态,与 MemoryJournal 同拍)。 */
    private readonly file: string | null,
  ) {
    this.activeProjectId = HARNESS_PROJECT_ID;
    // 默认项目=harness 本体,永在且不可移除(任务无项目时的回退)。
    this.projects.set(HARNESS_PROJECT_ID, {
      id: HARNESS_PROJECT_ID,
      path: harnessRoot,
      label: "harness",
      availability: "available",
      addedAt: 0,
      purpose: "conversation", // ZCode conversation backing workspace 同语义:Agent cwd 兜底,默认不作为项目显示
    });
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const p = JSON.parse(readFileSync(this.file!, "utf-8")) as Persisted;
      let migrated = false;
      for (const proj of p.projects ?? []) {
        if (!proj.path) continue;
        if (proj.id === HARNESS_PROJECT_ID) {
          // 2026-10-27 修复「显式添加 harness 根后每次刷新项目消失」:add() 置 purpose="project"
          // 并落盘,但此处整行跳过内建项目→重启回退 conversation→面板按 conversation 过滤掉,
          // 其会话随之落「任务」桶。内建行的 path/可用性/addedAt 仍用构造默认,只恢复 purpose。
          if (proj.purpose === "project") this.projects.get(HARNESS_PROJECT_ID)!.purpose = "project";
          continue;
        }
        // 存量迁移(2026-10-27):0.0.5 把 WSL 项目登记成 UNC 本地路径;现在按远端工作区
        // (remote:wsl:<distro>:<posix>,发行版内工作区服务)登记。读盘即转换并回写一次。
        const wslRemote = remoteWslFromUncPath(proj.path);
        if (wslRemote) {
          proj.path = wslRemote.identity;
          proj.label = remoteProjectLabel(wslRemote);
          migrated = true;
        }
        // 启动期一次性重校验(运行期不重检;ZCode availability 同语义)。
        // 远程项目不本地 statSync:远程 identity 在本地恒不存在,保持 unverified
        // (可达性由 node-agent 心跳与任务分派守卫负责,不在注册表层阻塞)。
        this.projects.set(proj.id, { ...proj, availability: proj.path.startsWith(REMOTE_PROJECT_PREFIX) ? "unavailable-remote-unverified" : checkAvailability(proj.path) });
      }
      if (p.activeProjectId && this.projects.has(p.activeProjectId)) {
        this.activeProjectId = p.activeProjectId;
      }
      if (migrated) this.persist();
    } catch {
      // 损坏文件容忍:默认态起步(只增不改的纪律在 add/persist,不在读)。
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const p: Persisted = { projects: [...this.projects.values()], activeProjectId: this.activeProjectId };
    writeFileSync(this.file, JSON.stringify(p, null, 2));
    // 2026-10-26 审计:项目表今日多次回滚到基础集(根因未锁定:并行会话/重启竞态/未知写者)。
    // 写者指纹落日志(调用栈 2 层),下次回滚可定位。
    try { console.error("[projects.audit] persist " + this.projects.size + "条[" + [...this.projects.values()].map((x) => x.label).join(",") + "] " + (new Error().stack || "").split("\n").slice(2, 4).map((x) => x.trim().slice(0, 90)).join(" <- ")); } catch { /* 审计失败不影响 */ }
  }

  /** 添加项目(ZCode addTab 等价):绝对路径+目录存在;realpath 去重(同目录重复添加=幂等返回已有)。 */
  /** 快照恢复(2026-10-21 会话 worker):host 注入网关侧项目表快照(worker 只读用,不落盘)。
   *  按 id/realpath 去重合入;activeId 仅在表内存在时生效。 */
  restore(entries: ProjectEntry[], activeId?: string): void {
    for (const e of entries) {
      if (!e || !e.id || !e.path) continue;
      const dupPath = [...this.projects.values()].find((p) => p.path === e.path);
      if (dupPath) continue;
      this.projects.set(e.id, { ...e });
    }
    if (activeId && this.projects.has(activeId)) this.activeProjectId = activeId;
  }

  add(inputPath: string): { ok: true; project: ProjectEntry } | { ok: false; reason: string } {
    if (!inputPath.trim()) return { ok: false, reason: "路径为空" };
    // 远程目录(remote:ssh:...,ZCode remote workspace identity 对齐):identity 归一去重,
    // 不做本地 statSync;可达性后续由 SSH 探测/节点心跳刷新(初始 unverified)。
    const remote = parseRemoteProject(inputPath);
    if (remote) {
      const dup = [...this.projects.values()].find((p) => p.path === remote.identity);
      if (dup) return { ok: true, project: dup };
      const entry: ProjectEntry = {
        id: randomUUID(),
        path: remote.identity,
        label: remoteProjectLabel(remote),
        availability: "unavailable-remote-unverified",
        addedAt: Date.now(),
      };
      this.projects.set(entry.id, entry);
      this.persist();
      return { ok: true, project: entry };
    }
    if (!isAbsolute(inputPath)) return { ok: false, reason: "必须是绝对路径" };
    if (!existsSync(inputPath)) return { ok: false, reason: "路径不存在" };
    let real: string;
    try {
      real = realpathSync(inputPath);
    } catch {
      return { ok: false, reason: "路径无法解析" };
    }
    if (!statSync(real).isDirectory()) return { ok: false, reason: "不是目录(项目=文件夹)" };
    if (real === this.harnessRoot) {
      // 2026-10-26:显式添加 harness 根 = 用户要求它作为项目(此前幂等返回但面板按默认过滤=「添加没反应」)。
      // ZCode 语义:conversation workspace 默认不显示,但用户显式打开/添加后即为 project。
      const hp = this.projects.get(HARNESS_PROJECT_ID)!;
      hp.purpose = "project";
      this.persist();
      return { ok: true, project: hp };
    }
    const dup = [...this.projects.values()].find((p) => p.path === real);
    if (dup) return { ok: true, project: dup };
    const entry: ProjectEntry = {
      id: randomUUID(),
      path: real,
      label: basename(real) || real,
      availability: "available",
      addedAt: Date.now(),
    };
    this.projects.set(entry.id, entry);
    this.persist();
    return { ok: true, project: entry };
  }

  /** 移除(harness 本体不可移除;不中断其运行中任务——workdir 解析自动回退)。 */
  remove(id: string): { ok: true } | { ok: false; reason: string } {
    if (id === HARNESS_PROJECT_ID) return { ok: false, reason: "harness 本体项目不可移除" };
    if (!this.projects.delete(id)) return { ok: false, reason: "项目不存在" };
    if (this.activeProjectId === id) this.activeProjectId = HARNESS_PROJECT_ID;
    this.persist();
    return { ok: true };
  }

  /** 重命名(仅显示名;path/availability 不动;harness 本体同样可改名)。 */
  rename(id: string, label: string): { ok: true } | { ok: false; reason: string } {
    const clean = label.trim();
    if (!clean) return { ok: false, reason: "名称为空" };
    if (clean.length > 80) return { ok: false, reason: "名称过长(≤80)" };
    const p = this.projects.get(id);
    if (!p) return { ok: false, reason: "项目不存在" };
    p.label = clean;
    this.persist();
    return { ok: true };
  }

  /** 激活(新任务的默认项目)。 */
  activate(id: string): { ok: true } | { ok: false; reason: string } {
    if (!this.projects.has(id)) return { ok: false, reason: "项目不存在" };
    this.activeProjectId = id;
    this.persist();
    return { ok: true };
  }

  /** 可用性刷新面(远程项目 SSH 探测回写;file=null 时只是内存态)。 */
  flush(): void {
    this.persist();
  }

  list(): ProjectEntry[] {
    return [...this.projects.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  /** 项目是否在册(归类判定面:harness 本体恒真;侧栏/清理用它区分「真项目」与「已移除引用」)。 */
  has(id: string): boolean {
    return this.projects.has(id);
  }

  activeId(): string {
    return this.activeProjectId;
  }

  /** workdir 解析:项目在且可用→项目路径;否则回退 harness 根(移除/不可用/无项目的任务都安全)。
   * 解析时实测目录存在(审计 R2 修复):availability 是注册时刻快照,项目目录被外部删除后
   * 快照仍是 available——查询/任务会打到死目录(sandbox 抛错、状态卡死)。 */
  resolveWorkdir(projectId?: string): string {
    if (!projectId) return this.harnessRoot;
    const p = this.projects.get(projectId);
    if (!p || p.availability !== "available") return this.harnessRoot;
    // 远程项目无本地工作目录:回退 harness 根(任务对远程的执行走 reachability 分派,
    // 本地 executor 不应把远程 identity 当本地路径用)。
    if (p.path.startsWith(REMOTE_PROJECT_PREFIX)) return this.harnessRoot;
    try {
      statSync(p.path).isDirectory();
      return p.path;
    } catch {
      return this.harnessRoot;
    }
  }
}

/** 项目移除后的任务引用清理(2026-10-14「已移除项目」残留根治):
 * 登记侧清 projectId(会话保留,侧栏落「任务」分区),journal 以专用事件 task.project.clear 落纠偏
 * (clearProjectRef 静默变更不 emit——终态任务重 emit 会以同 kind 重复计数,且幂等键
 * task.<id>.<state> 命中去重导致纠偏不落盘)。WS(project.remove)与 companion(project_remove)
 * 两个移除入口共用,防幽灵桶复发。
 *
 * 批量面(性能):支持一次处理多个项目 id,循环内只做 clearProjectRef 累积受影响任务,
 * 循环外用单次 appendMany 落盘——N 条 task.project.clear 事件只走一次 appendFileSync。
 * 空输入/无命中时不写盘(appendMany([]) 零 fs)。 */
export function cleanupProjectTaskRefs(
  journal: Pick<Journal, "appendMany">,
  clearProjectRef: (pid: string) => { id: string; sessionId: string }[],
  projectId: string | string[],
): { id: string; sessionId: string }[] {
  const pids = Array.isArray(projectId) ? projectId : [projectId];
  const touched: { id: string; sessionId: string }[] = [];
  for (const pid of pids) {
    touched.push(...clearProjectRef(pid));
  }
  if (touched.length > 0) {
    const events: NewEvent<{ id: string; sessionId: string }>[] = touched.map((t) => ({
      kind: "task.project.clear",
      sessionId: t.sessionId,
      payload: t,
      idempotencyKey: `task.${t.id}.project-clear`,
    }));
    journal.appendMany(events);
  }
  return touched;
}
