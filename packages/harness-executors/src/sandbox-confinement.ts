/**
 * 沙箱执行事实。
 * 为什么「声明不等于事实」:
 * spec.permissions = "sandbox" 只是调用方的意图声明;真正能限制住子代理的,
 * 是 runner(ndjson/echo/acp/cli/dsh)实际具备的隔离能力(文件系统/网络/进程/环境清洗)
 * 与派发策略。把声明直接当能力,等于给上层一盏永远为真的绿灯——子代理跑出去干了什么,
 * 结果里看不出任何约束证据。
 * 本模块把两者拆成两条独立判定:
 * 1) assessConfinement:只看 runner 的能力 → full / partial / none 事实等级 + 缺失原因;
 * 2) confineSpec:再把 spec 的越界请求(spec 级意图)逐条判成 violations,
 * 任一违规 → 调用方拒绝派发(不是静默降级、也不是偷偷改 spec)。
 * 纪律:纯函数、零 IO、不 throw、不改入参、确定性(无时间、无随机、无环境读取)。
 */

/** 事实等级:full=四项隔离全部证实;partial=至少一项;none=一项都没有/无法归因。 */
export type ConfinementLevel = "full" | "partial" | "none";

/** runner 归因(与 backend.kind 可能不同:echo-child 归因为 echo)。 */
export type ConfinementRunner = "ndjson" | "echo" | "acp" | "cli" | "dsh" | "unknown";

export interface ConfinementFacts {
  level: ConfinementLevel;
  runner: ConfinementRunner;
 /** 只有 full 才算「事实上的强制」;partial 只是部分能力,不能宣称受控。 */
  enforced: boolean;
 /** 每项缺失能力一条原因;权限声明与事实的落差也记在这里。 */
  reasons: string[];
 /** 本次被拒绝的规则类别(network/workdir/env/privilege),ok 时为空。 */
  denied: string[];
}

export interface ConfinementCapabilities {
  fsIsolation?: boolean;
  networkIsolation?: boolean;
  processIsolation?: boolean;
  envScrub?: boolean;
}

/** 待评估的派发意图(只读快照,函数不会改动它)。 */
export interface ConfinementSpecInput {
  permissions: string;
  workdir: string;
  instructions?: string;
  env?: Record<string, string>;
 /** 子代理是否请求网络;缺省视为未请求。 */
  network?: boolean;
}

export interface ConfinementPolicy {
  allowNetwork?: boolean;
  allowWriteOutsideWorkdir?: boolean;
  allowEnvInherit?: boolean;
  allowPrivilege?: boolean;
}

/** confineSpec 的判定结果:ok 时原样带回 spec(不静默改),不 ok 时给违规清单。 */
export type ConfinementVerdict =
  | { ok: true; facts: ConfinementFacts; spec: ConfinementSpecInput }
  | { ok: false; facts: ConfinementFacts; violations: string[] };

/** 能力 → 缺失原因。顺序固定,保证输出确定性。 */
const CAPABILITY_CHECKS: ReadonlyArray<{ key: keyof ConfinementCapabilities; reason: string }> = [
  { key: "fsIsolation", reason: "文件系统隔离未启用(fsIsolation=false)" },
  { key: "networkIsolation", reason: "网络隔离未启用(networkIsolation=false)" },
  { key: "processIsolation", reason: "进程隔离未启用(processIsolation=false)" },
  { key: "envScrub", reason: "环境变量清洗未启用(envScrub=false)" },
];

/** 凭据类环境变量名(值一律不看:只看键名就足够判定泄漏面)。 */
const ENV_CREDENTIAL_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD)/i;

/** 提权命令面:sudo/doas/runas/setuid 独立成词,su 只认 `su -c` 形态。 */
const PRIVILEGE_PATTERN = /\b(sudo|doas|runas|setuid)\b|\bsu\s+-c\b/i;

const RUNNER_BY_KIND: Readonly<Record<string, ConfinementRunner>> = {
  ndjson: "ndjson",
  echo: "echo",
  "echo-child": "echo",
  acp: "acp",
  cli: "cli",
  dsh: "dsh",
};

/** backend.kind → runner 归因;没有精确登记时按前缀识别,仍不认识 → unknown。 */
export function runnerOf(backendKind: string | undefined): ConfinementRunner {
  if (!backendKind) return "unknown";
  const exact = RUNNER_BY_KIND[backendKind];
  if (exact) return exact;
  for (const kind of Object.keys(RUNNER_BY_KIND)) {
    if (backendKind.startsWith(kind)) return RUNNER_BY_KIND[kind]!;
  }
  return "unknown";
}

const RUNNER_LABELS: Readonly<Record<ConfinementRunner, string>> = {
  ndjson: "NDJSON-RPC 子进程(按全能力登记:fs/network/process/env 四项隔离)",
  echo: "echo 契约子进程(只回放协议,不执行真实命令 → 无隔离能力)",
  acp: "ACP 外部 agent 适配器(隔离取决于 adapter,按未证实计)",
  cli: "CLI 子进程(隔离取决于本机 shell,按未证实计)",
  dsh: "dsh SDK 生产 executor(隔离取决于 SDK 运行环境)",
  unknown: "未知 runner(无法归因隔离能力)",
};

/** 人读的 runner 归因文本。 */
export function runnerLabel(backendKind: string | undefined): string {
  const runner = runnerOf(backendKind);
  const kind = backendKind ?? "未提供";
  return `runner=${runner}(kind=${kind}) → ${RUNNER_LABELS[runner]}`;
}

