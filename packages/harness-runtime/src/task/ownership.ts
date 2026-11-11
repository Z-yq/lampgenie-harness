/**
 * 会话工作所有权注册表 —— 纯逻辑零 IO。
 * 背景:一个会话关闭时(用户关 tab / 会话被替换 / 网关优雅退出),它名下可能还有若干在跑的
 * 工作单元:终端 PTY 进程、后台子代理、workflow 步。这些单元不属于「会话消息」,而属于
 * 「会话持有的操作系统资源」,必须被显式收回:cancel 之后还得等它们各自 settle(进程真正
 * 退出 / 迟到回调到达),否则会出两类事故——「会话已关闭但子进程还在跑」,以及「旧代结果
 * 回灌进新会话」。
 * 所以关闭分两阶段:
 * 1) beginClose(owner):立刻把 owner 记入 closingOwners(永久,阻止该会话再启动新工作),
 * 并把名下 running 单元标成 closing;返回需要 cancel 的单元列表。列表顺序固定
 * (terminal → subagent → workflow,同 kind 内按 registeredAt 升序再按 unitId 字典序),
 * 这样重试、跨进程比对日志都能得到同一份序列。
 * 2) 调用方逐个 cancel;每个单元的结束回调到达时 settle(unitId, {generation})。
 * 3) completeClose(owner):把该 owner 的 closing 单元统一转 closed(closedAt=now),
 * 并把「仍未 settle」的单元列进 pending —— pending 非空表示调用方还得继续等,
 * 不能把没收回的资源当成已释放。
 * 为什么需要 generation:同一 unitId 可能被新一代工作复用(会话重开、换分支、重试),
 * 旧代的迟到 settle 必须判 STALE_GENERATION 并丢弃,否则会把新一代的单元误当成已结束。
 * 同理 register 也按 generation 做幂等判定,避免旧代注册覆盖新代。
 * 本模块不读不写、不改入参、不抛错(所有公开方法 try/catch,异常一律降级为 INVALID/
 * 空结果),返回值全部是快照副本(外部改返回的数组/对象不影响内部状态);时间由注入的
 * now 提供(缺省 Date.now),便于测试确定性。
 */

/** 判定码(封闭枚举):OK=成功;NOT_FOUND=单元不存在;CLOSING=会话正在/已经关闭;STALE_GENERATION=代次不匹配;INVALID=入参不合法。 */
export const OWNERSHIP_CODES = ["OK", "NOT_FOUND", "CLOSING", "STALE_GENERATION", "INVALID"] as const;
export type OwnershipCode = (typeof OWNERSHIP_CODES)[number];

/** 工作单元种类:终端进程 / 后台子代理 / workflow 步。 */
export type OwnerKind = "terminal" | "subagent" | "workflow";
/** 单元状态:running=在跑;closing=已发 cancel 等 settle;closed=已收回。 */
export type OwnerState = "running" | "closing" | "closed";

export interface OwnerUnit {
  unitId: string;
  kind: OwnerKind;
 /** 持有该单元的会话 id(关闭以会话为单位级联)。 */
  ownerSessionId: string;
 /** 代次:同一 unitId 被新一代复用时递增;迟到回调靠它丢弃。 */
  generation: number;
  state: OwnerState;
 /** 注册时刻(ms),决定级联顺序。 */
  registeredAt: number;
 /** 收回时刻(ms),仅 state="closed" 时有。 */
  closedAt?: number;
}

export interface OwnershipResult {
  code: OwnershipCode;
 /** 单单元操作的快照(register/update/settle 等)。 */
  unit?: OwnerUnit;
 /** 多单元操作的快照列表(beginClose/closeByOwner/completeClose),顺序确定。 */
  units?: OwnerUnit[];
 /** completeClose 时仍未 settle 的 unitId(非空=调用方还得等)。 */
  pending?: string[];
  reason?: string;
}

export interface OwnerRegistryOptions {
 /** 时钟注入(缺省 Date.now),便于测试确定性。 */
  now?: () => number;
}

export interface RegisterInput {
  unitId: string;
  kind: OwnerKind;
  ownerSessionId: string;
  generation: number;
}

