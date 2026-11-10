/**
 * per-session 主模型覆盖(白板「per-session 主模型」服务端半边)。
 * 语义(按 ZCode 的完整模型切换逻辑):
 *  - 每个 session 独立主模型;未设置 session 沿用全局 coding.llm(现状零变化);
 *  - 选择 = (model, providerId?, effort?) 对;端点/协议/凭证由**拥有该模型的 Provider** 派生
 *    (跨端点切换绝不带旧 baseUrl/apiKeyEnv;见 resolveSessionModelRef);
 *  - 运行中任务持启动时引用(set 不热切全局 provider、不动全局 config);
 *  - 选择持久化 .genie/session-models.json(Record<sid, {model,providerId?,effort?,revision,updatedAt}>);
 *    读写失败 fail-soft 不抛;
 *  - 变更串行化(照抄 zcode `runSessionModelConfigMutation` 的临界区语义)+ 可选
 *    expectedRevision(CAS):并发写不交错、过期写入被拒;
 *  - 写入后失效派生 provider 缓存(store.onChange → face 缓存逐出)。
 * 本文件只做合并/路由派生/存取与装配面,凭证解析细节在 model-switch.ts / factory.ts。
 * 重写要点(相对旧版):① 预检在写盘前(api 层);② 合并时重解析路由;
 * ③ revision/CAS + 串行临界区;④ 派生缓存失效(不再按 sid 永驻)。
 * 补齐(ZCode 模型切换链路后端遗漏 m1/m2/m3/m5/m7/m8/m10):
 *  - m2 多进程写不丢:每次写入前按 mtime/size 比对重新读盘(读-合并-写),读取路径读前比对
 *    (worker 子进程与主进程交替写不再互相覆盖条目);
 *  - m3 contextWindow 随会话模型重算(face.contextWindowFor → 调用方覆盖启动时定值);
 *  - m5 clear(sid) + all()/读取路径 prune 上限(超出按最旧清理);
 *  - m7 会话级 effort(override.effort ?? 全局 implementationEffort);
 *  - m8 copy 走 serialize 临界区 + 读盘合并(与 set 同机制、不交错);
 *  - m10 model.switch 审计补 oldModel/oldProviderId;悬空 providerId 清理(保留 model)。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelMetaOf, resolveCodingModelRoute, type Config, type ModelRouteRef } from "@lampgenie/core";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";
import { resolveModelSwitch, validateEffortOverride, type EffectiveModel } from "./model-switch.js";
import { applySessionModelToRoles, buildLlmFromConfig, buildModelProviders } from "./factory.js";

/** 一个 session 的主模型覆盖选择(ZCode Provider Registry 语义的最小子集:选择=(model, providerId?, effort?))。 */
export interface SessionModelOverride {
  model: string;
  providerId?: string;
  /** 会话级思考档(low/medium/high/xhigh;""=显式关)。缺省=跟随全局 coding.llm.implementationEffort。
   * 取值域与 effort-policy 同源(model-switch.validateSessionEffort 校验)。 */
  effort?: string;
}

/** 落盘条目:覆盖选择 + 该会话的写入版本(revision 单调递增,用于 CAS/回包对账)+ 写入时刻(prune 排序)。 */
export interface SessionModelEntry extends SessionModelOverride {
  revision: number;
  /** 最后一次写入的毫秒时间戳;旧条目缺失=按 0 处理(prune 时视为最旧)。 */
  updatedAt?: number;
}

/** all()/读取路径的条目上限:超出按「最旧(updatedAt,其次 revision)」清理,防覆盖表无界增长。 */
export const SESSION_MODEL_PRUNE_LIMIT = 500;

/** 条目 → 纯选择视图(剥 revision/updatedAt;空 effort 也保留,区分「显式关」与「未设置」)。 */
function pickOverride(e: SessionModelOverride): SessionModelOverride {
  return {
    model: e.model,
    ...(e.providerId ? { providerId: e.providerId } : {}),
    ...(typeof e.effort === "string" ? { effort: e.effort } : {}),
  };
}

/**
 * 覆盖 → coding.llm 引用的纯合并(不带 config 时只做字段级合并,旧语义;测试与轻量调用面用)。
 * 带 config 时走 Registry 语义(resolveSessionModelRef):合并后重新解析路由,不留半切换。
 */
