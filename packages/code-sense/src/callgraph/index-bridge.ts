/**
 * callgraph/index-bridge( / §7 落地):索引桥边段计算的单一出处。
 * 把 的 A1 HTTP api 桥确定性边(exact/exact-folded,过可信度闸)挂进 c2f 索引:
 * buildC2fIndex(code-sense 全量)与 code-sense-cli 增量链(buildLocked)共用本函数——
 * 两条构建链不得各自实现第二份。
 * 纪律:
 *  - 运行时只经**动态 import** 触达 sensing/crosslang-bridge(sensing/index 静态引用
 *    callgraph/c2f,反向静态引用会成环;type-only import 编译期擦除,无环);
 *  - 桥通道失败永不毙索引构建:queryBridgeEdges 自身 degraded(无 rg 等)原样落盘;
 *    意外异常兜成 state="degraded" + 原因(fail-visible,不静默缺边);
 *  - 前端扩展名口径:opts.frontendExts > GENIE_SENSE_BRIDGE_FE_EXTS env > 宽网缺省
 *    (103 登记「CLI 缺省宽网,消费方按仓情收窄」的收窄口即此 env);实用口径记入
 *    bridge.frontendExts(env 改变索引内容,与 GENIE_SENSE_MAX_FILES 同族:口径必可见);
 *  - GENIE_SENSE_BRIDGE=off 整体关闭(字段缺席——大仓构建省时口)。
 */
import type { C2fIndex } from "./c2f";

export interface IndexBridgeOptions {
  /** 前端扩展名(逗号分隔 env 的显式覆盖;缺省=env→宽网)。 */
  frontendExts?: string[];
}

function envFrontendExts(): string[] | undefined {
  const raw = process.env.GENIE_SENSE_BRIDGE_FE_EXTS;
  if (!raw) return undefined;
  const exts = raw.split(",").map((s) => s.trim().replace(/^\./, "")).filter(Boolean);
  return exts.length > 0 ? exts : undefined;
}

/** 计算索引桥边段。返回 undefined=通道关闭(GENIE_SENSE_BRIDGE=off);其余形态恒返回对象。 */
export async function computeIndexBridge(root: string, opts?: IndexBridgeOptions): Promise<C2fIndex["bridge"]> {
  if (process.env.GENIE_SENSE_BRIDGE === "off") return undefined;
  const frontendExts = opts?.frontendExts ?? envFrontendExts();
  const base = {
    ...(frontendExts ? { frontendExts } : {}),
  };
  try {
    const mod = await import("../sensing/crosslang-bridge");
    const r = await mod.queryBridgeEdges(root, frontendExts ? { frontendExts } : undefined);
    if (r.degraded) {
      return { ...base, state: r.state, edges: [], degraded: r.degraded.reason };
    }
 // 规范化排序后落盘:rg 多线程输出序不稳(经验证同仓同参连跑两次 edges 序不同、集合相等),
    // 索引产物要「同盘同参字节可复现」(RC-L 公平采样同族纪律);排序不改变边集合与配对语义。
    // 比较键必须构成全序(稳定排序的输入序不稳,并列项会继承乱序)——一直比到 to.line/literal。
    const edges = [...r.edges].sort((a, b) => {
      if (a.from.file !== b.from.file) return a.from.file.localeCompare(b.from.file);
      if (a.from.line !== b.from.line) return a.from.line - b.from.line;
      const ta = `${a.to.method} ${a.to.path}@${a.to.file}:${a.to.line}`;
      const tb = `${b.to.method} ${b.to.path}@${b.to.file}:${b.to.line}`;
      if (ta !== tb) return ta.localeCompare(tb);
      return a.from.literal.localeCompare(b.from.literal);
    });
    return { ...base, state: r.state, edges, stats: r.stats };
  } catch (e) {
    return {
      ...base,
      state: "degraded",
      edges: [],
      degraded: `桥边提取异常(索引构建不受影响): ${String(e instanceof Error ? e.message : e)}`,
    };
  }
}
