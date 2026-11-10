/**
 * 功能边界影响简报(feature boundary impact brief):把「一个语义功能点 + 它的 UI 面 + depth1/2 代码引用」
 * 合成一份可供 gateway 侧直接消费的「改动影响面清单」。
 * 为什么需要它:
 * - 只读语义图/只读代码索引都会漏:语义图说「这里有入口」,代码索引说「这里有符号」,
 *   但没人把它们对齐,于是「这个功能改了会影响什么」永远靠人肉回忆。
 * - 证据强度必须显式分层,否则「静态可达」会被当成「必须回归」,回归成本失控;
 *   反之「必须」被降级成「证据」,漂移就漏了。所以 level 只有五档且判定口径写死(见下)。
 * - E2E 用例不能凭感觉写:语义未验收(semanticsAccepted 缺失)或 must 项证据不全时,
 *   允许写 E2E 就是把「猜」固化进测试。因此 canWriteE2E 是一道闸,且与 codes 里的
 *   FB_E2E_ALLOWED / FB_E2E_BLOCKED 严格一致。
 * 判定口径(canonical,改动需同步本注释):
 * - 入参非法(feature 缺失 / feature.id 空 / entries 非数组 / 重复 codeRef id / depth 不属于 {1,2}):
 *   不抛异常,直接返回空简报并只带 FB_INVALID(此时不追加任何 E2E 码)。
 * - 正常路径 codes 顺序固定:
 *   FB_BUILT → 缺失层码(去重 + 升序:FB_MISSING_CODE/FB_MISSING_SEMANTIC/FB_MISSING_SURFACE)
 *   → FB_DRIFT(有 drift 时)→ FB_UNRESOLVED_OWNER → FB_DEPTH3_REQUIRED
 *   → 末尾恰好一个 FB_E2E_ALLOWED 或 FB_E2E_BLOCKED。
 * - 三层证据 semantic/surface/code:缺哪层就留 undefined,不猜、不编;并按层聚合出缺失码(去重)。
 * - items 按 target 去重,首次出现保留顺序:
 *   1) 每个 entry → `entry:<name>` / must(功能直接入口);
 *   2) 每个 dataFlow → `flow:<from>-><to>`,kind=write 为 must(写数据流),kind=read 为 evidence(仅静态可达的只读流);
 *   3) 其余 codeRef(未被 1、2 用作 code 证据的)→ `code:<module>:<symbol>`,级别按优先级
 *      invariant(契约/schema)> must(入口或数据流端点)> should(≥2 个不同 featureId 的 surface 共享)
 *      > conditional(dependsOn,或只被「仅 draft」的可选流 surface 覆盖)> evidence(最弱:仅静态可达)。
 * - driftCandidates 两类:A) surface 未声明 authoritativeOwner 但代码侧有候选 owner;
 *   B) 语义图声明的 entry/flow 端点在 depth1/2 codeRef 里找不到 module。
 * - unresolvedOwners:无 authoritativeOwner 且无 A 类候选 owner 的 surface。
 * - depth3Required:仅当 unresolvedOwners 中存在「关键 owner」(该 surface 有 steps.submit,
 *   或该 surface 对应 feature.entries[0])才为 true。
 * - canWriteE2E:语义已验收 且 不存在「level=must 而三层证据任一缺失」的项;
 *   与 codes 中 FB_E2E_ALLOWED 的出现严格等价。
 * 纯逻辑:零 IO(不读文件/网络/环境/时间),所有函数不抛异常。
 */

/** 影响档位:必须 / 应该 / 条件 / 不变量 / 仅证据(由强到弱,evidence 最弱)。 */
export type ImpactLevel = "must" | "should" | "conditional" | "invariant" | "evidence";

/** 语义功能点:入口、数据流、依赖(由语义图/需求文档侧提供)。 */
export interface SemanticFeature {
  id: string;
  name: string;
  entries: string[];
  dataFlows: Array<{ from: string; to: string; kind: "read" | "write" }>;
  dependsOn?: string[];
}

