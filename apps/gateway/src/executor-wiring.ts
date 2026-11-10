/**
 * executor 接线:TaskSupervisor 的任务交给 SubagentBackend 执行,
 * 事件回流到 journal + 任务状态推进。
 */
import { repoRoot } from "./repo-root.js";
import type { TaskSupervisor } from "./task-manager.js";
import type { Journal } from "@lampgenie/core";
import type { SubagentBackend, SubagentEvent } from "@lampgenie/executors";
import type { Task } from "@lampgenie/core";
import { ExperienceStore, recallExperiences, renderRecallBlock, distillFromTask } from "@lampgenie/experience";
import { join } from "node:path";
import type { NodeRegistry, NodeDispatch } from "./nodes.js";
import type { ProjectRegistry } from "./projects.js";
import type { PermissionBroker } from "./permission-broker.js";
import { loadRulesHot } from "./permission-store.js";
import { matchPermissionRule } from "@lampgenie/core";
import { dispatchGuard } from "./nodes.js";
import { recallDevlogs, renderDevlogBlock } from "@lampgenie/runtime/agent/devlog-recall";
import { snapshotApprovalObject, verifyApprovalObject } from "./approval-object.js";

export function wireExecutor(
  taskManager: TaskSupervisor,
  journal: Journal,
  backend: SubagentBackend,
  nodes?: NodeRegistry,
  nodeDispatch?: NodeDispatch,
  projects?: ProjectRegistry,
  permissionBroker?: PermissionBroker,
): void {
  taskManager.onChange((task: Task) => {
    if (task.state !== "running") return;
    void runTask(taskManager, journal, backend, task, nodes, nodeDispatch, false, projects, permissionBroker);
  });
  // 失联重派(step-033 P5,designs/09 工况 N 系):扫描已委派任务,节点 stale→RESCHEDULE。
  if (nodes && nodeDispatch) {
    const watch = setInterval(() => {
      for (const stale of nodeDispatch.staleAssignments()) {
        const cur = taskManager.get(stale.taskId);
        if (!cur || cur.state !== "running") {
          nodeDispatch.forget(stale.taskId);
          continue;
        }
        journal.append({
          kind: "task.progress",
          sessionId: stale.sessionId,
          payload: {
            taskId: stale.taskId,
            recovery: "RESCHEDULE",
            reason: `节点 ${stale.nodeId} 失联(心跳超时),任务重派`,
          },
        });
        nodeDispatch.forget(stale.taskId);
        // 重派=重新走分派守卫(可能换节点;无人可用→显式失败)。
        void runTask(taskManager, journal, backend, cur, nodes, nodeDispatch, true, projects, permissionBroker);
      }
    }, 5_000);
    watch.unref?.();
  }
}