export function resolveSessionModel<T extends object>(globalRef: T, override?: SessionModelOverride, config?: Config): T {
  if (!override) return globalRef;
  if (config) return resolveSessionModelRef(config, override) as unknown as T;
  return { ...globalRef, model: override.model, ...(override.providerId ? { providerId: override.providerId } : {}) } as T;
}

/**
 * 悬空 providerId 清理(m10 后半):会话覆盖里的 providerId 已不在配置的 providers[] 中
 * (Provider 被删除/改名)→ 清理该 providerId、保留 model(按模型解析路由会有自愈机会),
 * 并给出可操作 warning。返回 cleaned=true 时调用方应把清理后的选择**落盘**(覆盖表自愈)。
 */
export function sanitizeSessionOverride(
  config: Config,
  override: SessionModelOverride): { override: SessionModelOverride; warning?: string; cleaned?: boolean; danglingProviderId?: string } {
  if (!override.providerId) return { override };
  const known = new Set(config.providers.map((p) => p.id));
  if (known.has(override.providerId)) return { override };
  const dangling = override.providerId;
  return {
    override: pickOverride({ model: override.model, ...(typeof override.effort === "string" ? { effort: override.effort } : {}) }),
    cleaned: true,
    danglingProviderId: dangling,
    warning: `会话覆盖的 Provider「${dangling}」已不在配置中(Provider 已删除/改名),已清理该 providerId(保留模型 ${override.model} 并按模型重新解析路由)`,
  };
}

/**
 * 覆盖 → coding.llm 引用(Registry 语义:选择即 (model, providerId) 对,路由永远由拥有该模型的
 * Provider 派生,参照 packages/core/src/config/model-route.ts)。
 * 重置口径(修「跨端点切换带旧 baseUrl/apiKeyEnv」):
 *  - providerId 变了(跨 Provider 切换)→ 旧端点/旧凭证键一律不继承;
 *  - 全局 baseUrl 不是任何 Provider 端点(用户自定义代理/旧 env 压顶)→ 同样不继承
 *    (否则新模型会被打到旧代理端点上,形成「模型来自 A 家、端点/钥匙还是 B 家」)。
 * 其余情况(同 Provider 换模型)保留全局 route 字段,只换 model。
 * m10:override.providerId 指向已删除的 Provider → 先 sanitize(保留 model、清 providerId),warn 一次。
 */
export function resolveSessionModelRef(config: Config, override: SessionModelOverride): ModelRouteRef & Record<string, unknown> {
  const sane = sanitizeSessionOverride(config, override);
  if (sane.warning) console.warn(`[session-model] ${sane.warning}`);
  const ov = sane.override;
  const base = config.coding.llm as ModelRouteRef & Record<string, unknown>;
  const providerChanged = ov.providerId !== undefined && ov.providerId !== base.providerId;
  const providerBaseUrls = new Set(config.providers.map((p) => p.baseUrl).filter((u): u is string => Boolean(u)));
  const baseUrlCustom = typeof base.baseUrl === "string" && base.baseUrl.length > 0 && !providerBaseUrls.has(base.baseUrl);
  const merged: Record<string, unknown> = { ...base, model: ov.model };
  if (ov.providerId) merged.providerId = ov.providerId;
  if (providerChanged || baseUrlCustom) {
    delete merged.baseUrl;
    delete merged.apiKeyEnv;
  }
  const route = resolveCodingModelRoute(config, merged as ModelRouteRef);
  return {
    ...merged,
    ...(route.baseUrl !== undefined ? { baseUrl: route.baseUrl } : {}),
    apiKeyEnv: route.apiKeyEnv,
    ...(route.providerId ? { providerId: route.providerId } : {}),
  };
}

/** store 文件路径:<root>/.genie/session-models.json(root=repoRoot)。 */
export function sessionModelsPath(root: string): string {
  return join(root, ".genie", "session-models.json");
}

/** 覆盖表文件的「版本戳」(mtime+size):跨进程写变更的判定口;文件不存在/stat 失败 → "absent"。 */
function fileStamp(root: string): string {
  try {
    const st = statSync(sessionModelsPath(root));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "absent";
  }
}

