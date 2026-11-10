/**
 * agent 工具 `team_task`(机制):团队任务 DAG 的模型面。
 * 一个工具 8 个动作,名字/参数/错误码是硬契约(与 team-task-store 同名方法一一对应):
 *   list/create/claim/heartbeat/complete/fail/reassign/delete
 * 返回纪律:
 * - 一律 JSON 文本(字符串);成功 `{ok:true, ...}`;
 * - 失败 **不吞**:TeamTaskError 的 code 原样进 JSON(`{ok:false, code, message, details}`),
 *   模型能据此区分「revision 冲突要重读」与「依赖未完成要等」;非本模块异常归 TEAM_TASK_INVALID;
 * - `list` 只返摘要(不含 result 等大字段),避免整板结果灌进上下文。
 */
import type { Journal } from "@lampgenie/core";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { TeamTaskError, TeamTaskStore, type Task } from "./team-task-store.js";

const ACTIONS = [
  "list",
  "create",
  "claim",
  "heartbeat",
  "complete",
  "fail",
  "reassign",
  "delete",
] as const;

type Action = (typeof ACTIONS)[number];

/** list 摘要行:去掉 result 大字段(单独 get 也没有入口,摘要是工具面唯一的读法)。 */
function summarize(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    blockedBy: t.blockedBy,
    writeScopes: t.writeScopes,
    ...(t.owner !== undefined ? { owner: t.owner } : {}),
    ...(t.claimExpiresAt !== undefined ? { claimExpiresAt: t.claimExpiresAt } : {}),
    ...(t.heartbeatAt !== undefined ? { heartbeatAt: t.heartbeatAt } : {}),
    attempts: t.attempts,
    revision: t.revision,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function errorJson(err: unknown): string {
  if (err instanceof TeamTaskError) {
    return JSON.stringify(
      { ok: false, code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      null,
      2);
  }
  const message = err instanceof Error ? err.message : String(err);
  return JSON.stringify({ ok: false, code: "TEAM_TASK_INVALID", message }, null, 2);
}

/** 构造 team_task 工具(存量 store 可注入,缺省按 journal+sessionId 现建)。 */
export function teamTaskTool(journal: Journal, sessionId: string, opts?: { store?: TeamTaskStore }): Tool {
  const store = opts?.store ?? new TeamTaskStore(journal, { sessionId });
  return {
    name: "team_task",
    description:
      "团队任务板(DAG):多 agent 协作时登记/认领/推进任务。action=list(看板)/create(title,blockedBy,writeScopes)/" +
      "claim(id,owner,ttlMs)/heartbeat(id,owner)/complete(id,result)/fail(id,error)/reassign(id,owner)/delete(id)。" +
      "依赖未完成的任务不可认领;claim 返回 warnings=写域可能与别人重叠(只警告不加锁)。" +
      "凡传 expectedRevision 的变更遇到他人先改会返回 TEAM_TASK_REVISION_CONFLICT(带 current),重读后再试。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          description: "list 看板/create 新建/claim 认领/heartbeat 续租/complete 完成/fail 失败/reassign 改派/delete 删除",
        },
        id: { type: "string", description: "任务 id(除 list/create 外必填)" },
        title: { type: "string", description: "create:任务标题(短句,必填)" },
        blockedBy: { type: "array", items: { type: "string" }, description: "create:依赖的任务 id 列表(全部 done 才算 ready)" },
        writeScopes: { type: "array", items: { type: "string" }, description: "create:预计改动的路径/glob(与其它认领任务重叠时只警告)" },
        owner: { type: "string", description: "claim/reassign:认领者标识(缺省用当前 agent 名)" },
        expectedRevision: { type: "number", description: "CAS:上一次读到的 revision;不符则拒绝写入" },
        ttlMs: { type: "number", description: "claim/heartbeat:租约毫秒(缺省 300000)" },
        result: { type: "string", description: "complete:结果摘要" },
        error: { type: "string", description: "fail:失败原因" },
      },
      required: ["action"],
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as Record<string, unknown>;
      const action = typeof a.action === "string" ? a.action.trim() : "";
      if (!(ACTIONS as readonly string[]).includes(action)) {
        return errorJson(
          new TeamTaskError("TEAM_TASK_INVALID", `action 非法:"${action}"(可选 ${ACTIONS.join("/")})`, { field: "action" }),
        );
      }
      const id = typeof a.id === "string" ? a.id.trim() : "";
      const owner = typeof a.owner === "string" ? a.owner.trim() : "";
      const expectedRevision = typeof a.expectedRevision === "number" ? a.expectedRevision : undefined;
      const now = Date.now();
      try {
        switch (action as Action) {
          case "list": {
            const tasks = store.list().map(summarize);
            const byStatus: Record<string, number> = {};
            for (const t of store.list()) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
            return JSON.stringify({ ok: true, tasks, count: tasks.length, byStatus }, null, 2);
          }
          case "create": {
            const task = store.create(
              {
                title: typeof a.title === "string" ? a.title : "",
                ...(Array.isArray(a.blockedBy) ? { blockedBy: a.blockedBy as string[] } : {}),
                ...(Array.isArray(a.writeScopes) ? { writeScopes: a.writeScopes as string[] } : {}),
              },
              expectedRevision);
            return JSON.stringify({ ok: true, task: summarize(task), revision: task.revision }, null, 2);
          }
          case "claim": {
            const r = store.claim(id, owner, { ...(expectedRevision !== undefined ? { expectedRevision } : {}), now, ...(typeof a.ttlMs === "number" ? { ttlMs: a.ttlMs } : {}) });
            return JSON.stringify(
              { ok: true, task: summarize(r.task), revision: r.task.revision, warnings: r.warnings },
              null,
              2);
          }
          case "heartbeat": {
            const task = store.heartbeat(id, owner, { ...(expectedRevision !== undefined ? { expectedRevision } : {}), now, ...(typeof a.ttlMs === "number" ? { ttlMs: a.ttlMs } : {}) });
            return JSON.stringify({ ok: true, task: summarize(task), revision: task.revision }, null, 2);
          }
          case "complete": {
            const task = store.complete(id, {
              ...(expectedRevision !== undefined ? { expectedRevision } : {}),
              ...(typeof a.result === "string" ? { result: a.result } : {}),
              ...(owner ? { owner } : {}),
              now,
            });
            return JSON.stringify({ ok: true, task: summarize(task), revision: task.revision }, null, 2);
          }
          case "fail": {
            const task = store.fail(id, {
              ...(expectedRevision !== undefined ? { expectedRevision } : {}),
              ...(typeof a.error === "string" ? { error: a.error } : {}),
              ...(owner ? { owner } : {}),
              now,
            });
            return JSON.stringify({ ok: true, task: summarize(task), revision: task.revision }, null, 2);
          }
          case "reassign": {
            const task = store.reassign(id, owner, { ...(expectedRevision !== undefined ? { expectedRevision } : {}), now });
            return JSON.stringify({ ok: true, task: summarize(task), revision: task.revision }, null, 2);
          }
          case "delete": {
            const r = store.delete(id, { ...(expectedRevision !== undefined ? { expectedRevision } : {}), now });
            return JSON.stringify({ ok: true, id: r.id, revision: r.revision, deleted: true }, null, 2);
          }
          default:
            return errorJson(new TeamTaskError("TEAM_TASK_INVALID", `未实现的 action:${action}`, { field: "action" }));
        }
      } catch (err) {
        return errorJson(err);
      }
    },
  };
}