async function runTask(
  tm: TaskSupervisor,
  journal: Journal,
  backend: SubagentBackend,
  task: Task,
  nodes?: NodeRegistry,
  nodeDispatch?: NodeDispatch,
  rescheduled = false,
  projects?: ProjectRegistry,
  permissionBroker?: PermissionBroker,
): Promise<void> {
  // 可达性分派守卫(R5-C11):带 resourceTags 的任务必须命中在线节点,否则显式失败。
  if (nodes) {
    const guard = dispatchGuard(nodes, { reachability: task.resourceTags });
    if (!guard.ok) {
      const cur = tm.get(task.id);
      if (cur && (cur.state === "running" || cur.state === "blocked")) tm.setState(cur, "failed", guard.reason);
      return;
    }
    if (guard.note) {
      journal.append({ kind: "task.progress", sessionId: task.sessionId, payload: { taskId: task.id, dispatch: guard.note, ...(rescheduled ? { rescheduled: true } : {}) } });
    }
    // tunnel 委派(step-033):命中非本机节点且有委派通道→任务书下发远端代执行。
    if (guard.node && guard.node.nodeId !== "local") {
      if (!nodeDispatch) {
        const cur = tm.get(task.id);
        if (cur && (cur.state === "running" || cur.state === "blocked")) {
          tm.setState(cur, "failed", `命中远端节点 ${guard.node.nodeId} 但委派通道未启用(不假装已派)`);
        }
        return;
      }
      const result = await nodeDispatch.delegate(
        { taskId: task.id, instruction: task.instruction, ...(task.credentialRef ? { credentialRef: task.credentialRef } : {}) },
        task.sessionId,
        { reachability: task.resourceTags },
      );
      // cancelled=失联重派时 forget 唤醒的哨兵:任务归属已移交重派轮,本轮静默退出。
      if (!result.ok && result.error === "cancelled") return;
      const cur = tm.get(task.id);
      if (!cur || cur.state !== "running") return;
      if (result.ok) tm.setState(cur, "done", result.output ?? "");
      else tm.setState(cur, "failed", result.error ?? "委派失败");
      return;
    }
  }
  // 开工回顾(designs/18 §3:主执行路径统一注入)
  const store = new ExperienceStore(join(repoRoot(), ".genie", "experiences"));
  const recalled = recallExperiences(store, task.instruction);
  const devlogs = recallDevlogs(join(repoRoot(), "devlog"), task.instruction);
  const instruction = task.instruction + renderRecallBlock(recalled) + renderDevlogBlock(devlogs);
  // checkpoint 快照(designs/21):执行前留工作区快照;GENIE_CHECKPOINT=off 跳过(测试提速)。
  if (process.env.GENIE_CHECKPOINT !== "off") {
    const { checkpointCreate } = await import("./git-service.js");
    const root = projects?.resolveWorkdir(task.projectId) ?? repoRoot();
    let sha: string | null = null;
    try { sha = await checkpointCreate(root); } catch { sha = null; }
    journal.append({ kind: "checkpoint.create", sessionId: task.sessionId, payload: { taskId: task.id, sha, root } });
  }
  // 聊天史语义(step-037):用户消息与最终回复入 journal(此前只在 task.done payload,史里不可见)。
  journal.append({ kind: "message.user", sessionId: task.sessionId, payload: { text: task.instruction } });
  journal.append({
    kind: "subagent.spawn",
    sessionId: task.sessionId,
    payload: { taskId: task.id, backend: backend.kind },
  });

  let handle: import("@lampgenie/executors").SubagentHandle | undefined;
  // ask 可能先于 handle 就绪到达(spawn 未 resolve 事件已回调)——挂起队列,handle 就绪后补发
  const pendingAsks: { requestId: string; decision: "allow-once" | "reject" }[] = [];
  // M151 审批对象=执行对象:派发入参只构造一次;审批前冻结、放行前按同一份可执行面复核。
  const spawnSpec = {
    taskId: task.id,
    instructions: instruction,
    // workdir 按项目解析(step-035):项目在且可用→项目路径;否则 harness 根。
    workdir: projects?.resolveWorkdir(task.projectId) ?? repoRoot(),
    permissions: "sandbox" as const,
  };
  const done = new Promise<void>((resolve) => {
    const onEvent = (e: SubagentEvent) => {
      // 权限请求自动应答(step-033):缺省 reject(fail-closed,解除子进程挂死);
      // env GENIE_SUBAGENT_ASK=allow-once 本地放行。人工审批=面板审批中心+弹窗(step-037 B2/step-010 收口),事件全落 journal。
      if (e.type === "permission-ask") {
        // M151:ask 前冻结可执行面(事件字段 + 真正派发的 spec),asked 事件带 objectHash。
        const approvalObject = () => ({
          requestId: e.requestId,
          summary: e.summary,
          risk: e.risk,
          spec: {
            taskId: spawnSpec.taskId,
            instructions: spawnSpec.instructions,
            workdir: spawnSpec.workdir,
            permissions: spawnSpec.permissions,
          },
        });
        const snap = snapshotApprovalObject(approvalObject());
        const objectHash = snap.ok ? snap.hash : undefined;
        journal.append({
          kind: "permission.gate",
          sessionId: task.sessionId,
          payload: {
            tool: "subagent",
            effect: "asked",
            by: e.summary.slice(0, 120),
            risk: e.risk,
            ...(objectHash ? { objectHash } : {}),
            ...(snap.ok ? {} : { snapshotError: snap.code }),
          },
        });
        // 三级决策(step-037 B2):env 放行 > 面板审批(broker) > auto-fail-closed。
        const applyDecision = (decision: "allow-once" | "reject", by: string) => {
          let finalDecision = decision;
          let finalBy = by;
          // M151 fail-closed:放行前用同一上下文复核,入参变了按 denied 处理。
          if (decision === "allow-once") {
            const verdict = snap.ok
              ? verifyApprovalObject(snap.frozen, approvalObject())
              : { ok: false as const, code: "PERMISSION_OBJECT_CHANGED" as const, beforeHash: "<no-snapshot>", afterHash: "<no-snapshot>" };
            if (!verdict.ok) {
              journal.append({
                kind: "permission.gate",
                sessionId: task.sessionId,
                payload: { tool: "subagent", effect: "object-changed", code: verdict.code, beforeHash: verdict.beforeHash, afterHash: verdict.afterHash, by: "approval-object" },
              });
              finalDecision = "reject";
              finalBy = "object-changed";
            }
          }
          journal.append({
            kind: "permission.gate",
            sessionId: task.sessionId,
            payload: { tool: "subagent", effect: finalDecision === "allow-once" ? "allowed" : "denied", by: finalBy, ...(objectHash ? { objectHash } : {}) },
          });
          if (handle) void handle.respondPermission(e.requestId, finalDecision).catch(() => { /* 子进程已退则忽略 */ });
          else pendingAsks.push({ requestId: e.requestId, decision: finalDecision });
        };
        if (process.env.GENIE_SUBAGENT_ASK === "allow-once") applyDecision("allow-once", "env-allow-once");
        else {
          // 规则咨询(F2 always-allow):确定性配置优先于交互;命中 allow/deny 即结算,未命中落面板。
          const rule = matchPermissionRule(loadRulesHot(repoRoot()), "subagent", e.summary);
          if (rule && rule.action === "allow") applyDecision("allow-once", "rule-allowed:" + rule.permission + "[" + (rule.pattern ?? "*") + "]");
          else if (rule && rule.action === "deny") applyDecision("reject", "rule-denied");
          else if (permissionBroker) {
            void permissionBroker.ask({ requestId: e.requestId, sessionId: task.sessionId, tool: "subagent", summary: e.summary, risk: e.risk })
              .then((o) => applyDecision(o.decision, o.by === "panel" ? (o.decision === "allow-once" ? "panel-approved" : "panel-denied") : "panel-timeout"));
          }
          else applyDecision("reject", "auto-fail-closed");
        }
        return;
      }
      journal.append({
        kind: "subagent.result",
        sessionId: task.sessionId,
        payload: { taskId: task.id, event: e },
        idempotencyKey: `subagent.${task.id}.${e.type}.${e.type === "progress" ? (e.note ?? "") : ""}`,
      });
      if (e.type === "result") {
        const cur = tm.get(task.id);
        if (cur && (cur.state === "running" || cur.state === "blocked")) {
          if (e.result.ok) {
            // 终态提炼(异步,前台优先)
            void distillFromTask(store, journal, { ...task, state: "done", result: e.result.finalText }).catch(() => {});
            journal.append({ kind: "message.agent", sessionId: task.sessionId, payload: { text: e.result.finalText ?? "" } });
            tm.setState(cur, "done", e.result.finalText);
          } else {
            // F5 失败轮沉淀:failed 终态同入经验提炼(确定性兜底→incidents candidate,hermes 负面清单纪律)。
            void distillFromTask(store, journal, { ...task, state: "failed", result: e.result.error?.detail ?? e.result.error?.kind ?? "unknown" }).catch(() => {});
            tm.setState(cur, "failed", e.result.error?.detail ?? e.result.error?.kind ?? "unknown");
          }
        }
        resolve();
      }
    };
    backend
      .spawn(spawnSpec, onEvent)
      .then((h) => {
        handle = h;
        for (const a of pendingAsks.splice(0)) void h.respondPermission(a.requestId, a.decision).catch(() => {});
      })
      .catch((err) => {
        const cur = tm.get(task.id);
        if (cur && (cur.state === "running" || cur.state === "blocked")) {
          tm.setState(cur, "failed", String(err));
        }
        resolve();
      });
  });

  await done;
}