/** 读取落盘条目(含 revision);文件不存在/损坏 → {}(fail-soft,不抛)。 */
function readEntries(root: string): Record<string, SessionModelEntry> {
  try {
    const raw = readFileSync(sessionModelsPath(root), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, SessionModelEntry> = {};
    for (const [sid, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const model = (v as { model?: unknown }).model;
      if (typeof model !== "string" || !model) continue; // 无 model 的条目=无效,静默丢弃
      const providerId = (v as { providerId?: unknown }).providerId;
      const rev = (v as { revision?: unknown }).revision;
      const effort = (v as { effort?: unknown }).effort;
      const updatedAt = (v as { updatedAt?: unknown }).updatedAt;
      out[sid] = {
        model,
        ...(typeof providerId === "string" && providerId ? { providerId } : {}),
        // effort:"" = 用户显式关(与「字段缺失=跟随全局」区分),故只按 typeof string 收
        ...(typeof effort === "string" ? { effort } : {}),
        revision: typeof rev === "number" && Number.isFinite(rev) && rev >= 0 ? Math.floor(rev) : 0,
        ...(typeof updatedAt === "number" && Number.isFinite(updatedAt) ? { updatedAt: Math.floor(updatedAt) } : {}),
      };
    }
    return out;
  } catch {
    return {}; // ENOENT / 坏 JSON / 权限:一律按「无覆盖」处理(设置页仍可重新写)
  }
}

/** 读取 per-session 覆盖表(剥掉 revision,纯选择视图);不存在/损坏 → {}(fail-soft)。 */
export function loadSessionModels(root: string): Record<string, SessionModelOverride> {
  const entries = readEntries(root);
  const out: Record<string, SessionModelOverride> = {};
  for (const [sid, e] of Object.entries(entries)) out[sid] = pickOverride(e);
  return out;
}

/** 原子写(tmp+rename,参照 writeProjectConfig);失败 fail-soft(console.warn,不抛)。
 * 返回是否真的落盘成功(store 据此决定是否还能信任自己的内存副本)。 */
export function saveSessionModels(root: string, map: Record<string, SessionModelOverride | SessionModelEntry>): boolean {
  const file = sessionModelsPath(root);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".tmp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", "utf-8");
    renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn(`[session-model] 覆盖表写入失败(${file}):${String(err).slice(0, 160)}`);
    return false;
  }
}

