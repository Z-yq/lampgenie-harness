/**
 * 权限模式(ZCode 输入区「⏸ 完全访问」下拉对齐):
 * ask=现状(规则未命中→面板审批,超时 fail-closed);auto=自动放行(完全访问);readonly=自动拒绝写类;
 * plan=ZCode /mode plan(只读+规划提示:系统提示带「只规划不落盘」节,写类同样拒绝)。
 * workspace=工作区内(coding agent 只能读写当前项目目录内的文件,项目外读/写一律拒绝;审批走 ask 口径:
 * 规则未命中→面板审批,超时 fail-closed);auto=完全访问(文件围栏放开,允许绝对路径与 .. 越界,审批直通)。
 * main.ts 启动装载 + cfg.set permissions.mode 热更;agent-wiring 两处 ask 点咨询。
 */
export type PermissionMode = "ask" | "auto" | "readonly" | "plan" | "workspace";

let current: PermissionMode = "ask";

export function setPermissionMode(mode: string | undefined): void {
  current = mode === "auto" || mode === "readonly" || mode === "plan" || mode === "workspace" ? mode : "ask";
}

export function permissionMode(): PermissionMode {
  return current;
}
