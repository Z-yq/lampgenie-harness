/** 子代理目录 spec 装配(step-060):主 LLM 脚本派两个不同 title 的后台子代理(A 快 4s/B 慢 12s),
 * 再对 A 连续两次 task_output 轮询(轮询聚合断言素材);从消息历史里抽真实 agentId 回填轮询参数。
 * _ui_selfhost.cjs 的 --opts 形态:导出工厂,返回 createGatewayApp 附加选项。 */
const seen = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = function () {
  // UI spec 不需要 code_sense 开工意识:orient 的 ts-morph 全量索引在慢盘上会同步阻塞 selfhost
  // node 事件 loop 数分钟(spec 整轮假死的元凶,栈取证 getLineNumberAtPos/forEachChild 实锤)。
  process.env.GENIE_SENSE_ORIENT = "off";
  // 仓库根隔离(第二步):档案构建(profile.get→buildC2fIndex)在主进程跑分钟级全仓 callgraph,
  // setImmediate 批间让步压不住单文件秒级同步块——把 GENIE_REPO_ROOT 指到 3 文件临时仓,
  // 索引/档案/权限/agent-outputs 全部落 tmp,spec 面板行为与真仓一致且无索引阻塞。
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const tinyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subdir-root-"));
  fs.writeFileSync(path.join(tinyRoot, "pnpm-workspace.yaml"), "packages: []\n");
  fs.mkdirSync(path.join(tinyRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(tinyRoot, "src", "demo.ts"), "export function demoMain(): number { return demoHelp(); }\nexport function demoHelp(): number { return 1; }\n");
  process.env.GENIE_REPO_ROOT = tinyRoot;
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([
    { permission: "spawn_subagent", pattern: "*", action: "allow" },
    { permission: "task_output", pattern: "*", action: "allow" },
  ]);
  return {
    llm: { async chat(msgs) {
      const sys = JSON.stringify(msgs);
      if (sys.indexOf("独立上下文") >= 0) return { content: "(子代理轨不经过此 llm:executor 为自造后端)" };
      // 从 async_launched 回执抽真实 agentId(出现序=派发序;msgs JSON 化后引号被转义,
      // 按 agent_ 前缀裸抽+Set 去重,outputFile 路径里是同一 id 不影响)
      const ids = [...new Set(sys.match(/agent_[a-z0-9]+/g) || [])];
      const step = seen.length;
      seen.push(1);
      if (step === 0) {
        return { content: "", toolCalls: [
          { id: "t1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "调查整仓渲染链路并汇总输出", agentType: "explore", run_in_background: true, title: "渲染链路勘察" }) },
          { id: "t2", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "清点测试缺口并产出清单", agentType: "worker", run_in_background: true, title: "测试缺口清点" }) },
        ] };
      }
      if (step === 1 && ids.length >= 2) {
        return { content: "", toolCalls: [
          { id: "p1", name: "task_output", arguments: JSON.stringify({ agentId: ids[0] }) },
          { id: "p2", name: "task_output", arguments: JSON.stringify({ agentId: ids[0] }) },
        ] };
      }
      if (ids.length >= 2) return { content: "已派两个后台子代理(渲染链路勘察/测试缺口清点)并轮询过进度;渲染链路勘察完成后我会汇总。" };
      return { content: "已派出后台子代理。" };
    } },
    executor: { kind: "sbd-ui", async spawn(spec, onEvent) {
      const slow = String((spec && spec.instructions) || "").indexOf("测试缺口") >= 0;
      const total = slow ? 16000 : 4000; // B 拉长到 16s:给「A 完成后角标=1」留足观测窗(共享负载下前置检查可能吃掉数秒)
      const tag = slow ? "清点" : "扫描";
      for (let i = 1; i <= 3; i++) setTimeout(() => { try { onEvent({ type: "progress", note: tag + "第 " + i + " 批" }); } catch (e) { /* 宿主已收尾 */ } }, Math.round((i * total) / 4));
      setTimeout(() => { try { onEvent({ type: "result", result: { ok: true, finalText: slow ? "测试缺口清点完成:共 3 项。" : "渲染链路勘察完成:两处渲染点。" } }); } catch (e) { /* 宿主已收尾 */ } }, total);
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    } },
  };
};
