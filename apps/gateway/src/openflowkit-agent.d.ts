/**
 * 手写声明: `@openflowkit/openflowkit-mcp@0.2.4` 只发布纯 JS 产物(dist/generated/*.js),
 * 无 .d.ts(package.json 亦无 exports/types 字段),TS 直引会报 TS7016。
 * 这里只声明 board 出图链路实际用到的 5 个入口,签名按实测调用方式给宽松 any,
 * 语义细节由 board-diagram.ts 收口,不在此处扩散。
 */
declare module "@openflowkit/openflowkit-mcp/dist/generated/openflowkit-agent.js" {
  /** 新建空白 agent 文档(返回 { pages: [{ id, ... }], ... })。 */
  export function createAgentDocument(kind: string): any;
  /** 生成文件能力集合(base64 读/写等),需与 compileWorkspace 合并后传给 runAgentOp。 */
  export function createFileCapabilities(opts: Record<string, unknown>): Promise<any>;
  /** DSL 工作区编译器(能力对象必需项)。 */
  export const compileWorkspace: any;
  /** 按 handle(如 "create_diagram"/"export")查 op 定义。 */
  export function findAgentOp(name: string): any;
  /** 执行 op: 返回 { document, output }。 */
  export function runAgentOp(
    op: any,
    input: Record<string, unknown>,
    ctx: { document: any; pageId: string; capabilities: any },
  ): Promise<any>;
}