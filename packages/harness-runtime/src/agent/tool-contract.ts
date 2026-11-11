/**
 * 工具契约按执行上下文投影:工具描述不再是一套静态文本发给所有 agent/模式。
 * 为什么「按上下文投影」而不是「按上下文改注册表」:
 * 注册表(工具本体 name/description/parameters/execute)是**全局唯一真源**——同一份 Tool 对象会被
 * main loop、子代理池、tool_view 全文、trace 记录、多处装配点共享。若按某个上下文就地改它的
 * description,下一处装配拿到的就是被人改过的脏值:plan 模式跑过一次之后,auto 模式会一直带着
 * 「当前只读模式」前缀(串味),而且不可回滚(隐式全局状态)。
 * 所以本模块的纪律只有一条:**先快照(复制入参与 availableTools 集合),再在新对象上派生**。
 * 入参 Tool 的任何字段都不被触碰;派生结果只交给「本次请求的 wire 描述」用。
 * 同一份注册表可以同时投影出 N 套互不干扰的描述。
 * 纯逻辑、零 IO、零依赖、不抛错:畸形入参一律退回「原样返回」(changed=false),工具照旧可用——
 * 描述投影失败不该让工具面装配失败。
 */

/** 一次装配的上下文。全部可选:空 ctx 或未知字段 = 原样返回。 */
export interface ToolContractContext {
 /** 执行者角色(装配期自报;不参与判定,留痕用)。 */
  agentType?: string;
 /** 权限模式:plan/readonly 为只读档;其余(含未知值)不投影只读前缀。 */
  permissionMode?: "auto" | "readonly" | "plan" | "ask" | string;
 /** 任务类别:coding / office / qa …(qa 只读调研、office 办公产出)。 */
  taskClass?: string;
 /** 本次装配**实际可用**的名字集合(工具名 + agent 名);委派类描述按它过滤。 */
  availableTools?: string[];
 /** 角色别名(可选,预留)。 */
  role?: string;
}

/** 投影所需的最小工具形状(不依赖 loop.ts 的 Tool,避免循环依赖)。 */
export interface ToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface DescribedTool {
  description: string;
 /** 深拷贝后的 schema:调用方随便改,不污染注册表里的 Tool。 */
  schema: Record<string, unknown>;
 /** 是否真的改动了(未知上下文/不命中任何规则 = false)。 */
  changed: boolean;
 /** 命中规则留痕(便于装配期与测试观测,不参与判定)。 */
  reasons: string[];
}

/** 只读模式下写类工具描述的前缀(幂等:已有同前缀不重复追加)。 */
export const READONLY_PREFIX = "当前只读模式,此工具不会执行写操作。";

/** qa(只读调研)任务类别下,写类工具描述的提示。 */
export const QA_READONLY_NOTE = "当前任务类别为 qa(只读调研),本工具默认不执行写操作。";

/** 委派类工具在「没有可委派 agent」时的追加提示。 */
export const NO_DELEGATE_NOTE = "当前无可委派 agent。";

/** 委派可用 agent 列表的行首标记(幂等判定用)。 */
export const DELEGATE_LIST_MARK = "可用 agent:";

/**
 * 写类工具:**显式集合**,不靠名字模糊匹配(write/edit/save 这类匹配一旦工具改名就静默失效,
 * 且容易误伤只读工具)。新增写类工具必须在这里登记。
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "terminal",
  "run_code",
  "board_upsert",
  "board_export_pptx",
  "experience_fold",
  "import_meeting",
  "steer_task",
  "answer_subagent",
]);

/** 委派类工具(描述里列 agent 名单):显式集合;含未实装的名字也不影响,它只是规则表。 */
export const DELEGATE_TOOLS: ReadonlySet<string> = new Set(["spawn_subagent", "list_agents", "run_workflow"]);

/** 内置 agent 名表(顺序即输出顺序,保证确定性)。 */
export const AGENT_NAME_TABLE: readonly string[] = [
  "worker",
  "explore",
  "judge",
  "test-analyst",
  "planner",
  "ppt-master",
];

/** office(办公产出)任务下不适用、需标注的工具 → 标注文本。 */
export const OFFICE_UNSUITABLE_TOOLS: Readonly<Record<string, string>> = {
  code_review: "本任务类别为 office(办公产出),代码评审不适用。",
  code_sense: "本任务类别为 office(办公产出),代码感知通常不适用(改代码请先更正 taskClass)。",
};

