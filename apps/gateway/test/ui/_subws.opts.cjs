/** 子代理工作区 spec 装配(2026-10-16):executor 用默认 echo 配置(kind=echo-child)→ 网关自动替换为
 * 进程内 LlmLoopBackend(真子 loop),脚本 LLM 分流主/子两轨——子轨真实产生 loop 事件(经 subagent.event
 * 入主 journal),供「工作区 tab 实时增量/重放/主流零污染」断言。子轨两步各带延时:给「tab 打开先于事件
 * 到达」的实时断言留观测窗。_ui_selfhost.cjs 的 --opts 形态。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 只允许出现在 subagent.event(工作区)里的标记:模型中途文本(心跳只播「模型输出 N 字」不带正文,
// 终态 finalText/任务书/工具参数都不含它)——主会话流若出现即为 subagent.event 污染(双渲染)。
const WS_MARKER = "ws-only-marker-9137";
module.exports = function () {
  process.env.GENIE_SENSE_ORIENT = "off";
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const tinyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subws-root-"));
  fs.writeFileSync(path.join(tinyRoot, "pnpm-workspace.yaml"), "packages: []\n");
  fs.mkdirSync(path.join(tinyRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(tinyRoot, "src", "demo.ts"), "export function demoMain(): number { return demoHelp(); }\nexport function demoHelp(): number { return 2; }\n");
  process.env.GENIE_REPO_ROOT = tinyRoot;
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([
    { permission: "spawn_subagent", pattern: "*", action: "allow" },
    { permission: "task_output", pattern: "*", action: "allow" },
  ]);
  // 子代理工具 ask 一律放行(审批链第一级 env):否则子轨 grep 会弹面板权限对话框,
  // 60s 自动拒——spec 的点击断言被 permDialog 遮罩拦截(首轮实测)。
  process.env.GENIE_SUBAGENT_ASK = "allow-once";
  let childCalls = 0;
  let mainCalls = 0;
  return {
    // 会话 worker 每任务一进程(dist/session-worker.mjs)——UI 自启环境按 src 直跑,该入口常缺席
    // (并行构建半成品),回退进程内模式:子代理仍是进程内 LlmLoopBackend 真事件源,断言语义不变。
    config: { agent: { sessionWorker: false } },
    llm: { async chat(msgs) {
      const sys = JSON.stringify(msgs);
      if (sys.indexOf("独立上下文") >= 0) {
        // 子代理轨(进程内 LlmLoopBackend 真事件源):两步,各延时拉开事件流时间线
        childCalls++;
        if (childCalls === 1) {
          await sleep(2500);
          return { content: "中途观察:标记物 " + WS_MARKER + " 已定位,继续检索。", toolCalls: [
            { id: "w1", name: "grep", arguments: JSON.stringify({ pattern: "demoMain", path: tinyRoot }) },
          ] };
        }
        await sleep(3000);
        return { content: "子代理报告:检索完成,demoMain 定义集中于 src/demo.ts(两处引用)。" };
      }
      mainCalls++;
      if (mainCalls === 1) {
        return { content: "", toolCalls: [
          { id: "m1", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "在仓库内检索 demoMain 的出处并汇总成清单(工作区实测)", agentType: "explore", run_in_background: true, title: "渲染勘察" }) },
        ] };
      }
      return { content: "主 agent:后台勘察子代理已派出,完成后会回报。" };
    } },
    // executor 形态=echo-child(kind 判定键)→ agent-wiring 判定为进程内并替换为 LlmLoopBackend
    // (llm 走上方脚本);本体 spawn 不会被调用(替换即目的)。
    executor: { kind: "echo-child", async spawn() { throw new Error("in-process backend should replace this"); } },
  };
};
