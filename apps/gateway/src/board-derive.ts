/**
 * 白板「关系自动推导引擎」(设计板节点 n3):纯函数,零 IO。
 *
 * 背景:白板节点由 agent 落板时只写 nodes/accept/targets,edges 往往为空,人看到的板「没有结构」。
 * 本模块按**确定性规则**从已有事实补边,宁缺不猜:
 * - R0 显式边原样保留最前(用户/agent 画的边是事实,不改 kind/label,不补 virtual);
 * - R3 符号调用:仅当调用方给出 resolver(calleesOf)且真返回了被调方列表才连 call 边;
 * - R4 验收:accept.cmd 文本里出现了 B 的 targets 条目(≥6 字符才算,滤掉 index.ts 这类噪音);
 *   去假边两道闸:① 该 targets 条目只被 **1 个**节点引用时才可成边(≥2 节点引用的共享路径不唯一,跳过);
 *   ② 同一段 cmd 命中多个 B 时只留 id 前缀(首个 `-` 前)与 A 相同者,前缀都对不上则全部不生成;label 文案不变,只减量;
 * - R2 同组次序:同 group 内按声明序相邻两节点补 nav 边(无需索引,纯结构)。
 * 推导出的边一律 virtual: true(=待核实的推断边,画布虚线渲染),与实证边区分。
 *
 * 纪律:
 * - resolver 不可用/查不到必须返回 null —— 本模块据此**不造边**,不靠命名相似度猜;
 * - 自环与不存在的节点 id 不参与推导(显式边不受此限:原样保留);
 * - 上限 120 条(与 BoardDocZ.edges.max(120) 对齐),超出按 R0 > R3 > R4 > R2 截断;
 * - 纯函数:不读文件、不写文件、不 console.log、不改入参。
 */

export interface DeriveCtx {
  /** 符号→其直接被调方符号名;resolver 不可用/查不到必须返回 null(如实不造边) */
  calleesOf?: (symbol: string) => string[] | null;
}

export interface DerivedEdge {
  from: string;
  to: string;
  kind: "call" | "data" | "verify" | "nav" | "contains";
  label?: string;
  virtual?: true;
}

/** 推导边总数上限(与 BoardDocZ.edges.max(120) 对齐)。 */
const MAX_EDGES = 120;
/** R4 参与匹配的最短 targets 条目长度(滤掉 index.ts / a.ts 这类噪音子串)。 */
const MIN_TARGET_LEN = 6;

const KINDS: ReadonlyArray<DerivedEdge["kind"]> = ["call", "data", "verify", "nav", "contains"];