/** prune 上限:超出按 updatedAt(缺失=最旧)、再按 revision 升序清理;返回新表与被清理的 sid。 */
function pruneEntries(entries: Record<string, SessionModelEntry>, limit = SESSION_MODEL_PRUNE_LIMIT): { next: Record<string, SessionModelEntry>; dropped: string[] } {
  const keys = Object.keys(entries);
  if (keys.length <= limit) return { next: entries, dropped: [] };
  const ordered = [...keys].sort((a, b) => {
    const ea = entries[a]!;
    const eb = entries[b]!;
    const dt = (ea.updatedAt ?? 0) - (eb.updatedAt ?? 0);
    if (dt !== 0) return dt;
    if (ea.revision !== eb.revision) return ea.revision - eb.revision;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const dropped = ordered.slice(0, keys.length - limit);
  const next = { ...entries };
  for (const sid of dropped) delete next[sid];
  return { next, dropped };
}

/** 一次写入的结果:CAS 失败=ok:false(不落盘),成功=ok:true + 新 revision。 */
export type SessionModelWriteResult =
  | { ok: true; revision: number }
  | { ok: false; code: "revision-mismatch"; revision: number; message: string };

/** set/get 处理器与派生面共用的最小 store 面(main.ts load-once 注入 app)。 */
export interface SessionModelStore {
  get(sid: string): SessionModelOverride | undefined;
  /** 该会话当前写入版本(无条目=0)。 */
  revision(sid: string): number;
  /**
   * 写入覆盖(override=null 表示清除、回到跟随全局)。
   * expectedRevision 给定时做 CAS:与当前 revision 不符 → ok:false 且**不落盘**。
   */
  set(sid: string, override: SessionModelOverride | null, opts?: { expectedRevision?: number }): SessionModelWriteResult;
  /** 清除该会话覆盖(= set(sid,null));返回是否原本有覆盖(m5:删/归档会话时调用)。 */
  clear(sid: string): boolean;
  /** 全表纯选择视图(不含 revision);读取路径顺带 trip prune 上限(超出按最旧清理)。 */
  all(): Record<string, SessionModelOverride>;
  /**
   * 把 from 会话的覆盖复制给 to(会话分叉继承);无覆盖 → undefined。
   * m8:走 serialize 临界区 + 写前读盘合并,与并发 set 不交错、不丢条目。
   */
  copy(from: string, to: string): Promise<SessionModelOverride | undefined>;
  /** 丢弃进程内缓存,下次读回落到盘(外部写入/多实例场景的失效口)。 */
  invalidate(): void;
  /** 变更订阅(派生 provider 缓存的失效口);返回退订函数。 */
  onChange(listener: (sid: string) => void): () => void;
  /** 串行临界区:同一 store 的模型变更按提交顺序执行(zcode model-config-mutation 语义)。 */
  serialize<T>(op: () => T | Promise<T>): Promise<T>;
}

/** 单飞(串行)变更队列:失败只结束本次操作,不污染后续 tail。 */
export function createMutationQueue(): <T>(op: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(op: () => T | Promise<T>): Promise<T> => {
    const current = tail.then(() => op());
    tail = current.then(
      () => undefined,
      () => undefined);
    return current;
  };
}

/** 进程内 store:首次读盘缓存,后续 set 内存+落盘同走 saveSessionModels。
 * revision 语义:该会话覆盖的写入版本,每次成功写入(含 null 清除)+1;0=从未写/无覆盖。
 * 有覆盖时 revision 随条目落盘(重启后仍在);清除覆盖后条目消失 → 同进程内保留计数
 * (CAS 仍能识别「刚才那版已被我清掉」),重启后归 0(无条目=无版本,语义自洽)。
 * 多进程一致性(m2:worker 子进程与主进程交替写):不要求跨进程文件锁——用
 * 「tmp+rename 原子写 + **写前 stat 比对读盘合并**」即可:
 *  - 每次写入前 refresh():盘上 mtime/size 变过 → 重载(别进程写的新条目进内存);
 *  - 读取路径同样先 refresh():别进程刚写的覆盖立刻可见(不再 load-once 卡住旧值);
 *  - 落盘失败(fail-soft)后进入「内存优先」模式:不再自动重载,避免丢掉本进程刚生效的覆盖。
 */
export function createSessionModelStore(root: string): SessionModelStore {
  let cache: Record<string, SessionModelEntry> | undefined;
  /** 上次与盘对齐时的版本戳;dirtened 期间不比对(见下)。 */
  let stamp: string | undefined;
  /** 落盘失败 → 内存副本是「唯一真相」,停止自动重载(否则刚写进内存的覆盖会被旧盘覆盖)。 */
  let memoryOnly = false;
  const revs = new Map<string, number>();
  const listeners = new Set<(sid: string) => void>();
  const serialize = createMutationQueue();

  const absorb = (entries: Record<string, SessionModelEntry>) => {
    for (const [sid, e] of Object.entries(entries)) revs.set(sid, Math.max(revs.get(sid) ?? 0, e.revision));
    cache = entries;
  };
  /** 读盘 + 合并 revision + prune 超限(超出即落盘,清掉的 sid 也从 revs 保留计数)。 */
  const load = (): Record<string, SessionModelEntry> => {
    const raw = readEntries(root);
    const current = fileStamp(root);
    const { next, dropped } = pruneEntries(raw);
    if (dropped.length) {
      if (saveSessionModels(root, next)) stamp = fileStamp(root);
      console.warn(`[session-model] 覆盖表超上限(${SESSION_MODEL_PRUNE_LIMIT}):已清理最旧 ${dropped.length} 条`);
    } else {
      stamp = current;
    }
    absorb(next);
    return next;
  };
  /** 读取路径的统一入口:未加载 → 读盘;盘变过(mtime/size)→ 重载。 */
  const refresh = (): Record<string, SessionModelEntry> => {
    if (cache === undefined) return load();
    if (memoryOnly) return cache;
    if (fileStamp(root) !== stamp) return load();
    return cache;
  };
  const revOf = (sid: string): number => {
    const fromEntry = refresh()[sid]?.revision ?? 0;
    return Math.max(revs.get(sid) ?? 0, fromEntry);
  };
  const notify = (sid: string) => {
    for (const fn of [...listeners]) {
      try {
        fn(sid);
      } catch {
        /* 订阅方故障不影响写入 */
      }
    }
  };
  const write = (sid: string, override: SessionModelOverride | null, expectedRevision?: number): SessionModelWriteResult => {
    // 写前读盘合并(m2):先按 mtime 重载,别进程写的条目不会被本进程的整表覆盖吞掉。
    const entries = refresh();
    const currentRev = Math.max(revs.get(sid) ?? 0, entries[sid]?.revision ?? 0);
    if (expectedRevision !== undefined && expectedRevision !== currentRev) {
      return {
        ok: false,
        code: "revision-mismatch",
        revision: currentRev,
        message: `覆盖已被其它客户端改动(期望 revision=${expectedRevision},当前=${currentRev}),请重新读取后再试`,
      };
    }
    const nextRev = currentRev + 1;
    const next: Record<string, SessionModelEntry> = { ...entries };
    if (override) {
      next[sid] = { ...pickOverride(override), revision: nextRev, updatedAt: Date.now() };
    } else {
      delete next[sid];
    }
    absorb(next);
    revs.set(sid, nextRev);
    if (saveSessionModels(root, next)) {
      stamp = fileStamp(root);
      memoryOnly = false;
    } else {
      memoryOnly = true; // fail-soft:盘失败进程内仍生效(重启回旧值,warn 已可见)
    }
    notify(sid);
    return { ok: true, revision: nextRev };
  };
  return {
    get(sid) {
      const hit = refresh()[sid];
      return hit ? pickOverride(hit) : undefined;
    },
    revision(sid) {
      return revOf(sid);
    },
    set(sid, override, opts) {
      return write(sid, override, opts?.expectedRevision);
    },
    clear(sid) {
      const existed = refresh()[sid] !== undefined;
      write(sid, null);
      return existed;
    },
    all() {
      const out: Record<string, SessionModelOverride> = {};
      for (const [sid, e] of Object.entries(refresh())) out[sid] = pickOverride(e);
      return out;
    },
    copy(from, to) {
      // m8:与其他变更同处串行临界区(不与并发 set 交错)+ write() 内部写前读盘合并。
      return serialize(() => {
        const src = refresh()[from];
        if (!src) return undefined;
        write(to, pickOverride(src));
        return pickOverride(src);
      });
    },
    invalidate() {
      cache = undefined;
      stamp = undefined;
      memoryOnly = false;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    serialize,
  };
}

/** 会话级 contextWindow 解析(m3):按 (model, providerId) 查模型元数据;providerId 优先精确匹配
 * (同名模型出现在多个 Provider 时,窗口以会话选中的 Provider 为准),找不到回退全表搜索。
 * 都找不到=undefined(调用方回退启动时注入的定值)。 */
export function sessionContextWindow(config: Config, model: string | undefined, providerId?: string): number | undefined {
  if (!model) return undefined;
  if (providerId) {
    const p = config.providers.find((x) => x.id === providerId);
    for (const m of p?.models ?? []) {
      const name = typeof m === "string" ? m : m.name;
      if (name !== model) continue;
      if (typeof m === "string") break;
      if (m.contextWindow !== undefined) return m.contextWindow;
      break;
    }
  }
  return modelMetaOf(config, model)?.contextWindow;
}

/** 角色轨模型(压缩/评审/子代理/提炼)在会话覆盖下的派生结果。 */
export interface SessionRoleModels {
  compact?: LlmProvider;
  review?: LlmProvider;
  subagent?: LlmProvider;
  digest?: LlmProvider;
}

/** per-session 主模型覆盖面(app 装配注入 agent 接线):
 *  resolve=sid→override(store 读);derive=覆盖→独立 provider 实例(合并视图+工厂建);
 *  派生实例按 (sid, providerId, model) 缓存,且 store 写入(同一 sid)即失效;
 *  derive 返回 undefined=派生失败,调用方 fail-soft 回退共享 llm。 */
export interface SessionModelFace {
  resolve(sessionId: string): SessionModelOverride | undefined;
  derive(sessionId: string, override: SessionModelOverride): LlmProvider | undefined;
  /** m1:会话覆盖下的角色轨 provider(压缩/评审/子代理);undefined=全部派生失败(调用方用全局)。 */
  deriveRoleModels(sessionId: string, override: SessionModelOverride): SessionRoleModels | undefined;
  /** m3:会话覆盖模型的 contextWindow(无 meta=undefined,调用方回退启动时定值)。 */
  contextWindowFor(override: SessionModelOverride): number | undefined;
  /** 失效派生缓存(sid 缺省=全清);store 变更会经 onChange 自动触发。 */
  invalidate(sessionId?: string): void;
  /** 退订 store 变更(装配卸载时调用)。 */
  dispose(): void;
}

/** 派生实例缓存上限:按会话数硬上限,超限逐出最旧(旧实现按 sid 永驻,长跑进程无界增长)。 */
const FACE_CACHE_MAX = 64;

/** 覆盖视图下的临时 Config(纯拷贝合并,不改调用方传入的全局 config 对象)。
 * m7:override.effort 落到 coding.llm.implementationEffort(主轨唯一权威),工厂建出的 provider
 * describe().reasoningEffort 即为会话档位;"" = 显式关(provider 不带 reasoning_effort)。 */
function mergedConfig(config: Config, override: SessionModelOverride): Config {
  const llm = resolveSessionModelRef(config, override) as Record<string, unknown>;
  if (typeof override.effort === "string") llm.implementationEffort = override.effort;
  return {
    ...config,
    coding: { ...config.coding, llm: llm as unknown as Config["coding"]["llm"] },
  } as Config;
}

/** 会话覆盖下的角色轨 config(m1):未显式配置 coding.models.<role>.model 的角色跟随会话选择
 * (override > profile 显式 > 全局);显式配置的角色保留用户设定(显式优先),仅在 providerId 与
 * 会话选中 provider 相同时把 model 换成会话模型(用户意图=「这个角色的端点和主会话一致」)。 */
function roleConfig(config: Config, override: SessionModelOverride): { config: Config; notes: string[] } {
  const merged = mergedConfig(config, override);
  const llm = merged.coding.llm as { model?: string; providerId?: string };
  const applied = applySessionModelToRoles(merged, { model: String(llm.model ?? override.model), ...(llm.providerId ? { providerId: llm.providerId } : {}) });
  return applied;
}

/** 派生面工厂:按 (sid, providerId::model) 缓存派生 provider;store 写入该 sid 即失效;
 * 建实例失败(凭证不可解析等,buildLlmFromConfig 会抛)→ warn + undefined(调用方回退共享 llm)。 */
export function createSessionModelFace(config: Config, root: string, store: SessionModelStore): SessionModelFace {
  const cache = new Map<string, { key: string; provider: LlmProvider }>();
  const roleCache = new Map<string, { key: string; models: SessionRoleModels | undefined }>();
  const dispose = store.onChange((sid) => {
    cache.delete(sid);
    roleCache.delete(sid);
  });
  /** LRU 触碰 + 上限逐出(主/角色两个缓存同规则)。 */
  const touch = <T>(m: Map<string, T>, sid: string, hit: T): T => {
    m.delete(sid);
    m.set(sid, hit);
    while (m.size > FACE_CACHE_MAX) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    return hit;
  };
  return {
    resolve: (sessionId) => store.get(sessionId),
    derive: (sessionId, override) => {
      const key = `${override.providerId ?? ""}::${override.model}::${override.effort ?? "-"}`;
      const hit = cache.get(sessionId);
      if (hit && hit.key === key) return touch(cache, sessionId, hit).provider;
      try {
        const built = buildLlmFromConfig(mergedConfig(config, override), root);
        if (!built) return undefined;
        cache.delete(sessionId);
        return touch(cache, sessionId, { key, provider: built }).provider;
      } catch (err) {
        console.warn(`[session-model] 会话 ${sessionId} 派生 provider 失败(${key}):`, String(err).slice(0, 160));
        return undefined;
      }
    },
    deriveRoleModels: (sessionId, override) => {
      const key = `${override.providerId ?? ""}::${override.model}::${override.effort ?? "-"}`;
      const hit = roleCache.get(sessionId);
      if (hit && hit.key === key) return touch(roleCache, sessionId, hit).models;
      try {
        const view = roleConfig(config, override);
        const built = buildModelProviders(view.config, root);
        const models: SessionRoleModels = {
          ...(built.compact ? { compact: built.compact } : {}),
          ...(built.review ? { review: built.review } : {}),
          ...(built.subagent ? { subagent: built.subagent } : {}),
          ...(built.digest ? { digest: built.digest } : {}),
        };
        const value = built.compact || built.review || built.subagent || built.digest ? models : undefined;
        roleCache.delete(sessionId);
        return touch(roleCache, sessionId, { key, models: value }).models;
      } catch (err) {
        console.warn(`[session-model] 会话 ${sessionId} 派生角色模型失败(回退全局角色模型):`, String(err).slice(0, 160));
        return undefined;
      }
    },
    contextWindowFor: (override) => sessionContextWindow(config, override.model, override.providerId),
    invalidate: (sessionId) => {
      if (sessionId === undefined) {
        cache.clear();
        roleCache.clear();
      } else {
        cache.delete(sessionId);
        roleCache.delete(sessionId);
      }
    },
    dispose,
  };
}

// ---------------------------------------------------------------- 处理器门面

/** 一次 set 的结果(server 层据此决定回包 session.model.result 还是 error)。 */
export interface SessionModelSetOutcome {
  ok: boolean;
  /** ok:false 的拒绝原因(route-error=选择不可用;revision-mismatch=并发 CAS 失败;
   * invalid-effort=effort 取值非法)。 */
  code?: "route-error" | "revision-mismatch" | "invalid-effort";
  message?: string;
  modelOverride: SessionModelOverride | null;
  revision: number;
  effective?: EffectiveModel;
  warning?: string;
  routeError?: string;
}

/** session.model.set/get 的服务端门面(server.ts 只依赖这个面,不直接碰 store)。 */
export interface SessionModelApi {
  set(input: { sessionId: string; model: string | null; providerId?: string; effort?: string | null; expectedRevision?: number }): Promise<SessionModelSetOutcome>;
  get(sessionId: string): { modelOverride: SessionModelOverride | null; revision: number };
  /** 会话分叉:把 from 的覆盖复制给 to;返回被复制的覆盖(无覆盖=null)。 */
  copy(from: string, to: string): Promise<SessionModelOverride | null>;
  /** 删除/归档会话:清该会话覆盖(m5);返回是否原本有覆盖。 */
  clear(sessionId: string): boolean;
}

/** journal 最小面(model.switch 审计;避免本文件依赖 Journal 全量实现)。 */
export interface SessionModelJournal {
  append(event: { kind: "model.switch"; sessionId: string; payload: Record<string, unknown> }): unknown;
}

/** 装配门面:**先校验,通过才落盘**(旧实现先落盘再预检,routeError 时坏覆盖被保留)。
 * 校验=Registry 预检(resolveSessionModelSwitch);config 未注入(降级装配)时只回 warning。
 * 整个「读 revision → 校验 → 落盘 → 记账」在 store 串行临界区内完成,并发 set 不交错。
 * m10:审计 payload 补 oldModel/oldProviderId(面板/日志能回答「从哪个模型切过来的」)。 */
export function createSessionModelApi(input: {
  store: SessionModelStore;
  config?: Config;
  root: string;
  journal?: SessionModelJournal;
  env?: NodeJS.ProcessEnv;
}): SessionModelApi {
  const { store, config, root, journal } = input;
  const journalSwitch = (sessionId: string, payload: Record<string, unknown>): void => {
    try {
      journal?.append({ kind: "model.switch", sessionId, payload });
    } catch {
      /* 审计失败不影响覆盖落盘 */
    }
  };
  return {
    set: (req) =>
      store.serialize((): SessionModelSetOutcome => {
        const currentRev = store.revision(req.sessionId);
        if (req.expectedRevision !== undefined && req.expectedRevision !== currentRev) {
          return {
            ok: false,
            code: "revision-mismatch",
            message: `覆盖已被其它客户端改动(期望 revision=${req.expectedRevision},当前=${currentRev}),请重新读取后再试`,
            modelOverride: store.get(req.sessionId) ?? null,
            revision: currentRev,
          };
        }
        const old = store.get(req.sessionId);
        const auditBase = { oldModel: old?.model ?? null, oldProviderId: old?.providerId ?? null, ...(old && typeof old.effort === "string" ? { oldEffort: old.effort } : {}) };
        // model=null = 清除覆盖、回到跟随全局(store 已支持 set(null))
        if (req.model === null) {
          const w = store.set(req.sessionId, null);
          if (!w.ok) return { ok: false, code: "revision-mismatch", message: w.message, modelOverride: store.get(req.sessionId) ?? null, revision: w.revision };
          journalSwitch(req.sessionId, { model: null, source: "session", cleared: true, revision: w.revision, ...auditBase });
          return { ok: true, modelOverride: null, revision: w.revision };
        }
        // m7:effort 校验(非法值不落盘、回 invalid-effort;null/缺省=清除该字段回全局)
        const effortCheck = validateSessionEffort(req.effort === null ? undefined : req.effort);
        if (!effortCheck.ok) {
          return {
            ok: false,
            code: "invalid-effort",
            message: effortCheck.message,
            modelOverride: old ?? null,
            revision: currentRev,
            routeError: effortCheck.message,
          };
        }
        const requested: SessionModelOverride = {
          model: req.model,
          ...(req.providerId ? { providerId: req.providerId } : {}),
          ...(effortCheck.value !== undefined ? { effort: effortCheck.value } : {}),
        };
        // m10:悬空 providerId 清理(Provider 已删除)→ 清理后落盘(覆盖表自愈),warning 一并回给面板
        const sane = config ? sanitizeSessionOverride(config, requested) : { override: requested };
        const override = sane.override;
        const pre = config
          ? resolveSessionModelSwitch(config, override, root, input.env ?? process.env)
          : { warning: "config 未注入(降级装配):覆盖可落盘,但任务执行不会使用它(继续走共享模型)" };
        const warningText = [sane.warning, pre.warning].filter(Boolean).join(";") || undefined;
        if (pre.routeError) {
          // 校验失败:不落盘、不改 revision,只把可操作原因回给面板(fail-visible)
          return {
            ok: false,
            code: "route-error",
            message: pre.routeError,
            modelOverride: store.get(req.sessionId) ?? null,
            revision: currentRev,
            ...(pre.effective ? { effective: pre.effective } : {}),
            ...(warningText ? { warning: warningText } : {}),
            routeError: pre.routeError,
          };
        }
        const w = store.set(req.sessionId, override);
        if (!w.ok) return { ok: false, code: "revision-mismatch", message: w.message, modelOverride: store.get(req.sessionId) ?? null, revision: w.revision };
        journalSwitch(req.sessionId, { ...override, source: "session", revision: w.revision, ...auditBase });
        return {
          ok: true,
          modelOverride: override,
          revision: w.revision,
          ...(pre.effective ? { effective: pre.effective } : {}),
          ...(warningText ? { warning: warningText } : {}),
        };
      }),
    get: (sessionId) => ({ modelOverride: store.get(sessionId) ?? null, revision: store.revision(sessionId) }),
    copy: async (from, to) => {
      const copied = (await store.copy(from, to)) ?? null;
      if (copied) journalSwitch(to, { ...copied, source: "fork", from });
      return copied;
    },
    clear: (sessionId) => {
      const existed = store.clear(sessionId);
      if (existed) journalSwitch(sessionId, { model: null, source: "session-clear", cleared: true });
      return existed;
    },
  };
}

/** set 回包预检(Registry 语义):合并视图→resolveModelSwitch 算 effective/routeError。
 * 只读不写:不热切全局 provider、不动全局 config。
 * m10:悬空 providerId 的清理 warning 也并入返回(DanglingWarning → warning 串),
 * 让面板能解释「你选的 provider 已不存在,已按模型重新解析」。 */
export function resolveSessionModelSwitch(
  config: Config,
  override: SessionModelOverride,
  root: string,
  env: NodeJS.ProcessEnv = process.env): { effective?: EffectiveModel; warning?: string; routeError?: string } {
  const sane = sanitizeSessionOverride(config, override);
  const r = resolveModelSwitch(mergedConfig(config, sane.override), root, env);
  const warning = [sane.warning, r.warning].filter(Boolean).join(";");
  return {
    ...(r.effective ? { effective: r.effective } : {}),
    ...(warning ? { warning } : {}),
    ...(r.routeError ? { routeError: r.routeError } : {}),
  };
}

/** m7:effort 取值域(与 effort-policy 同源;""=显式关)校验。
 * 非法值 → {ok:false}(api 层据此回 invalid-effort,不落盘)。口径实现在 model-switch.validateEffortOverride。 */
export function validateSessionEffort(value: string | undefined): { ok: true; value?: string } | { ok: false; message: string } {
  const err = validateEffortOverride(value);
  if (err) return { ok: false, message: err };
  return value === undefined ? { ok: true } : { ok: true, value };
}