/** UI 面:一个功能在界面上的操作步骤,以及 owner 归属声明。 */
export interface UISurface {
  id: string;
  name: string;
  featureId: string;
  steps: { draft?: string; validate?: string; submit?: string };
  authoritativeOwner?: string;
}

/** 代码引用:depth1/2 的静态可达符号(由代码索引侧提供)。 */
export interface CodeRef {
  id: string;
  module: string;
  file: string;
  symbol: string;
  depth: 1 | 2;
}

/** 影响面单项:target 唯一,level 决定回归强度,evidence 三层可缺但绝不猜。 */
export interface BoundaryItem {
  target: string;
  level: ImpactLevel;
  rationale: string;
  evidence: { semantic?: string; surface?: string; code?: string };
}

/** 影响简报:gateway 侧按此结构渲染「改这个功能要动哪里」并决定能否写 E2E。 */
export interface ImpactBrief {
  featureId: string;
  items: BoundaryItem[];
  driftCandidates: Array<{ target: string; reason: string }>;
  unresolvedOwners: string[];
  depth3Required: boolean;
  semanticsAccepted?: { by: string; at: string };
  codes: string[];
}

/** 稳定码表(值即字面量,gateway 侧按字符串匹配,不可改名)。 */
export const FB_CODES: Readonly<
  Record<
    | "INVALID"
    | "BUILT"
    | "MISSING_SEMANTIC"
    | "MISSING_SURFACE"
    | "MISSING_CODE"
    | "DRIFT"
    | "UNRESOLVED_OWNER"
    | "DEPTH3_REQUIRED"
    | "E2E_BLOCKED"
    | "E2E_ALLOWED",
    string
  >
> = {
  INVALID: "FB_INVALID",
  BUILT: "FB_BUILT",
  MISSING_SEMANTIC: "FB_MISSING_SEMANTIC",
  MISSING_SURFACE: "FB_MISSING_SURFACE",
  MISSING_CODE: "FB_MISSING_CODE",
  DRIFT: "FB_DRIFT",
  UNRESOLVED_OWNER: "FB_UNRESOLVED_OWNER",
  DEPTH3_REQUIRED: "FB_DEPTH3_REQUIRED",
  E2E_BLOCKED: "FB_E2E_BLOCKED",
  E2E_ALLOWED: "FB_E2E_ALLOWED",
};

/** 契约/schema 关键词(命中即 invariant:跨端契约不能靠回归用例兜底,必须显式验证)。 */
const CONTRACT_KEYWORD = /schema|contract|protocol|zod/i;