type Node = { id: string; label?: string; group?: string; targets?: string[]; accept?: Array<{ cmd: string }>; phase?: string; change?: string };
type ExplicitEdge = { from: string; to: string; kind?: string; label?: string };

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function strings(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

/** 显式边的 kind:合法值原样保留(不改 kind),非法/缺省按协议默认 call。 */
function keepKind(k: unknown): DerivedEdge["kind"] {
  return KINDS.includes(k as DerivedEdge["kind"]) ? (k as DerivedEdge["kind"]) : "call";
}

/**
 * 从节点/边推导白板关系边。返回顺序即优先级顺序:R0 显式边在最前,其后 R3 → R4 → R2。
 * @param nodes 板节点(声明序有意义:同组相邻按此序)
 * @param explicit 已有显式边(原样保留,不重复推导同 from→to)
 * @param ctx 推导上下文(缺省=无 resolver,则 R3 不产生任何边)
 */
export function deriveBoardEdges(
  nodes: Array<{ id: string; label?: string; group?: string; targets?: string[]; accept?: Array<{ cmd: string }>; phase?: string; change?: string }>,
  explicit: Array<{ from: string; to: string; kind?: string; label?: string }>,
  ctx?: DeriveCtx,
): DerivedEdge[] {
  const list: Node[] = Array.isArray(nodes) ? nodes.filter((n): n is Node => !!n && typeof n.id === "string" && n.id !== "") : [];
  const byId = new Map<string, Node>();
  for (const n of list) if (!byId.has(n.id)) byId.set(n.id, n);

  // 预计算 targets/cmds(perf cp-c2:避免同一节点在 R3/R4/R2 反复 strings/trim)
  const targetsOf = new Map<string, string[]>();
  const cmdsOf = new Map<string, string[]>();
  for (const n of list) {
    targetsOf.set(n.id, strings(n.targets));
    cmdsOf.set(n.id, (Array.isArray(n.accept) ? n.accept : [])
      .map((x) => (x && typeof x.cmd === "string" ? x.cmd.trim() : ""))
      .filter((c) => c !== ""));
  }

  const out: DerivedEdge[] = [];
  const used = new Set<string>(); // `${from}|${to}` 去重(先到先得=高优先级占位)
  const push = (e: DerivedEdge): boolean => {
    if (out.length >= MAX_EDGES) return false;
    const key = `${e.from}|${e.to}`;
    if (used.has(key)) return false;
    used.add(key);
    out.push(e);
    return true;
  };

  // ---- R0 显式边:原样保留在最前(不改 kind/label,不补 virtual;仅缺省 kind 按协议补 call) ----
  const ex = Array.isArray(explicit) ? explicit : [];
  for (const e of ex) {
    if (!e || typeof e.from !== "string" || typeof e.to !== "string") continue;
    if (e.from === "" || e.to === "") continue;
    const edge: DerivedEdge = { from: e.from, to: e.to, kind: keepKind(e.kind) };
    if (typeof e.label === "string") edge.label = e.label;
    push(edge);
  }

  // ---- R3 符号调用:A.targets 的 sA 经 resolver 直达 B.targets 的 sB 才连 call(不猜) ----
  const calleesOf = ctx && typeof ctx.calleesOf === "function" ? ctx.calleesOf : undefined;
  if (calleesOf) {
    const memo = new Map<string, string[] | null>();
    const callees = (sym: string): string[] | null => {
      if (memo.has(sym)) return memo.get(sym) ?? null;
      let r: string[] | null = null;
      try {
        const v = calleesOf(sym);
        r = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
      } catch {
        r = null; // resolver 抛错=不可用,如实不造边
      }
      memo.set(sym, r);
      return r;
    };
    // Map 化(perf 板 cp-c2):symbol→节点声明序索引,避免 A×B 全对扫描;
    // 仍按「B 声明序最小命中」选择,保持与旧嵌套循环相同的确定性结果。
    const targetIndex = new Map<string, number[]>();
    for (const [idx, b] of list.entries()) {
      for (const sB of targetsOf.get(b.id)!) {
        const arr = targetIndex.get(sB);
        if (arr) arr.push(idx);
        else targetIndex.set(sB, [idx]);
      }
    }
    for (const [aIdx, a] of list.entries()) {
      const sAs = targetsOf.get(a.id)!;
      if (sAs.length === 0) continue;
      if (out.length >= MAX_EDGES) break;
      let bestIdx = -1;
      let hit: { sA: string; sB: string } | null = null;
      for (const sA of sAs) {
        const cal = callees(sA);
        if (!cal || cal.length === 0) continue;
        for (const sB of cal) {
          if (sA === sB) continue;
          for (const bIdx of targetIndex.get(sB) ?? []) {
            if (bIdx === aIdx) continue; // R5 自环跳过
            if (bestIdx < 0 || bIdx < bestIdx) {
              bestIdx = bIdx;
              hit = { sA, sB };
            }
          }
        }
      }
      if (bestIdx >= 0 && hit) {
        push({ from: a.id, to: list[bestIdx]!.id, kind: "call", label: `${hit.sA}→${hit.sB}`, virtual: true });
      }
    }
  }

  // ---- R4 验收:A.accept[].cmd 文本里出现 B 的 targets 条目(≥6 字符)则 A→B verify ----
  // 去假边闸①:先数每个 targets 条目被几个不同节点引用;被 ≥2 节点引用=共享路径(不唯一),不参与 R4。
  const refCount = new Map<string, Set<string>>();
  for (const n of list) {
    for (const t of targetsOf.get(n.id)!) {
      if (t.length < MIN_TARGET_LEN) continue;
      const owners = refCount.get(t);
      if (owners) owners.add(n.id);
      else refCount.set(t, new Set([n.id]));
    }
  }
  /** id 前缀(首个 `-` 前);无 `-` 时整个 id 即前缀,用于判「同组」 */
  const groupPrefix = (id: string): string => {
    const i = id.indexOf("-");
    return i > 0 ? id.slice(0, i) : id;
  };
  // Map 化(perf cp-c2):唯一 targets 只遍历一次,避免 A×B 全对扫描;hits 仍按 B 声明序。
  const nodeIdx = new Map<string, number>();
  for (const [i, b] of list.entries()) if (!nodeIdx.has(b.id)) nodeIdx.set(b.id, i);
  const uniqueTargets: Array<{ text: string; ownerIdx: number }> = [];
  for (const [t, owners] of refCount) {
    if (owners.size !== 1) continue; // 闸①:共享路径不参与 R4
    const ownerId = [...owners][0]!;
    const idx = nodeIdx.get(ownerId);
    if (idx !== undefined) uniqueTargets.push({ text: t, ownerIdx: idx });
  }
  for (const [aIdx, a] of list.entries()) {
    if (out.length >= MAX_EDGES) break;
    const cmds = cmdsOf.get(a.id)!;
    if (cmds.length === 0) continue;
    const hitIdx = new Set<number>();
    for (const ut of uniqueTargets) {
      if (ut.ownerIdx === aIdx) continue; // R5 自环跳过
      if (cmds.some((c) => c.includes(ut.text))) hitIdx.add(ut.ownerIdx);
    }
    const hits = [...hitIdx].sort((x, y) => x - y).map((i) => list[i]!);
    // 闸②:同一次 accept 命中多个 B 时只留 id 前缀与 A 相同者;单命中不裁决。
    const keep = hits.length > 1 ? hits.filter((b) => groupPrefix(b.id) === groupPrefix(a.id)) : hits;
    for (const b of keep) {
      if (out.length >= MAX_EDGES) break;
      push({ from: a.id, to: b.id, kind: "verify", label: `验收 ${b.id} 的产物`, virtual: true });
    }
  }

  // ---- R2 同组次序:同 group 内按声明序相邻两节点补 nav(被占用/自环则跳过) ----
  const groups = new Map<string, Node[]>();
  for (const n of list) {
    const g = str(n.group).trim();
    if (g === "") continue; // 无组=不参与次序推导
    const arr = groups.get(g);
    if (arr) arr.push(n);
    else groups.set(g, [n]);
  }
  for (const arr of groups.values()) {
    for (let i = 0; i + 1 < arr.length; i++) {
      if (out.length >= MAX_EDGES) break;
      const from = arr[i]!.id;
      const to = arr[i + 1]!.id;
      if (from === to) continue; // R5 自环跳过
      push({ from, to, kind: "nav", label: "同组次序", virtual: true });
    }
  }

  return out.slice(0, MAX_EDGES);
}
