/**
 * wire:WS 消息协议表面(确定性行/结构扫描,不依赖索引、不调 LLM)。
 * 本仓真正的对外接口是 WS 消息协议:一条消息要同时出现在
 *   ① packages/protocol/src/index.ts 的 discriminatedUnion
 *   ② apps/gateway/src/server.ts 的 switch(msg.type) case
 *   ③ 面板/静态资源的发送与接收分支
 * 任一处漏掉就是静默失效。这里只做「看得见的对账」,不猜动态形态。
 */

export type WireUnionKind = "client" | "server" | "unknown";

export interface WireLocation {
  /** 相对 root 的 POSIX 路径。 */
  file: string;
  line: number;
}

export interface WireUnionMember {
  type: string;
  /** 协议常量名(TaskSubmit 等);内联 Envelope.extend 成员为空。 */
  declName?: string;
  file: string;
  /** type 字面量所在行(不是声明起始行)。 */
  line: number;
  inline: boolean;
}

export interface WireUnion {
  name: string;
  kind: WireUnionKind;
  file: string;
  line: number;
  members: WireUnionMember[];
}

export interface WireHandler extends WireLocation {
  type: string;
  /** 实际承载 handler 物理体的 case 行(fallthrough 组的最后一条)。 */
  handlerLine: number;
  /** 同一 fallthrough 组的全部 type(单条=自身)。 */
  group: string[];
}

export interface WireSend extends WireLocation {
  type: string;
  /** 调用形态:wsSafeSend / sendOrQueue / dashWsSend / ws.send / send … */
  call: string;
}

export type WireReceiveForm = "if" | "case";

export interface WireReceive extends WireLocation {
  type: string;
  form: WireReceiveForm;
  /** 判别式(如 m.type),case 形态才有。 */
  discriminator?: string;
}

export type WireStatus = "ok" | "orphan:no-handler" | "orphan:undeclared" | "hint:never-sent";

export interface WireTypeRow {
  type: string;
  unions: { name: string; kind: WireUnionKind; file: string; line: number }[];
  declaredAt: WireLocation[];
  handlers: WireHandler[];
  sends: WireSend[];
  receives: WireReceive[];
  status: WireStatus;
}

export interface WireOrphanDeclared {
  type: string;
  file: string;
  line: number;
}

export interface WireOrphans {
  /** A. ClientMessage 声明了,但 server.ts 无 handler。 */
  declaredNoHandler: WireOrphanDeclared[];
  /** B. server.ts 有 handler,但协议 union 里没有。 */
  handlerUndeclared: WireHandler[];
  /** C. 面板/assets 发送了,但协议 union 里没有。 */
  sendUndeclared: WireSend[];
  /** D. 协议声明了,但面板/assets 从不发送(提示级:远端/其它客户端可能发送)。 */
  declaredNeverSent: WireOrphanDeclared[];
  /** 补充(不在四类口径内):客户端接收了,但协议 union 里没有(服务端已发出)。 */
  receiveUndeclared: WireReceive[];
}

export interface WireChangedInfo {
  enabled: boolean;
  files: string[];
  /** 全部变化 type(added ∪ removed ∪ touched,已排序);过滤/渲染按此集合。 */
  types: string[];
  /** 新增:工作区有、HEAD 没有的 type 字面量(新增消息)。 */
  added: string[];
  /** 删除:HEAD 有、工作区没有的 type 字面量(删除消息;已不在当前协议里)。 */
  removed: string[];
  /** 改动:两版都有,且出现在 git diff 增删行上的 type 字面量。 */
  touched: string[];
  /** git 不可用/非仓/命令失败时的原因(此时不做过滤,全量展示)。 */
  gitError?: string;
  /** 仅当 --changed 生效且成功时给出。 */
  filtered?: boolean;
  note?: string;
}

export interface WireUnresolvedMember {
  union: string;
  text: string;
  line: number;
}

export interface WireScanResult {
  query: "wire";
  root: string;
  protocolFiles: string[];
  unions: WireUnion[];
  handlers: WireHandler[];
  sends: WireSend[];
  receives: WireReceive[];
  types: WireTypeRow[];
  orphans: WireOrphans;
  changed?: WireChangedInfo;
  stats: {
    unions: number;
    memberships: number;
    uniqueTypes: number;
    handlers: number;
    sends: number;
    receives: number;
    orphanDeclaredNoHandler: number;
    orphanHandlerUndeclared: number;
    orphanSendUndeclared: number;
    orphanDeclaredNeverSent: number;
    orphanReceiveUndeclared: number;
  };
  unresolved: WireUnresolvedMember[];
  /** 解析不到的形态如实列出,不猜不编。 */
  knownLimits: string[];
}

export interface WireScanOptions {
  /** 只保留 git 工作区 diff / 未跟踪文件里出现过的 type。 */
  changed?: boolean;
}