/** surface 的步骤值(过滤空值;runtime 入参可能不全,不假设形状)。 */
function stepValues(surface: UISurface): string[] {
  const steps = surface?.steps;
  if (!steps || typeof steps !== "object") return [];
  return [steps.draft, steps.validate, steps.submit].filter(
    (v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * 强覆盖:entry/flow 端点找 surface 证据时用(steps 值或 surface.id 直接相等)。
 * 口径刻意不含 surface.name——语义图说的是「哪一步」,name 是展示名,不构成步骤证据。
 */
function coversStrict(surface: UISurface, value: string): boolean {
  if (value === surface?.id) return true;
  return stepValues(surface).includes(value);
}

/** 宽覆盖:owner 候选、共享组件判定用(steps 值 / id / name 任一相等)。 */
function coversLoose(surface: UISurface, value: string): boolean {
  if (value === surface?.id || value === surface?.name) return true;
  return stepValues(surface).includes(value);
}

/** 可选流 surface:只有 draft,既无 validate 也无 submit。 */
function isDraftOnlySurface(surface: UISurface): boolean {
  const steps = surface?.steps;
  if (!steps || typeof steps !== "object") return false;
  return !!steps.draft && !steps.validate && !steps.submit;
}

/** 逐字段构建 evidence:缺层就不写 key(不猜)。 */
function makeEvidence(semantic?: string, surface?: string, code?: string): BoundaryItem["evidence"] {
  const evidence: BoundaryItem["evidence"] = {};
  if (semantic !== undefined) evidence.semantic = semantic;
  if (surface !== undefined) evidence.surface = surface;
  if (code !== undefined) evidence.code = code;
  return evidence;
}

interface BuildSnapshot {
  items: BoundaryItem[];
  driftCandidates: Array<{ target: string; reason: string }>;
  unresolvedOwners: string[];
  depth3Required: boolean;
  semanticsAccepted?: { by: string; at: string };
}

/** 入参合法性(feature / entries / codeRef 重复 id / depth 域)。 */
function isInvalidInput(input: {
  feature?: SemanticFeature;
  surfaces?: UISurface[];
  codeRefs?: CodeRef[];
}): boolean {
  const feature = input?.feature;
  if (!feature || typeof feature !== "object") return true;
  if (typeof feature.id !== "string" || feature.id.trim().length === 0) return true;
  if (!Array.isArray(feature.entries)) return true;
  const refs = Array.isArray(input.codeRefs) ? input.codeRefs : [];
  const seenIds = new Set<string>();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") return true;
    if (typeof ref.id === "string") {
      if (seenIds.has(ref.id)) return true;
      seenIds.add(ref.id);
    }
    if (ref.depth !== 1 && ref.depth !== 2) return true;
  }
  return false;
}

/** 组装影响简报(纯函数,不抛异常;非法入参走 FB_INVALID 短路)。 */
export function buildImpactBrief(input: {
  feature: SemanticFeature;
  surfaces: UISurface[];
  codeRefs: CodeRef[];
  acceptedSemantics?: { by: string; at: string };
}): ImpactBrief {
  const featureId = String(input?.feature?.id ?? "");
  if (isInvalidInput(input)) {
    return {
      featureId,
      items: [],
      driftCandidates: [],
      unresolvedOwners: [],
      depth3Required: false,
      codes: [FB_CODES.INVALID as string],
    };
  }

  const feature = input.feature;
  const surfaces = Array.isArray(input.surfaces) ? input.surfaces.filter((s): s is UISurface => !!s && typeof s === "object") : [];
  const codeRefs = Array.isArray(input.codeRefs) ? input.codeRefs.filter((r): r is CodeRef => !!r && typeof r === "object") : [];
  const entries = feature.entries.filter((e): e is string => typeof e === "string" && e.length > 0);
  const flows = Array.isArray(feature.dataFlows) ? feature.dataFlows.filter((f) => !!f && typeof f === "object") : [];
  const dependsOn = Array.isArray(feature.dependsOn)
    ? (feature.dependsOn as string[]).filter((d): d is string => typeof d === "string")
    : [];

  const entrySet = new Set(entries);
  const flowEndpoints = new Set<string>();
  const writeEndpoints = new Set<string>();
  for (const flow of flows) {
    if (typeof flow.from === "string") flowEndpoints.add(flow.from);
    if (typeof flow.to === "string") flowEndpoints.add(flow.to);
    if (flow.kind === "write") {
      if (typeof flow.from === "string") writeEndpoints.add(flow.from);
      if (typeof flow.to === "string") writeEndpoints.add(flow.to);
    }
  }
  const dependsOnSet = new Set(dependsOn);

  const items: BoundaryItem[] = [];
  const itemTargets = new Set<string>();
  const usedRefIds = new Set<string>();
  const pushItem = (item: BoundaryItem): void => {
    if (itemTargets.has(item.target)) return;
    itemTargets.add(item.target);
    items.push(item);
  };

  // 1) 语义入口 → must
  for (const entry of entries) {
    const surface = surfaces.find((s) => coversStrict(s, entry));
    const ref = codeRefs.find((r) => r.id === entry || r.module === entry);
    if (ref) usedRefIds.add(ref.id);
    pushItem({
      target: `entry:${entry}`,
      level: "must",
      rationale: `功能入口「${entry}」由用户直接触发,改动会改变功能行为,必须纳入回归。`,
      evidence: makeEvidence(
        `feature:${featureId}#entry:${entry}`,
        surface?.id,
        ref ? `codeRef:${ref.id}` : undefined),
    });
  }

  // 2) 数据流:写=must,读=仅静态可达的 evidence
  for (const flow of flows) {
    const from = String(flow.from ?? "");
    const to = String(flow.to ?? "");
    const surface = surfaces.find((s) => coversStrict(s, from) || coversStrict(s, to));
    const ref = codeRefs.find((r) => r.module === from || r.module === to);
    if (ref) usedRefIds.add(ref.id);
    const isWrite = flow.kind === "write";
    pushItem({
      target: `flow:${from}->${to}`,
      level: isWrite ? "must" : "evidence",
      rationale: isWrite
        ? `写数据流「${from} → ${to}」会改变持久状态,必须覆盖写入与回读。`
        : `只读数据流「${from} → ${to}」仅静态可达,不单独开用例,作为回归证据保留。`,
      evidence: makeEvidence(
        `feature:${featureId}#dataFlow:${from}->${to}`,
        surface?.id,
        ref ? `codeRef:${ref.id}` : undefined),
    });
  }

  // 3) 其余 codeRef:按 invariant > must > should > conditional > evidence 定级
  const sharedFeatureCount = (module: string): number => {
    const refIds = codeRefs.filter((r) => r.module === module).map((r) => r.id);
    const featureIds = new Set<string>();
    for (const surface of surfaces) {
      const hit = coversLoose(surface, module) || refIds.some((id) => coversLoose(surface, id));
      if (hit) featureIds.add(surface.featureId);
    }
    return featureIds.size;
  };

  for (const ref of codeRefs) {
    if (usedRefIds.has(ref.id)) continue;
    const module = String(ref.module ?? "");
    const symbol = String(ref.symbol ?? "");
    const file = String(ref.file ?? "");
    const target = `code:${module}:${symbol}`;
    if (itemTargets.has(target)) continue;

    const coveringSurfaces = surfaces.filter((s) => coversLoose(s, module));
    const surfaceCovered = coveringSurfaces.length > 0;
    const draftOnlyCovered = surfaceCovered && coveringSurfaces.every((s) => isDraftOnlySurface(s));

    let level: ImpactLevel;
    let rationale: string;
    if (CONTRACT_KEYWORD.test(symbol) || CONTRACT_KEYWORD.test(module) || file.endsWith(".schema.ts")) {
      level = "invariant";
      rationale = `模块「${module}」触及契约/schema(symbol=${symbol}),改动会破坏跨端约定,按不变量必须验证。`;
    } else if (entrySet.has(module) || writeEndpoints.has(module)) {
      level = "must";
      rationale = `模块「${module}」是功能入口或写数据流端点,处于直接参与路径,必须覆盖。`;
    } else if (sharedFeatureCount(module) >= 2) {
      level = "should";
      rationale = `模块「${module}」被 2 个及以上功能的 UI 面共享,单点改动会外溢,应当覆盖。`;
    } else if (dependsOnSet.has(module)) {
      level = "conditional";
      rationale = `模块「${module}」来自 dependsOn 依赖声明,仅在依赖路径被触发时需要覆盖。`;
    } else if (draftOnlyCovered) {
      level = "conditional";
      rationale = `模块「${module}」只被「仅有 draft、无 validate/submit」的可选流 surface 覆盖,按条件覆盖处理。`;
    } else {
      level = "evidence";
      rationale = `模块「${module}」仅静态可达(最弱证据),不单独开 E2E,只作为回溯证据。`;
    }

    const semanticRelevant =
      entrySet.has(module) || flowEndpoints.has(module) || dependsOnSet.has(module) || surfaceCovered;
    pushItem({
      target,
      level,
      rationale,
      evidence: makeEvidence(
        semanticRelevant ? `feature:${featureId}#module:${module}` : undefined,
        surfaceCovered ? coveringSurfaces[0]?.id : undefined,
        `codeRef:${ref.id}`,
      ),
    });
  }

  // drift:A) surface 缺 owner 但代码侧有候选;B) 语义声明在 codeRef 里找不到 module
  const driftCandidates: Array<{ target: string; reason: string }> = [];
  const driftTargets = new Set<string>();
  const pushDrift = (target: string, reason: string): void => {
    if (driftTargets.has(target)) return;
    driftTargets.add(target);
    driftCandidates.push({ target, reason });
  };

  const surfaceHasCandidateOwner = (surface: UISurface): boolean =>
    codeRefs.some((r) => coversLoose(surface, String(r.symbol ?? "")) || coversLoose(surface, String(r.module ?? "")));

  for (const surface of surfaces) {
    if (surface.authoritativeOwner) continue;
    if (!surfaceHasCandidateOwner(surface)) continue;
    pushDrift(`surface:${surface.id}`, "surface 未声明 authoritativeOwner,code 侧有候选 owner");
  }

  for (const entry of entries) {
    if (!codeRefs.some((r) => r.module === entry)) {
      pushDrift(`entry:${entry}`, "语义图声明但 depth1/2 codeRef 未见");
    }
  }
  for (const flow of flows) {
    const from = String(flow.from ?? "");
    const to = String(flow.to ?? "");
    const fromSeen = codeRefs.some((r) => r.module === from);
    const toSeen = codeRefs.some((r) => r.module === to);
    if (!fromSeen || !toSeen) {
      pushDrift(`flow:${from}->${to}`, "语义图声明但 depth1/2 codeRef 未见");
    }
  }

  // owner 缺口:缺 owner 且无代码候选 owner
  const unresolvedOwners: string[] = [];
  const firstEntry = entries.length > 0 ? entries[0] : undefined;
  let depth3Required = false;
  for (const surface of surfaces) {
    if (surface.authoritativeOwner) continue;
    if (surfaceHasCandidateOwner(surface)) continue;
    unresolvedOwners.push(`surface:${surface.id}`);
    const isKeyOwner = !!surface.steps?.submit || (firstEntry !== undefined && coversLoose(surface, firstEntry));
    if (isKeyOwner) depth3Required = true;
  }

  const snapshot: BuildSnapshot = {
    items,
    driftCandidates,
    unresolvedOwners,
    depth3Required,
    semanticsAccepted: input.acceptedSemantics,
  };
  const brief: ImpactBrief = { featureId, ...snapshot, codes: [] };

  const missingCodes = new Set<string>();
  for (const item of items) {
    if (item.evidence.semantic === undefined) missingCodes.add(FB_CODES.MISSING_SEMANTIC as string);
    if (item.evidence.surface === undefined) missingCodes.add(FB_CODES.MISSING_SURFACE as string);
    if (item.evidence.code === undefined) missingCodes.add(FB_CODES.MISSING_CODE as string);
  }

  const codes: string[] = [FB_CODES.BUILT as string];
  for (const code of [...missingCodes].sort()) codes.push(code);
  if (driftCandidates.length > 0) codes.push(FB_CODES.DRIFT as string);
  if (unresolvedOwners.length > 0) codes.push(FB_CODES.UNRESOLVED_OWNER as string);
  if (depth3Required) codes.push(FB_CODES.DEPTH3_REQUIRED as string);
  codes.push((canWriteE2E(brief) ? FB_CODES.E2E_ALLOWED : FB_CODES.E2E_BLOCKED) as string);
  brief.codes = codes;
  return brief;
}

/**
 * 能否写 E2E:语义已验收(semanticsAccepted 存在)且不存在「must 项三层证据缺任一」。
 * 与 buildImpactBrief 追加的 FB_E2E_ALLOWED 严格等价。
 */
export function canWriteE2E(brief: ImpactBrief): boolean {
  if (!brief || brief.semanticsAccepted === undefined) return false;
  const items = Array.isArray(brief.items) ? brief.items : [];
  for (const item of items) {
    if (!item || item.level !== "must") continue;
    const evidence = item.evidence ?? {};
    if (evidence.semantic === undefined || evidence.surface === undefined || evidence.code === undefined) {
      return false;
    }
  }
  return true;
}
