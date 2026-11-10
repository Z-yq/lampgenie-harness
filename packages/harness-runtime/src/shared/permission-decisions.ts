// @ts-nocheck — 子代理权限决策词汇(本仓自有)。BackendPort 收到的是逐操作决策;
// task/always/reject 三档的授权归属在 Gateway,适配器只执行。
export const PERMISSION_DECISIONS = Object.freeze(['task', 'always', 'reject'])

const KNOWN = new Set(PERMISSION_DECISIONS)

export function backendPermissionDecision(decision) {
  if (!KNOWN.has(decision)) throw new TypeError('Invalid permission decision')
  return decision === 'reject' ? 'reject' : 'once'
}