/** 级联顺序权重:terminal 最先收(它占着 PTY 与子进程),workflow 最后(它可能还要落盘)。 */
const KIND_ORDER: Record<OwnerKind, number> = { terminal: 0, subagent: 1, workflow: 2 };
const KINDS: readonly OwnerKind[] = ["terminal", "subagent", "workflow"];
const STATES: readonly OwnerState[] = ["running", "closing", "closed"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isKind(value: unknown): value is OwnerKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function isState(value: unknown): value is OwnerState {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

/** 稳定深拷贝(只含契约字段),保证返回值是快照。 */
function copyUnit(unit: OwnerUnit): OwnerUnit {
  const out: OwnerUnit = {
    unitId: unit.unitId,
    kind: unit.kind,
    ownerSessionId: unit.ownerSessionId,
    generation: unit.generation,
    state: unit.state,
    registeredAt: unit.registeredAt,
  };
  if (typeof unit.closedAt === "number") out.closedAt = unit.closedAt;
  return out;
}

/** 级联顺序:kind(terminal→subagent→workflow)→ registeredAt 升序 → unitId 字典序。 */
function compareUnits(left: OwnerUnit, right: OwnerUnit): number {
  const byKind = (KIND_ORDER[left.kind] ?? 9) - (KIND_ORDER[right.kind] ?? 9);
  if (byKind !== 0) return byKind;
  const byAt = left.registeredAt - right.registeredAt;
  if (byAt !== 0) return byAt;
  if (left.unitId === right.unitId) return 0;
  return left.unitId < right.unitId ? -1 : 1;
}

function fail(code: OwnershipCode, reason: string): OwnershipResult {
  return { code, reason };
}

export class OwnerRegistry {
  private readonly units = new Map<string, OwnerUnit>();
 /** 已 beginClose 的会话(永久保留):阻止关闭过程中的新工作启动。 */
  private readonly closingOwners = new Set<string>();
 /** 已 settle 的 unitId(仅内部记账;状态转 closed 统一由 completeClose 做)。 */
  private readonly settled = new Set<string>();
  private readonly now: () => number;

  constructor(options: OwnerRegistryOptions = {}) {
    this.now =
      options && typeof options.now === "function"
        ? options.now
        : () => Date.now();
  }

 /** 内部时钟:注入的 now 抛错时降级为 0,绝不让注册/关闭链因时钟崩掉。 */
  private clock(): number {
    try {
      const value = this.now();
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  private ownerUnits(ownerSessionId: string): OwnerUnit[] {
    const list: OwnerUnit[] = [];
    for (const unit of this.units.values()) {
      if (unit.ownerSessionId === ownerSessionId) list.push(unit);
    }
    return list.sort(compareUnits);
  }

 /**
 * 注册(或更新)一个工作单元。
 * 幂等:同 unitId、同 generation、state=running 重复注册不刷新 registeredAt(否则级联顺序
 * 会在重试间抖动);新 generation 更大才更新;更小判 STALE_GENERATION(旧代迟到注册不许回滚)。
 */
  register(input: RegisterInput): OwnershipResult {
    try {
      if (!input || typeof input !== "object") return fail("INVALID", "入参不是对象");
      const { unitId, kind, ownerSessionId, generation } = input as Partial<RegisterInput>;
      if (!isNonEmptyString(unitId)) return fail("INVALID", "unitId 不是非空字符串");
      if (!isKind(kind)) return fail("INVALID", `kind 不在枚举内:${String(kind)}`);
      if (!isNonEmptyString(ownerSessionId)) return fail("INVALID", "ownerSessionId 不是非空字符串");
      if (!isGeneration(generation)) return fail("INVALID", "generation 不是非负有限数");

 // 阶段一已开始(或已完成):不许再启动新工作。
      if (this.closingOwners.has(ownerSessionId)) {
        return fail("CLOSING", `会话 ${ownerSessionId} 正在关闭,拒绝新启动`);
      }

      const existing = this.units.get(unitId);
      if (existing) {
        if (existing.state === "closed") return fail("INVALID", `单元 ${unitId} 已收回,不能复用`);
        if (existing.state === "closing") return fail("CLOSING", `单元 ${unitId} 正在收回,拒绝新启动`);
        if (generation === existing.generation) {
          return { code: "OK", unit: copyUnit(existing), reason: `单元 ${unitId} 已注册(幂等)` };
        }
        if (generation < existing.generation) {
          return fail("STALE_GENERATION", `单元 ${unitId} 当前代次 ${existing.generation},拒绝旧代 ${generation}`);
        }
        const next: OwnerUnit = {
          unitId: existing.unitId,
          kind: existing.kind,
          ownerSessionId: existing.ownerSessionId,
          generation,
          state: existing.state,
          registeredAt: existing.registeredAt,
        };
        if (typeof existing.closedAt === "number") next.closedAt = existing.closedAt;
        this.units.set(unitId, next);
 // 新代次的单元还没 settle;清掉旧代记账,避免沿用上一代的「已结束」。
        this.settled.delete(unitId);
        return { code: "OK", unit: copyUnit(next), reason: `单元 ${unitId} 升级到代次 ${generation}` };
      }

      const unit: OwnerUnit = {
        unitId,
        kind,
        ownerSessionId,
        generation,
        state: "running",
        registeredAt: this.clock(),
      };
      this.units.set(unitId, unit);
      return { code: "OK", unit: copyUnit(unit) };
    } catch {
      return fail("INVALID", "注册过程异常");
    }
  }

 /** 局部更新:只允许改 state/generation/closedAt(unitId/kind/ownerSessionId 是身份,禁止改)。 */
  update(unitId: string, patch: Partial<Pick<OwnerUnit, "state" | "generation" | "closedAt">>): OwnershipResult {
    try {
      if (!isNonEmptyString(unitId)) return fail("INVALID", "unitId 不是非空字符串");
      const existing = this.units.get(unitId);
      if (!existing) return fail("NOT_FOUND", `单元 ${unitId} 不存在`);
      if (!patch || typeof patch !== "object") return fail("INVALID", "patch 不是对象");

      const next = copyUnit(existing);
      if (patch.state !== undefined) {
        if (!isState(patch.state)) return fail("INVALID", `state 不在枚举内:${String(patch.state)}`);
        next.state = patch.state;
      }
      if (patch.generation !== undefined) {
        if (!isGeneration(patch.generation)) return fail("INVALID", "generation 不是非负有限数");
        next.generation = patch.generation;
      }
      if (patch.closedAt !== undefined) {
        if (typeof patch.closedAt !== "number" || !Number.isFinite(patch.closedAt)) {
          return fail("INVALID", "closedAt 不是有限数字");
        }
        next.closedAt = patch.closedAt;
      }
      this.units.set(unitId, next);
      return { code: "OK", unit: copyUnit(next) };
    } catch {
      return fail("INVALID", "更新过程异常");
    }
  }

 /**
 * 记录单元已结束(结束回调到达)。只记内部 settled 集合,不动 state/closedAt ——
 * 状态转 closed 统一由 completeClose 做,避免「已 settle 但会话还没走完收尾」时状态提前翻转。
 * generation 不等即旧代迟到回调:STALE_GENERATION 且不更新任何状态。
 */
  settle(unitId: string, info: { generation: number }): OwnershipResult {
    try {
      if (!isNonEmptyString(unitId)) return fail("INVALID", "unitId 不是非空字符串");
      const existing = this.units.get(unitId);
      if (!existing) return fail("NOT_FOUND", `单元 ${unitId} 不存在`);
      const generation = info && typeof info === "object" ? info.generation : undefined;
      if (generation !== existing.generation) {
        return fail(
          "STALE_GENERATION",
          `单元 ${unitId} 当前代次 ${existing.generation},丢弃代次 ${String(generation)} 的迟到结束`,
        );
      }
      this.settled.add(unitId);
      return { code: "OK", unit: copyUnit(existing) };
    } catch {
      return fail("INVALID", "settle 过程异常");
    }
  }

 /** 还能不能给该会话启动新工作:beginClose 过(含已 completeClose)一律 false。 */
  canStart(ownerSessionId: string): boolean {
    try {
      if (!isNonEmptyString(ownerSessionId)) return false;
      return !this.closingOwners.has(ownerSessionId);
    } catch {
      return false;
    }
  }

 /**
 * 阶段一:标记开始关闭。owner 记入 closingOwners(永久,阻止新启动),名下 running → closing;
 * 返回需要 cancel 的非 closed 单元(顺序确定),无单元则 units=[]。
 */
  beginClose(ownerSessionId: string): OwnershipResult {
    try {
      if (!isNonEmptyString(ownerSessionId)) return fail("INVALID", "ownerSessionId 不是非空字符串");
      this.closingOwners.add(ownerSessionId);

      const all = this.ownerUnits(ownerSessionId);
      for (const unit of all) {
        if (unit.state === "running") {
          unit.state = "closing";
          delete unit.closedAt;
        }
      }
      const payload = all.filter((unit) => unit.state !== "closed").map(copyUnit);
      return {
        code: "OK",
        units: payload,
        reason: `会话 ${ownerSessionId} 进入关闭:${payload.length} 个单元待 cancel`,
      };
    } catch {
      return fail("INVALID", "beginClose 过程异常");
    }
  }

 /**
 * 阶段二:收尾。把该 owner 的 closing 单元统一转 closed(closedAt=now),
 * pending = 其中仍未 settle 的 unitId(非空=调用方还得等)。
 */
  completeClose(ownerSessionId: string): OwnershipResult {
    try {
      if (!isNonEmptyString(ownerSessionId)) return fail("INVALID", "ownerSessionId 不是非空字符串");
 // completeClose 也算「已进入关闭」:任何路径下都不该再放新工作进这个会话。
      this.closingOwners.add(ownerSessionId);

      const all = this.ownerUnits(ownerSessionId);
      const targets = all.filter((unit) => unit.state === "closing");
      const pending = targets.filter((unit) => !this.settled.has(unit.unitId)).map((unit) => unit.unitId);
      const closedAt = this.clock();
      for (const unit of targets) {
        unit.state = "closed";
        unit.closedAt = closedAt;
      }
      return {
        code: "OK",
        units: all.map(copyUnit),
        pending,
        reason:
          pending.length > 0
            ? `会话 ${ownerSessionId} 收尾未完成,仍需等待 ${pending.length} 个单元 settle`
            : `会话 ${ownerSessionId} 收尾完成`,
      };
    } catch {
      return fail("INVALID", "completeClose 过程异常");
    }
  }

 /**
 * 会话级关闭别名:等同 beginClose(返回需 cancel 的单元与顺序)。
 * 调用方对每个单元 cancel 后 settle,最后 completeClose。
 */
  closeByOwner(ownerSessionId: string): OwnershipResult {
    return this.beginClose(ownerSessionId);
  }

 /** 该代次是否已过期(单元不存在也算过期):用于丢弃迟到回调。 */
  isStale(unitId: string, generation: number): boolean {
    try {
      if (!isNonEmptyString(unitId)) return true;
      const existing = this.units.get(unitId);
      if (!existing) return true;
      return existing.generation !== generation;
    } catch {
      return true;
    }
  }

 /** 汇总计数(纯只读)。 */
  stats(): { total: number; running: number; closing: number; closed: number; owners: number } {
    const out = { total: 0, running: 0, closing: 0, closed: 0, owners: 0 };
    try {
      const owners = new Set<string>();
      for (const unit of this.units.values()) {
        out.total += 1;
        if (unit.state === "running") out.running += 1;
        else if (unit.state === "closing") out.closing += 1;
        else if (unit.state === "closed") out.closed += 1;
        owners.add(unit.ownerSessionId);
      }
      out.owners = owners.size;
      return out;
    } catch {
      return { total: 0, running: 0, closing: 0, closed: 0, owners: 0 };
    }
  }

 /**
 * 覆盖式载入快照(重启恢复用):先清空全部内部状态,再逐条载入;
 * 非法条目跳过(不抛错),closing/closed 单元的 owner 记入 closingOwners(重启后同样不许新启动)。
 */
  restore(units: OwnerUnit[]): { restored: number } {
    try {
      if (!Array.isArray(units)) return { restored: 0 };
      this.units.clear();
      this.settled.clear();
      this.closingOwners.clear();

      for (const raw of units) {
        if (!raw || typeof raw !== "object") continue;
        const candidate = raw as Partial<OwnerUnit>;
        if (!isNonEmptyString(candidate.unitId)) continue;
        if (!isNonEmptyString(candidate.ownerSessionId)) continue;
        if (!isKind(candidate.kind)) continue;
        if (!isState(candidate.state)) continue;
        if (!isGeneration(candidate.generation)) continue;
        if (typeof candidate.registeredAt !== "number" || !Number.isFinite(candidate.registeredAt)) continue;
        if (
          candidate.closedAt !== undefined &&
          (typeof candidate.closedAt !== "number" || !Number.isFinite(candidate.closedAt))
        ) {
          continue;
        }
        const unit: OwnerUnit = {
          unitId: candidate.unitId,
          kind: candidate.kind,
          ownerSessionId: candidate.ownerSessionId,
          generation: candidate.generation,
          state: candidate.state,
          registeredAt: candidate.registeredAt,
        };
        if (typeof candidate.closedAt === "number") unit.closedAt = candidate.closedAt;
        this.units.set(unit.unitId, unit);
        if (unit.state !== "running") this.closingOwners.add(unit.ownerSessionId);
      }
      return { restored: this.units.size };
    } catch {
      return { restored: 0 };
    }
  }

 /** 单单元快照(不存在 → undefined)。 */
  get(unitId: string): OwnerUnit | undefined {
    try {
      if (!isNonEmptyString(unitId)) return undefined;
      const existing = this.units.get(unitId);
      return existing ? copyUnit(existing) : undefined;
    } catch {
      return undefined;
    }
  }

 /** 快照(可给 ownerSessionId 过滤);顺序确定,外部改返回数组不影响内部。 */
  snapshot(ownerSessionId?: string): OwnerUnit[] {
    try {
      const list =
        typeof ownerSessionId === "string" ? this.ownerUnits(ownerSessionId) : [...this.units.values()].sort(compareUnits);
      return list.map(copyUnit);
    } catch {
      return [];
    }
  }
}
