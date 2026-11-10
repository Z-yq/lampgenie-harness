/** 子代理过程卡 spec 装配:脚本化主 LLM(派一次后台子代理即收尾)+慢子代理后端(进度事件分批吐)。
 * _ui_selfhost.cjs 的 --opts 形态:导出工厂,返回 createGatewayApp 附加选项。 */
const seen = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = function () {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([
    { permission: "spawn_subagent", pattern: "*", action: "allow" },
    { permission: "task_output", pattern: "*", action: "allow" },
  ]);
  return {
    llm: { async chat(msgs) {
      const sys = JSON.stringify(msgs);
      if (sys.indexOf("独立上下文") >= 0) {
        // 子 agent 轨:慢 6s(给面板留出「运行中+tail」观测窗)
        await sleep(6000);
        return { content: "子代理调查完成:渲染链路定位到 toolResultCard 与 renderHistory 两处。" };
      }
      if (seen.length === 0) {
        seen.push("spawn");
        return { content: "", toolCalls: [{ id: "b1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "调查整仓渲染链路并汇总输出", agentType: "explore", run_in_background: true }) }] };
      }
      return { content: "已派后台子代理调查渲染链路,完成后我会汇报。" };
    } },
    executor: { kind: "sbd-ui", async spawn(spec, onEvent) {
      const emit = (i) => setTimeout(() => { try { onEvent({ type: "progress", note: "扫描 packages 第 " + i + " 批" }); } catch (e) { /* 宿主已收尾 */ } }, i * 1300);
      [1, 2, 3].forEach(emit);
      setTimeout(() => { try { onEvent({ type: "result", result: { ok: true, finalText: "子代理调查完成:渲染链路定位到 toolResultCard 与 renderHistory 两处。" } }); } catch (e) { /* 宿主已收尾 */ } }, 6000);
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    } },
  };
};