/** 深拷贝 schema;非对象退化为空对象(不抛错)。 */
function cloneSchema(parameters: unknown): Record<string, unknown> {
  if (!parameters || typeof parameters !== "object") return {};
  try {
    return structuredClone(parameters) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function isReadonlyMode(mode: string | undefined): boolean {
  const m = String(mode ?? "").toLowerCase();
  return m === "plan" || m === "readonly";
}

/** 幂等前置:已有同前缀就不再追加(否则多轮装配会叠成一串同样的句子)。 */
function withPrefix(desc: string, prefix: string): { text: string; hit: boolean } {
  if (desc.startsWith(prefix)) return { text: desc, hit: false };
  return { text: `${prefix}${desc}`, hit: true };
}

/** 幂等追加:已含该句/该标记就不再追加。 */
function withSuffix(desc: string, note: string, mark?: string): { text: string; hit: boolean } {
  if (mark ? desc.includes(mark) : desc.includes(note)) return { text: desc, hit: false };
  return { text: `${desc}\n${note}`, hit: true };
}

/**
 * 按上下文描述一个工具。**不改入参**:description 从快照副本派生,schema 深拷贝返回。
 * 规则(顺序固定,保证确定性):
 * 1) plan/readonly → 写类工具前置只读前缀(不删工具、不改 schema 执行语义);
 * 2) taskClass=qa → 写类工具追加只读提示;taskClass=office → 不适用工具追加标注;
 * 3) 委派类工具 → 只列 availableTools 中真实存在的 agent;列不出 → 追加「当前无可委派 agent」;
 * 其余上下文一律原样(changed=false)。
 */
export function describeToolForContext(tool: ToolLike, ctx?: ToolContractContext | null): DescribedTool {
 // ---- 快照:先把入参复制出来,后面所有派生只读副本、只写新字符串 ----
  const name = String(tool?.name ?? "");
  const original = String(tool?.description ?? "");
  let description = original;
  const available = new Set<string>(
    Array.isArray(ctx?.availableTools) ? ctx!.availableTools!.map((x) => String(x)) : [],
  );
  const schema = cloneSchema(tool?.parameters);
  const reasons: string[] = [];
  if (!name) return { description, schema, changed: false, reasons };

  try {
 // 1) 只读档:写类工具加前缀。工具仍在清单里、schema 不动——模型照样能看到并调用,
 // 只是明确知道「这次调用不会落写」。
    if (isReadonlyMode(ctx?.permissionMode) && WRITE_TOOLS.has(name)) {
      const r = withPrefix(description, READONLY_PREFIX);
      description = r.text;
      if (r.hit) reasons.push(`readonly-prefix:${String(ctx?.permissionMode).toLowerCase()}`);
    }

 // 2) 任务类别
    const taskClass = String(ctx?.taskClass ?? "").toLowerCase();
    if (taskClass === "qa" && WRITE_TOOLS.has(name)) {
      const r = withSuffix(description, QA_READONLY_NOTE);
      description = r.text;
      if (r.hit) reasons.push("task-class:qa");
    } else if (taskClass === "office" && OFFICE_UNSUITABLE_TOOLS[name]) {
      const r = withSuffix(description, OFFICE_UNSUITABLE_TOOLS[name]!);
      description = r.text;
      if (r.hit) reasons.push(`task-class:office:${name}`);
    }

 // 3) 委派类:只列本次装配里真实存在的 agent 名(按表顺序,确定性)
    if (DELEGATE_TOOLS.has(name)) {
      const agents = AGENT_NAME_TABLE.filter((a) => available.has(a));
      if (agents.length > 0) {
        const r = withSuffix(description, `${DELEGATE_LIST_MARK}${agents.join(", ")}。`, DELEGATE_LIST_MARK);
        description = r.text;
        if (r.hit) reasons.push(`delegate-agents:${agents.length}`);
      } else {
        const r = withSuffix(description, NO_DELEGATE_NOTE);
        description = r.text;
        if (r.hit) reasons.push("delegate-none");
      }
    }
  } catch {
 // 投影失败退回原样:描述装饰出问题不该让工具面装配失败
    return { description: original, schema: cloneSchema(tool?.parameters), changed: false, reasons: [] };
  }

  return { description, schema, changed: description !== original, reasons };
}

/**
 * 投影整个工具面:**返回新数组**(不 push/不 splice 入参),逐个按上下文派生描述。
 * 未改动的工具原样返回(保持引用,默认路径逐字节不变);改动过的工具是新对象(浅拷贝 + 新 schema)。
 * 确定性:同一 (tools, ctx) 必得同一结果;不抛错:畸形元素原样透传。
 */
export function projectToolsForContext<T extends ToolLike>(tools: T[], ctx?: ToolContractContext | null): T[] {
  if (!Array.isArray(tools)) return [];
  if (tools.length === 0) return [];
  const out: T[] = [];
  for (const t of tools) {
    try {
      const d = describeToolForContext(t, ctx);
      out.push(d.changed ? ({ ...t, description: d.description, parameters: d.schema } as T) : t);
    } catch {
      out.push(t);
    }
  }
  return out;
}