/** 人读的事实文本(日志/面板用,不参与判定)。 */
export function describeConfinement(facts: ConfinementFacts): string {
  const parts = [
    `runner=${facts.runner}`,
    `level=${facts.level}`,
    `enforced=${facts.enforced ? "yes" : "no"}`,
  ];
  if (facts.reasons.length > 0) parts.push(`缺失=${facts.reasons.join(";")}`);
  if (facts.denied.length > 0) parts.push(`拒绝=${facts.denied.join(",")}`);
  return parts.join(" ");
}

/**
 * 只按 runner 能力算事实等级。
 * unknown runner 一律 none:归因不了就等于没有约束,不能借「四能力全真」外推。
 */
export function assessConfinement(
  backendKind: string | undefined,
  capabilities: ConfinementCapabilities = {},
): ConfinementFacts {
  const runner = runnerOf(backendKind);
  const reasons: string[] = [];
  let held = 0;
  for (const check of CAPABILITY_CHECKS) {
    if (capabilities[check.key] === true) held += 1;
    else reasons.push(check.reason);
  }

  let level: ConfinementLevel;
  if (runner === "unknown") {
    level = "none";
    reasons.push(`未知 runner(kind=${backendKind ?? "未提供"}):隔离能力无法归因,等级按 none 计`);
  } else if (held === CAPABILITY_CHECKS.length) {
    level = "full";
  } else if (held > 0) {
    level = "partial";
  } else {
    level = "none";
  }

  return { level, runner, enforced: level === "full", reasons, denied: [] };
}

const isAbsoluteWorkdir = (p: string): boolean => /^([/\\]|[A-Za-z]:[\\/])/.test(p);
const escapesWorkdir = (p: string): boolean => p.split(/[\\/]+/).includes("..");

/**
 * 判定一次派发是否被允许。
 * - 违规 → { ok:false, violations }(调用方必须拒绝派发,不得降级放行);
 * - 通过 → { ok:true, spec }(spec 原样返回,一个字段都不改)。
 * context 携带 runner 归因与能力快照(backend 侧从自身钩子取);
 * 不传 context 时按未知 runner 评 → level=none(没有声明就没有事实)。
 */
export function confineSpec(
  spec: ConfinementSpecInput,
  policy: ConfinementPolicy = {},
  context: { backendKind?: string; capabilities?: ConfinementCapabilities } = {},
): ConfinementVerdict {
  const base = assessConfinement(context.backendKind, context.capabilities ?? {});
  const reasons = [...base.reasons];
  const violations: string[] = [];
  const denied: string[] = [];

  const deny = (rule: string, detail: string): void => {
    if (!denied.includes(rule)) denied.push(rule);
    violations.push(`${rule}: ${detail}`);
  };

 // 1) 权限声明与事实的落差:声明本身不产生隔离,只产生理由。
  if (spec.permissions !== "sandbox" && spec.permissions !== "readonly") {
    reasons.push(`permissions=${spec.permissions}: 未声明沙箱/只读,confinement 不可判定为强制`);
  } else if (spec.permissions === "sandbox" && base.level === "none") {
    reasons.push("permissions=sandbox 仅为声明:runner 无任何隔离能力,事实等级仍是 none");
  } else if (spec.permissions === "readonly" && base.level !== "full") {
    reasons.push(`permissions=readonly 仅为声明:runner 事实等级为 ${base.level}`);
  }

 // 2) 网络:默认拒绝,只有策略显式允许才放行。
  if (spec.network === true && policy.allowNetwork !== true) {
    deny("network", "spec 请求网络(network=true),策略 allowNetwork=false");
  }

 // 3) 工作目录:空(无法定位执行根)/ 相对路径(随 cwd 漂移)/ 含 .. 越界。
  const workdir = typeof spec.workdir === "string" ? spec.workdir.trim() : "";
  if (!workdir) {
    deny("workdir", "workdir 为空:无法确定执行根,越界不可判定");
  } else if (!isAbsoluteWorkdir(workdir)) {
    deny("workdir", `workdir 非绝对路径(${workdir}):相对路径会随 cwd 漂移`);
  } else if (escapesWorkdir(workdir) && policy.allowWriteOutsideWorkdir !== true) {
    deny("workdir", `workdir 含 .. 越界段(${workdir}),策略 allowWriteOutsideWorkdir=false`);
  }

 // 4) 环境:凭据类键名一律拒绝(只看键名,不看值——看值就会把密钥读进日志)。
  const envKeys = spec.env && typeof spec.env === "object" ? Object.keys(spec.env) : [];
  for (const key of envKeys) {
    if (ENV_CREDENTIAL_PATTERN.test(key) && policy.allowEnvInherit !== true) {
      deny("env", `env 含凭据类变量 ${key},策略 allowEnvInherit=false`);
    }
  }

 // 5) 提权命令:instructions 里出现即拒绝(子代理没有提权通道,出现就是越界意图)。
  const instructions = typeof spec.instructions === "string" ? spec.instructions : "";
  if (instructions.length > 0 && PRIVILEGE_PATTERN.test(instructions) && policy.allowPrivilege !== true) {
    deny("privilege", "instructions 含提权命令(sudo/su -c/doas/runas/setuid),策略 allowPrivilege=false");
  }

 // 拒绝只记录在 denied/violations 里:能力事实(level/enforced)不被改写,
 // 这样面板能同时看到「runner 本来有多强」与「本次被哪条规则挡下」。
  const facts: ConfinementFacts = {
    level: base.level,
    runner: base.runner,
    enforced: base.enforced,
    reasons,
    denied,
  };

  if (violations.length > 0) return { ok: false, facts, violations };
  return { ok: true, facts, spec };
}
