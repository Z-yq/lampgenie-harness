/** 板型画像引擎(非 page 板画布专用):
 * 把「13 类板型该怎么画」从纯提示词变成画布可见的结构:
 *  - 每类有固定阶段(stage)清单与顺序:code=现状/变更/影响/验收,test=数据/执行/被测/判定/断言/回归,
 * fault=复现/异常/假设/根因/修复/防复发,refactor=现状/目标/展开/迁移//回滚,…
 *  - 节点按 group/label 归到阶段,画布顶部出「板型 + 规模 + 阶段覆盖」头,缺段可见;
 *  - 节点卡出角色 chip、硬规则徽标(改前/目标/验收/证据/分支/P0)与 flow 关键步骤/if-else;
 *  - 调研板额外给矩阵权重/未知/置信信息(表格视图消费)。
 * 纯函数零 IO/零 DOM;浏览器挂 BoardTypeProfile,panel.ts 调用;vitest 直接 module.exports 单测。
 * 不改板数据:未知板型返回 null,旧板走原渲染(零回退风险)。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root = root || (typeof self !== "undefined" ? self : globalThis);
    root.BoardTypeProfile = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

 // 板型强调色改读主题令牌 var(--bcv-lane-N),colorHex 保留原色值给
  // 需要拼透明度的消费点(panel.ts cvTypeHeadHtml 的 border-color + "55")。
  var PROFILES = {
    code: {
      label: "代码开发", short: "CODE", icon: "⌘", color: "var(--bcv-lane-3, #7fd6a5)", colorHex: "#7fd6a5",
      rule: "现状/变更两层显式;flow 展开 if/else;impact 落上游+下游+关联测试;verify 收口",
      edgeHint: "call=调用方→被调方 · verify=断言→被测 · data=数据流",
      stages: [
        { key: "current", label: "现状层", aliases: ["现状", "现有", "current"], hint: "目标文件/符号 + 上游 callers + 下游 callees + 数据/事件依赖" },
        { key: "change", label: "变更层", aliases: ["变更", "改动", "change"], hint: "add/modify/delete + 理由 + before" },
        { key: "impact", label: "影响面", aliases: ["影响", "上游", "下游", "波及", "关联测试", "tests"], hint: "code_sense impact:上游 caller / 下游依赖 / 关联测试文件" },
        { key: "verify", label: "验收", aliases: ["验收", "回归", "accept", "验证"], hint: "command/browser/manual/negative,每条带 expect" },
      ],
    },
    test: {
      label: "测试", short: "TEST", icon: "✓", color: "var(--bcv-lane-6, #6fd6d6)", colorHex: "#6fd6d6",
      rule: "六段:数据(正常/边界/异常)→执行→被测逻辑→decision 分支→断言 expect→回归锚;verify 连被测逻辑",
      edgeHint: "verify=断言→被测逻辑 · data=数据/结果传递",
      stages: [
        { key: "data", label: "测试数据", aliases: ["测试数据", "数据", "用例数据", "fixture"], hint: "正常/边界/异常三分区,缺一即 issue" },
        { key: "run", label: "测试执行", aliases: ["执行", "运行", "run"], hint: "怎么跑、环境、命令/夹具" },
        { key: "logic", label: "被测逻辑", aliases: ["被测", "被测逻辑", "目标逻辑", "logic"], hint: "symbolRef linked,禁占位" },
        { key: "decision", label: "分支覆盖", aliases: ["分支", "decision", "判定", "条件覆盖"], hint: "条件文本 + ≥2 出口" },
        { key: "assert", label: "断言", aliases: ["断言", "期望", "expect", "assert", "通过标准"], hint: "可判定期望,禁「验证正确」" },
        { key: "regression", label: "回归锚", aliases: ["回归", "regression", "复跑", "锚"], hint: "失败/修复后复跑路径" },
      ],
    },
    docs: {
      label: "文档/PPT", short: "DOCS", icon: "▤", color: "var(--bcv-lane-1, #f0a15e)", colorHex: "#f0a15e",
      rule: "两层:大骨架(章 section+断言标题,data 推进)→逐章丰富成页(page contains 进章,页标题=断言,summary 带证据);结论是根;不用例卡式章节清单",
      edgeHint: "data=章节承接/问答推进 · contains=页归属章 · verify=成品/大纲复核",
      stages: [
        { key: "verdict", label: "结论", aliases: ["结论", "推荐", "答案", "verdict"], hint: "全文断言,结论先行" },
        { key: "chapter", label: "章", aliases: ["章", "部分", "chapter", "篇"], hint: "大骨架:断言标题+章节职责" },
        { key: "page", label: "页", aliases: ["页", "slide", "P", "要点"], hint: "逐章丰富:一页一论点,summary 带证据" },
        { key: "evidence", label: "论证/证据", aliases: ["论证", "证据", "数据", "案例", "对比", "实测"], hint: "每页证据来源,不堆 bullet" },
        { key: "action", label: "行动/下一步", aliases: ["行动", "下一步", "建议", "落地", "验收", "收尾", "交付"], hint: "读者读完做什么" },
      ],
    },
    fault: {
      label: "排障/修复", short: "FAULT", icon: "⚠", color: "var(--bcv-lane-4, #f27c8d)", colorHex: "#f27c8d",
      rule: "六段故障链;根因必须挂证据边并写死;排除假设留依据;防复发=可执行动作+owner",
      edgeHint: "data/verify=观测→根因证据、修复→回归;失败分支显式",
      stages: [
        { key: "repro", label: "复现条件", aliases: ["复现", "repro", "环境", "输入"], hint: "环境/输入/版本" },
        { key: "observe", label: "观测异常", aliases: ["异常", "观测", "日志", "指标", "trace"], hint: "日志/指标/trace 证据" },
        { key: "hypothesis", label: "候选假设", aliases: ["假设", "hypothesis", "候选"], hint: "≥2,可证伪;被排除的写依据" },
        { key: "root", label: "根因", aliases: ["根因", "root cause", "真因"], hint: "锁定的具体根因,禁预期/待定" },
        { key: "fix", label: "修复点", aliases: ["修复", "fix", "补丁", "变更"], hint: "change 标注,不夸大改动量" },
        { key: "prevent", label: "防复发", aliases: ["防复发", "回归", "regression", "recur"], hint: "可执行动作+owner,禁「加强意识」" },
      ],
    },
    refactor: {
      label: "重构/迁移", short: "REFACTOR", icon: "⇄", color: "var(--bcv-lane-5, #c99bff)", colorHex: "#c99bff",
      rule: "现状/目标双图 + 1:1/N:1 映射;expand→migrate→contract;兼容窗口与回滚点显式",
      edgeHint: "data=新旧映射/迁移数据;1:1、N:1 写边 label;verify=新旧对拍",
      stages: [
        { key: "current", label: "现状层", aliases: ["现状", "旧版", "旧链路", "current", "before"], hint: "现状子图" },
        { key: "target", label: "目标层", aliases: ["目标", "新版", "新链路", "target", "after"], hint: "目标子图;无映射边标「纯新增」" },
        { key: "expand", label: "展开", aliases: ["展开", "expand", "并存", "双写"], hint: "新旧并存,不动旧物;过渡构件标「迁完删除」" },
        { key: "migrate", label: "迁移", aliases: ["迁移", "migrate", "切换"], hint: "逐消费方迁移" },
        { key: "contract", label: "收口", aliases: ["收口", "contract", "删除旧", "零读取"], hint: "零读取后删旧,独立编号步骤" },
        { key: "rollback", label: "兼容/回滚", aliases: ["兼容", "回滚", "rollback", "窗口"], hint: "兼容窗口 + 回滚触发条件" },
      ],
    },
    perf: {
      label: "性能优化", short: "PERF", icon: "⚡", color: "var(--bcv-lane-1, #e0b46a)", colorHex: "#e0b46a",
      rule: "基线→瓶颈(profiling 证据)→改动→目标;数字+单位+百分位;基线与验收同口径;CI 门禁",
      edgeHint: "data=指标传递;verify=改动→目标指标(同环境)",
      stages: [
        { key: "baseline", label: "基线", aliases: ["基线", "baseline", "当前指标"], hint: "数字+单位+百分位,同环境同负载" },
        { key: "bottleneck", label: "瓶颈", aliases: ["瓶颈", "profiling", "火焰图", "热点", "慢查询"], hint: "火焰图/USE/慢查询 trace 证据" },
        { key: "change", label: "改动", aliases: ["改动", "改造", "优化", "change", "修复"], hint: "改什么,对应哪个瓶颈" },
        { key: "target", label: "目标", aliases: ["目标", "target", "阈值", "验收"], hint: "目标值 ≤ 阈值,数字+单位" },
        { key: "gate", label: "门禁", aliases: ["门禁", "CI", "gate", "预算", "监控"], hint: "阈值固化进 CI/监控" },
      ],
    },
    data: {
      label: "数据/批处理", short: "DATA", icon: "⇉", color: "var(--bcv-lane-2, #6fa8ff)", colorHex: "#6fa8ff",
      rule: "输入→清洗→输出;幂等三选一;dry-run+样本量;质量断言先验后落;隔离/triage/回填",
      edgeHint: "data=输入→清洗→输出;verify=质量断言;失败分支到隔离区",
      stages: [
        { key: "input", label: "输入", aliases: ["输入", "源数据", "input", "数据集"], hint: "源数据集 + 样本量 N" },
        { key: "clean", label: "清洗/转换", aliases: ["清洗", "转换", "transform", "清洗链"], hint: "dry-run 先行;幂等策略" },
        { key: "output", label: "输出", aliases: ["输出", "目标表", "output", "落库", "落盘", "写盘", "原子写"], hint: "目标数据集(先 staging)" },
        { key: "quality", label: "质量断言", aliases: ["质量", "唯一", "非空", "引用完整性", "新鲜度", "断言"], hint: "unique/not_null/accepted_values/引用完整性/新鲜度,落在输出之前" },
        { key: "quarantine", label: "脏数据/隔离", aliases: ["脏数据", "隔离", "quarantine", "DLQ", "失败"], hint: "隔离区 + triage 计划" },
        { key: "backfill", label: "重跑/回填", aliases: ["重跑", "回填", "backfill", "部分失败"], hint: "部分失败/backfill 入口" },
      ],
    },
    contract: {
      label: "接口/契约", short: "CONTRACT", icon: "⇋", color: "var(--bcv-lane-4, #f27c8d)", colorHex: "#f27c8d",
      rule: "字段级 add/modify/delete+before;semver;全消费者;弃用日期;迁移路径;契约测试",
      edgeHint: "data=字段/版本传播;verify=契约测试;每条 breaking 有迁移路径",
      stages: [
        { key: "field", label: "契约字段", aliases: ["字段", "schema", "契约", "field"], hint: "每条 add/modify/delete + before 值" },
        { key: "version", label: "版本策略", aliases: ["版本", "semver", "version", "major"], hint: "旧→新;同 major 禁删禁改;改名=删+加" },
        { key: "consumer", label: "消费者", aliases: ["消费者", "consumer", "消费方", "调用方"], hint: "全量具体名,禁「待排查」" },
        { key: "deprecate", label: "弃用窗口", aliases: ["弃用", "deprecat", "sunset", "下线"], hint: "机器可读日期,如「弃用至 2026-12-31」" },
        { key: "migrate", label: "迁移路径", aliases: ["迁移", "migrate", "升级", "兼容"], hint: "每条 breaking ≥1 条消费方迁移" },
        { key: "test", label: "契约测试", aliases: ["契约测试", "contract test", "新旧共存", "对拍"], hint: "Tolerant Reader/新旧共存" },
      ],
    },
    deploy: {
      label: "部署/打包", short: "DEPLOY", icon: "▣", color: "var(--bcv-lane-1, #c9a25e)", colorHex: "#c9a25e",
      rule: "环境拓扑+产物版本;preflight 每项判据;有序步骤+发布策略;smoke P0 负面断言;回滚阈值",
      edgeHint: "data=拓扑/产物;verify=preflight/smoke;失败→回滚",
      stages: [
        { key: "topology", label: "环境拓扑", aliases: ["拓扑", "环境", "artifact", "产物"], hint: "节点↔artifact+版本号" },
        { key: "preflight", label: "preflight", aliases: ["preflight", "预检", "环境预检"], hint: "每项带可判 pass/fail 的通过判据" },
        { key: "steps", label: "发布步骤", aliases: ["步骤", "发布", "部署", "滚动", "蓝绿", "canary"], hint: "有序编号;rolling/蓝绿/canary+观察窗" },
        { key: "smoke", label: "冒烟", aliases: ["smoke", "冒烟", "用户旅程"], hint: "P0 旅程:启动→配置→真实任务→≥1 负面断言" },
        { key: "rollback", label: "回滚", aliases: ["回滚", "rollback", "降级", "revert"], hint: "触发条件/阈值 + 回滚验证" },
      ],
    },
    research: {
      label: "调研/选型", short: "RESEARCH", icon: "◫", color: "var(--bcv-lane-5, #c99bff)", colorHex: "#c99bff",
      rule: "候选≥2 × 维度(成本/风险/可维护性);每格证据/未知;权重可复算;结论+每个被拒候选的放弃理由",
      edgeHint: "data=候选×维度→矩阵→结论;证据来源写格内",
      stages: [
        { key: "candidate", label: "候选", aliases: ["候选", "candidate", "方案"], hint: "≥2;单候选=伪选型" },
        { key: "matrix", label: "矩阵", aliases: ["矩阵", "matrix", "维度", "评估"], hint: "候选×维度双向成边;权重可见" },
        { key: "evidence", label: "证据", aliases: ["证据", "evidence", "来源", "实测"], hint: "每格证据来源+可信度;无证据标未知" },
        { key: "verdict", label: "结论", aliases: ["结论", "推荐", "verdict", "放弃"], hint: "推荐+理由;每个被拒候选至少一条放弃理由" },
      ],
    },
    orchestration: {
      label: "编排/Agent", short: "ORCH", icon: "⌬", color: "var(--bcv-lane-6, #6fd6d6)", colorHex: "#6fd6d6",
      rule: "agent 拓扑(职责/输入/输出/工具面);派发条件;timeout/retry/补偿;fan-out 必 fan-in;大载荷走共享存储",
      edgeHint: "call=派发/调用 · data=结果/共享存储引用;失败/超时/回收边必须显式",
      stages: [
        { key: "topology", label: "编排拓扑", aliases: ["拓扑", "编排", "topology", "为何编排"], hint: "为何需要编排(单链能解决不上多 agent)" },
        { key: "dispatch", label: "派发", aliases: ["派发", "dispatch", "spawn", "fan-out"], hint: "触发条件+传参;跨仓标桥接点" },
        { key: "worker", label: "执行", aliases: ["执行", "worker", "子代理", "agent"], hint: "职责/输入 schema/输出 schema/工具面四字段" },
        { key: "failure", label: "失败/重试", aliases: ["失败", "超时", "timeout", "重试", "retry", "补偿", "降级"], hint: "timeout 预算收缩;jitter+cap;非幂等不重试" },
        { key: "collect", label: "回收", aliases: ["回收", "fan-in", "聚合", "aggregate", "终态"], hint: "每个并行分支终态→聚合;无回收=fire-and-forget" },
      ],
    },
    composition: {
      label: "作业思路", short: "COMPOSE", icon: "✎", color: "var(--bcv-lane-2, #6fa8ff)", colorHex: "#6fa8ff",
      rule: "六问齐全:主题/受众/表达结构/章节(≥2,每章一句主张)/章间关系(承接·递进·并列·对照·因果);不画执行步骤、不写 targets/symbolRef/before",
      edgeHint: "data=章间推进,label 写关系词(承接/递进/并列/对照/因果);无 verify/call",
      stages: [
        { key: "theme", label: "主题", aliases: ["主题", "题目", "立意", "主题句", "theme"], hint: "一句话主题断言(不是话题名),一个就够" },
        { key: "audience", label: "受众", aliases: ["受众", "读者", "面向", "写给", "audience"], hint: "写给谁/关心什么/已知什么(决定详略与术语)" },
        { key: "structure", label: "结构", aliases: ["结构", "表达结构", "框架", "结构式", "structure"], hint: "总-分-总/问题-分析-结论/现状-方案-收益/时间线/对照" },
        { key: "chapter", label: "章节", aliases: ["章", "章节", "部分", "chapter"], hint: "≥2 章;label 带序号,summary=本章一句主张" },
        { key: "relation", label: "章间关系", aliases: ["承接", "递进", "并列", "对照", "因果", "关系", "顺序", "relation"], hint: "相邻章 data 边 label 必须是五词之一" },
      ],
    },
  };

  // code flow(有 start/end 的代码板)用流程阶段,不再套变更契约的「现状层/变更层」:
  // 工程师读的是 start→步骤→decision 是/否→end,方法/阶段由 group 表达。
  var CODE_FLOW_PROFILE = {
    label: "代码流程", short: "CODEFLOW", icon: "⌘", color: "var(--bcv-lane-3, #7fd6a5)", colorHex: "#7fd6a5",
    rule: "一条主线 start→步骤→decision→end;group=方法/阶段;步骤 flow 写代码级动作;decision 出边是/否",
    edgeHint: "data=事件/数据流 · verify=入口→出口验收 · 正交连线由面板生成",
    stages: [
      { key: "start", label: "触发", aliases: ["触发", "入口", "start"], hint: "触发事件/入口" },
      { key: "step", label: "步骤", aliases: ["步骤", "step"], hint: "代码级动作,flow 2~4 行" },
      { key: "decision", label: "判断", aliases: ["判断", "decision", "分支", "校验"], hint: "cond + 是/否出口" },
      { key: "end", label: "终点", aliases: ["终点", "结果", "end", "完成"], hint: "主出口/分支出口" },
      { key: "impact", label: "影响面", aliases: ["影响", "上游", "下游", "关联测试", "风险", "tests"], hint: "上游 caller / 下游依赖 / 关联测试" },
      { key: "verify", label: "验收", aliases: ["验收", "回归", "accept", "验证"], hint: "command/browser/manual/negative,每条带 expect" },
    ],
    kindMap: { start: "start", end: "end", decision: "decision", function: "step", module: "step", io: "step", tool: "step", http: "step" },
  };
  function arr(x) { return Array.isArray(x) ? x : []; }
  function txt(x) { return String(x == null ? "" : x); }
 // test flow( 测试类型接入 code flow):主线=测试执行流,被测链路逐函数展开,
  // 断言 decision 是/否,失败定位+回归锚收尾。阶段对齐 test/draw 技能,防六段画像误报缺段。
  var TEST_FLOW_PROFILE = {
    label: "测试流程", short: "TESTFLOW", icon: "✓", color: "var(--bcv-lane-6, #6fd6d6)", colorHex: "#6fd6d6",
    rule: "主线=测试执行流,被测链路逐函数展开(每卡一个函数+真实代码行);断言 decision 是/否;失败定位+回归锚收尾;不用例卡层",
    edgeHint: "call/data=被测链路数据流 · verify=绿→复跑回归锚 · 正交连线由面板生成",
    stages: [
      { key: "fixture", label: "夹具/触发", aliases: ["夹具", "准备", "运行", "触发", "fixture"], hint: "start+setup:正常输入怎么造" },
      { key: "code", label: "被测段", aliases: ["被测"], hint: "被测链路逐函数展开,每卡一个函数+真实代码行" },
      { key: "fail", label: "失败定位", aliases: ["失败定位", "红灯", "定位"], hint: "否分支出口:排查序" },
      { key: "judge", label: "判定", aliases: ["判定", "断言", "通过", "expect"], hint: "断言 decision,cond=expect 原文,是/否双出口" },
      { key: "reg", label: "回归", aliases: ["回归"], hint: "回归锚:既有测试文件与可执行命令" },
    ],
    kindMap: { start: "fixture", end: "judge", decision: "judge", function: "code", io: "code", tool: "code", http: "code", note: "reg" },
  };
 // perf flow( 性能优化板接入 code flow):——
  // 有 start/end/decision/带 flow 的步骤时,perf 板与 code 板同形态渲染(药丸/菱形/代码框/正交线),
  // 阶段随之换成工程流程:触发→采样基线→定位瓶颈→改动→复测→判定,不再套「基线/瓶颈/改动/目标/门禁」契约画像
  // (否则布局是流程图、顶部却误报缺段)。旧的纯模块卡 perf 板(无流程语义)仍走 PROFILES.perf,逐字不变。
  var PERF_FLOW_PROFILE = {
    label: "性能优化流程", short: "PERFFLOW", icon: "⚡", color: "var(--bcv-lane-1, #e0b46a)", colorHex: "#e0b46a",
    rule: "一条主线 触发→采样基线→定位瓶颈→改动→复测→判定(end);group=模块/方法;步骤 flow 写代码级动作;decision 出边是/否(达标收工 / 回退复测);数字带单位+百分位且同口径",
    edgeHint: "data=事件/数据流 · verify=改动→复测指标(同环境同负载) · 正交连线由面板生成",
    stages: [
      { key: "start", label: "触发", aliases: ["触发", "入口", "start", "请求"], hint: "触发事件/入口:哪条链路慢" },
      { key: "baseline", label: "采样基线", aliases: ["采样", "基线", "baseline", "profile", "bench", "火焰图", "当前指标"], hint: "基线数据:bench/profile 数字+单位+百分位,硬件与负载口径" },
      { key: "bottleneck", label: "定位瓶颈", aliases: ["定位", "瓶颈", "热点", "bottleneck", "hotspot", "慢查询"], hint: "热点函数+耗时占比+证据(火焰图/trace)" },
      { key: "change", label: "改动", aliases: ["改动", "改造", "优化", "change", "opt"], hint: "代码级改动:改哪里的什么,flow 2~4 行" },
      { key: "retest", label: "复测", aliases: ["复测", "重测", "retest", "rebench", "回归"], hint: "同口径复测数字,与基线逐项对比" },
      { key: "verdict", label: "判定", aliases: ["判定", "终点", "结论", "verdict", "验收", "达标", "回滚"], hint: "终点:是否达标(是=收工固化门禁 / 否=回退复测)" },
    ],
    kindMap: { start: "start", end: "verdict", decision: "verdict", function: "change", module: "change", io: "change", tool: "change", http: "change", note: "verdict" },
  };
  function profileOf(doc) {
    var t = txt(doc && doc.boardType);
 // 与 panel.ts 的 cvCodeFlowWanted 同口径(两处必须一起改):code 板只要
    // ①有 start/end ②有 decision ③步骤节点 ≥50% 带 flow 行,就切 CODE_FLOW_PROFILE;
    // 否则「布局进了 flow 形态、画像还是现状层/变更层」→ 顶部误报缺段。
    if (t === "code" && codeFlowWanted(doc)) return CODE_FLOW_PROFILE;
 // perf 与 code 同口径(panel.ts 的 cvCodeInfo/wantPerfFlow 必须一起改):
    // perf 板有流程语义 → PERFFLOW_PROFILE(触发/采样基线/定位瓶颈/改动/复测/判定);
    // 无 start/end/decision/带 flow 步骤的旧 perf 板 → 仍 PROFILES.perf(基线→瓶颈→改动→目标→门禁)。
    if (t === "perf" && codeFlowWanted(doc)) return PERF_FLOW_PROFILE;
    if (t === "test" && arr(doc && doc.nodes).some(function (n) { return n && (n.kind === "start" || n.kind === "end"); })) return TEST_FLOW_PROFILE;
    return PROFILES[t] || null;
  }
  // 同一口径同时服务 code 与 perf(perf 复用本函数判定「是否进流程形态」),改口径必须连带改 panel.ts 同名函数。
  function codeFlowWanted(doc) {
    var ns = arr(doc && doc.nodes).filter(function (n) { return !!n; });
    if (!ns.length) return false;
    if (ns.some(function (n) { return n.kind === "start" || n.kind === "end"; })) return true;
    if (ns.some(function (n) { return n.kind === "decision"; })) return true;
    var steps = ns.filter(function (n) { return n.kind !== "start" && n.kind !== "end" && n.kind !== "decision"; });
    if (!steps.length) return false;
    var withFlow = steps.filter(function (n) { return arr(n.flow).length > 0; }).length;
    return withFlow * 2 >= steps.length;
  }
  function allText(n) {
    return [n && n.group, n && n.label, n && n.summary, n && n.before, n && n.targets, n && n.accept, n && n.flow]
      .map(function (x) { return typeof x === "string" ? x : JSON.stringify(x || ""); }).join(" ");
  }
  function labelText(n) { return txt(n && n.group) + " " + txt(n && n.label); }
  function stageOf(n, p) {
    if (!n || !p) return null;
    var lab = labelText(n), all = allText(n);
    // code flow:kind 是流程语义的唯一真相(方法组名里常含「入口/判断」,不能把整组函数都算成触发);
    // note 仍按 label/group 侧栏词归影响/验收。
    if (p.short === "CODEFLOW") {
      var fk = txt(n.kind);
      if (fk === "start") return p.stages[0];
      if (fk === "end") return p.stages[3];
      if (fk === "decision") return p.stages[2];
      if (fk === "function" || fk === "module" || fk === "io" || fk === "tool" || fk === "http") return p.stages[1];
    }
    // perf flow:药丸/菱形按 kind 定死(触发 start / 判定 end+decision / 步骤 function|module|io|tool|http);
    // 步骤再按 label+group 强特征分流到「采样基线 / 定位瓶颈 / 复测」(这三段是 perf 与 code 的唯一差别),
    // 都没命中就是「改动」。口径与 CODE_FLOW_PROFILE 的 kind 兜底同构。
    if (p.short === "PERFFLOW") {
      var pk = txt(n.kind);
      if (pk === "start") return p.stages[0];
      if (pk === "end" || pk === "decision" || pk === "note" || pk === "aggregate") return p.stages[5];
      var pkLab = String(n.label || "") + " " + String(n.group || "");
      if (/(定位|瓶颈|热点|hotspot|bottleneck|慢查询|trace)/i.test(pkLab)) return p.stages[2];
      if (/(采样|基线|baseline|bench|profile|火焰图|当前指标)/i.test(pkLab)) return p.stages[1];
      if (/(复测|重测|retest|rebench|回归|对比基线)/i.test(pkLab)) return p.stages[4];
      if (pk === "function" || pk === "module" || pk === "io" || pk === "tool" || pk === "http") return p.stages[3];
    }
    // 阶段名有歧义的两类先按 label 强特征定向:矩阵节点 label 里也含「候选」,文档所有章节 group 都含「章节」。
    if (p.short === "RESEARCH") {
      if (/(矩阵|维度|matrix)/i.test(lab)) return p.stages[1];
      if (/(结论|推荐|放弃|verdict)/i.test(lab)) return p.stages[3];
      if (/(证据|来源|实测)/i.test(lab)) return p.stages[2];
      if (/^(候选|candidate)|候选方案/i.test(String(n.label || ""))) return p.stages[0];
    }
    if (p.short === "DOCS") {
      // 两层结构优先按 kind 定层:page=页,section=章;再按 label 词归证据/行动/结论
      var dk = txt(n.kind);
      if (dk === "page") return p.stages[2];
      if (dk === "section") return p.stages[1];
      if (/(结论|推荐|verdict)/i.test(lab)) return p.stages[0];
      if (/(证据|论证|案例|对比)/i.test(lab)) return p.stages[3];
      if (/(行动|下一步|建议|落地)/i.test(lab)) return p.stages[4];
      if (/(章节|问题|背景|挑战|问答)/i.test(lab)) return p.stages[1];
    }
    if (p.short === "COMPOSE") {
      // 作业思路板:kind 定「章节」,summary/label 词定受众/主题,其余走 aliases(结构/关系)。
      var ck = txt(n.kind);
      if (ck === "section") return p.stages[3];
      var cAll = String(n.label || "") + " " + String(n.summary || "") + " " + String(n.group || "");
      if (/(受众|读者|面向|写给)/.test(cAll)) return p.stages[1];
      if (/(主题|立意|题目)/.test(cAll)) return p.stages[0];
    }
    if (p.short === "DEPLOY") {
      var dt = String(n.label || "") + " " + String(n.summary || "");
      if (/(预检|preflight)/i.test(dt)) return p.stages[1];
      if (/(smoke|冒烟|用户旅程)/i.test(dt)) return p.stages[3];
      if (/(回滚|rollback|降级|revert)/i.test(dt)) return p.stages[4];
      if (/(步骤|发布|部署|滚动|蓝绿|canary|打包|构建|验收门|放量)/i.test(dt)) return p.stages[2];
      if (/(拓扑|环境|artifact|产物)/i.test(dt)) return p.stages[0];
    }
    if (p.short === "PERF") {
      var pl = String(n.label || ""), pg = String(n.group || "");
      if (/(门禁|CI|gate|验收门|预算|监控)/i.test(pl)) return p.stages[4];
      if (/(目标|阈值|target|验收)/i.test(pl)) return p.stages[3];
      if (/(改动|改造|优化|change|修复)/i.test(pl) || /(改造|优化|改动)/i.test(pg)) return p.stages[2];
      if (/(基线|baseline|基准)/i.test(pl) || /(基线|baseline|基准)/i.test(pg)) return p.stages[0];
      if (/(瓶颈|profiling|热点|火焰图|慢查询|USE)/i.test(pl + " " + pg)) return p.stages[1];
    }
    var labOnly = String(n.label || "");
    // 先按 label 强特征判阶段(「环境预检」不能被 group「拓扑」吃掉),再按 group+label,再 kind,最后 summary。
    for (var i0 = 0; i0 < p.stages.length; i0++) {
      var st0 = p.stages[i0];
      for (var a0 = 0; a0 < (st0.aliases || []).length; a0++) {
        if (labOnly.indexOf(st0.aliases[a0]) >= 0) return st0;
      }
    }
    for (var i = 0; i < p.stages.length; i++) {
      var st = p.stages[i];
      for (var a = 0; a < (st.aliases || []).length; a++) {
        if (lab.indexOf(st.aliases[a]) >= 0) return st;
      }
    }
    var kind = txt(n.kind);
    var kindMap = p.kindMap || {};
    if (kindMap[kind]) {
      for (var j = 0; j < p.stages.length; j++) if (p.stages[j].key === kindMap[kind]) return p.stages[j];
    }
    for (var k = 0; k < p.stages.length; k++) {
      var st2 = p.stages[k];
      for (var b = 0; b < (st2.aliases || []).length; b++) if (all.indexOf(st2.aliases[b]) >= 0) return st2;
    }
    return null;
  }
  // 各板型 kind 兜底(仅在没有 group/label 关键词时用)
  PROFILES.test.kindMap = { decision: "decision", function: "logic", module: "logic", note: "assert", verify: "assert" };
  PROFILES.code.kindMap = { decision: "change", function: "change", module: "change", io: "current", tool: "current", http: "current" };
  PROFILES.fault.kindMap = { decision: "hypothesis", note: "observe" };
  PROFILES.refactor.kindMap = { decision: "expand", note: "migrate" };
  PROFILES.perf.kindMap = { decision: "gate", note: "change" };
  PROFILES.data.kindMap = { io: "input", tool: "clean", decision: "quality" };
  PROFILES.contract.kindMap = { decision: "deprecate", note: "field" };
  PROFILES.deploy.kindMap = { decision: "rollback", note: "steps" };
  PROFILES.research.kindMap = { decision: "verdict", note: "evidence" };
  PROFILES.orchestration.kindMap = { agent: "worker", decision: "dispatch", note: "failure" };
  PROFILES.docs.kindMap = { decision: "verdict" };
  PROFILES.composition.kindMap = { section: "chapter", note: "theme", decision: "structure", module: "chapter", function: "chapter" };

  function countBranches(flow) {
    var n = 0;
    (function walk(list) {
      arr(list).forEach(function (st) {
        if (!st) return;
        if (st.type === "branch") n++;
        if (arr(st.then).length) walk(st.then);
        if (arr(st.else).length) walk(st.else);
        if (arr(st.body).length) walk(st.body);
      });
    })(flow);
    return n;
  }
  function flowLines(n, max) {
    var out = [];
    var limit = max || 3;
    function one(st) {
      if (!st || out.length >= limit) return;
      if (st.type === "branch") {
        var thenT = arr(st.then).map(function (x) { return txt(x && x.text); }).filter(Boolean).join(";");
        var elseT = arr(st.else).map(function (x) { return txt(x && x.text); }).filter(Boolean).join(";");
        out.push("if " + (txt(st.cond) || "?") + " → " + (thenT || "then") + (elseT ? " / else " + elseT : ""));
        return;
      }
      if (st.type === "loop") {
        out.push("↻ " + (txt(st.over) || "loop") + (st.text ? " · " + txt(st.text) : ""));
        return;
      }
      if (st.text) out.push(txt(st.text));
    }
    arr(n && n.flow).forEach(function (st) {
      if (out.length >= limit) return;
      one(st);
      if (st && arr(st.then).length) arr(st.then).forEach(one);
      if (st && arr(st.else).length) arr(st.else).forEach(one);
    });
    return out.slice(0, limit);
  }
  function badgesOf(n, p, doc, edges) {
    if (!n || !p) return [];
    var out = [];
    function add(text, tone, title) {
      if (!text || out.length >= 6) return;
      out.push({ text: text, tone: tone || "info", title: title || text });
    }
    var all = allText(n), lab = labelText(n);
    if (n.before) add("改前", "before", n.before);
    if (arr(n.targets).length) add("目标 " + arr(n.targets).length, "target", arr(n.targets).join("\n"));
    if (arr(n.evidence).length) add("据 " + arr(n.evidence).length, "ok", "验收证据 " + arr(n.evidence).length + " 条");
    var br = countBranches(n.flow);
    if (br) add("分支 " + br, "branch", br + " 个 if/else 分支");
    var st = stageOf(n, p);
    var bs = txt(doc && doc.boardType);
    if (bs === "code") {
      var ins = 0, outs = 0, tests = 0;
      arr(edges).forEach(function (e) {
        var ek = txt(e.kind || "call");
        if (ek === "call" || ek === "data") {
          if (e.to === n.id) ins++;
          if (e.from === n.id) outs++;
        }
        if ((e.to === n.id || e.from === n.id) && /测试|test|spec/.test(txt(e.label) + " " + txt(n.label))) tests++;
      });
      if (ins) add("上游 " + ins, "info", "入边/上游 caller " + ins);
      if (outs) add("下游 " + outs, "info", "出边/下游 callee " + outs);
      if (tests) add("测试 " + tests, "ok", "关联测试边 " + tests);
    } else if (bs === "test") {
      if (n.kind === "decision") add("判定", "warn", "decision 分支");
      if (/(断言|期望|expect|assert)/i.test(all)) add("断言", "ok", "可判定期望");
      if (/(正常|valid)/i.test(all)) add("正常", "ok");
      if (/(边界|boundary|空板|edge)/i.test(all)) add("边界", "warn");
      if (/(异常|exception|错误|缺状态)/i.test(all)) add("异常", "bad");
    } else if (bs === "docs") {
      if (/(教程|tutorial)/i.test(all)) add("教程", "info", "Diátaxis: tutorial");
      else if (/(操作|how.?to|步骤)/i.test(all)) add("操作", "info", "Diátaxis: how-to");
      else if (/(参考|reference|API)/i.test(all)) add("参考", "info", "Diátaxis: reference");
      else if (/(解释|explanation|原理|为什么)/i.test(all)) add("解释", "info", "Diátaxis: explanation");
    } else if (bs === "composition") {
      // 作业思路板:章节节点出「关系词」chip(看它下游 data 边),缺关系词的边给 warn。
      var REL = ["承接", "递进", "并列", "对照", "因果"];
      var relSeen = [], relMissing = 0;
      if (n.kind === "section") {
        arr(edges).forEach(function (e) {
          if (e.from !== n.id) return;
          var el = txt(e.label), hit = null;
          for (var ri = 0; ri < REL.length; ri++) if (el.indexOf(REL[ri]) >= 0) { hit = REL[ri]; break; }
          if (hit) { if (relSeen.indexOf(hit) < 0) relSeen.push(hit); }
          else relMissing++;
        });
      }
      relSeen.slice(0, 3).forEach(function (r) { add(r, "info", "章间关系:" + r); });
      if (relMissing) add("缺关系词 " + relMissing, "warn", relMissing + " 条章节边未写承接/递进/并列/对照/因果");
      if (/(受众|读者|面向|写给)/.test(all)) add("受众", "ok", "受众信息已写");
      if (/(结构|总-分-总|总分总|问题-分析-结论|现状-方案-收益|时间线)/.test(all)) add("结构", "info", "表达结构");
    } else if (bs === "fault") {
      if (/(排除|已排除|排除依据)/.test(all)) add("排除", "warn", "被排除假设及依据");
      if (/(假设|hypothesis)/.test(all)) add("假设", "info");
      if (arr(n.evidence).length || /(日志|log|trace|指标|火焰图|profiling)/i.test(all)) add("证据", "ok");
    } else if (bs === "refactor") {
      if (/(1\s*[:：]\s*1|N\s*[:：]\s*1|1\s*[:：]\s*N)/i.test(all)) add("映射", "ok", "1:1/N:1/1:N 映射");
      if (/(兼容|compat)/i.test(all)) add("兼容", "warn", "兼容窗口");
      if (/(回滚|rollback|revert)/i.test(all)) add("回滚", "bad", "回滚点/触发条件");
      if (/(展开|expand)/i.test(all)) add("展开", "info");
      if (/(迁移|migrate)/i.test(all)) add("迁移", "info");
      if (/(收口|contract|删旧|零读取)/i.test(all)) add("收口", "ok");
    } else if (bs === "perf") {
      var mm = all.match(/(基线|目标|阈值|P\d{2})[^0-9]{0,14}(\d+(?:\.\d+)?\s*(?:ms|毫秒|s|秒|%|MB|GB|QPS|条|个))/gi) || [];
      mm.slice(0, 2).forEach(function (s) { add(s.replace(/\s+/g, " ").slice(0, 12), "metric", s); });
      if (/(profiling|火焰图|热点|慢查询|USE)/i.test(all)) add("瓶颈证据", "ok");
    } else if (bs === "data") {
      if (/(dry.?run|干跑)/i.test(all)) add("dry-run", "ok");
      if (/(幂等|idempot)/i.test(all)) add("幂等", "ok", "分区 overwrite / delete-insert / upsert");
      if (/(unique|not_null|非空|唯一|引用完整性|新鲜度)/i.test(all)) add("质量断言", "ok");
      if (/(隔离|quarantine|DLQ|脏数据)/i.test(all)) add("隔离", "warn");
      if (/(回填|backfill|部分失败|重跑)/i.test(all)) add("回填", "info");
    } else if (bs === "contract") {
      if (/(字段|schema|field)/i.test(all)) add("字段", "info");
      if (/(semver|major|版本|version)/i.test(all)) add("版本", "info");
      var dm = all.match(/弃用至\s*(\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2})?)/);
      if (dm) add("弃用 " + dm[1], "warn", "弃用窗口");
      if (/(消费者|consumer|消费方)/i.test(all)) add("消费者", "ok");
      if (/(迁移|migrate|升级)/i.test(all)) add("迁移", "info");
    } else if (bs === "deploy") {
      if (/(preflight|预检)/i.test(all)) add("preflight", "warn");
      if (/(smoke|冒烟)/i.test(all)) add("smoke", "ok");
      if (/(rolling|蓝绿|canary|灰度)/i.test(all)) add("发布策略", "info");
      if (/(回滚|rollback|降级)/i.test(all)) add("回滚", "bad");
    } else if (bs === "research" || bs === "matrix") {
      if (/(矩阵|维度|matrix)/i.test(all)) add("矩阵", "info");
      if (/(权重|weight|\d+(?:\.\d+)?\s*%)/i.test(all)) add("权重", "warn");
      if (/(未知|unknown|待证)/i.test(all)) add("未知", "warn");
      if (/(证据|evidence|file:|行号)/i.test(all)) add("证据", "ok");
      if (/(推荐|放弃|结论)/i.test(all)) add("结论", "ok");
    } else if (bs === "orchestration") {
      if (n.kind === "agent" || /\bagent\b/i.test(all)) add("agent", "role");
      if (/(输入|输出|schema|IO)/i.test(all)) add("IO", "info");
      if (/(工具面|tools?|白名单)/i.test(all)) add("工具面", "info");
      if (/(超时|timeout|deadline)/i.test(all)) add("timeout", "warn");
      if (/(重试|retry|jitter|cap)/i.test(all)) add("retry", "warn");
      if (/(回收|fan-in|聚合|终态)/i.test(all)) add("回收", "ok");
    }
    // 阶段角色 chip 放最后:硬规则徽标优先占位,阶段不至于把「回收/timeout」挤出信息预算。
    if (st) add(st.label, "role", st.hint);
    return out;
  }
  function summaryOf(doc, info) {
    var p = profileOf(doc);
    if (!p) return null;
    var nodes = arr(doc && doc.nodes);
    var edges = arr(doc && doc.edges);
    var counts = {};
    p.stages.forEach(function (s) { counts[s.key] = 0; });
    nodes.forEach(function (n) {
      var st = stageOf(n, p);
      if (st) counts[st.key] = (counts[st.key] || 0) + 1;
    });
    var stages = p.stages.map(function (s) {
      return { key: s.key, label: s.label, hint: s.hint, count: counts[s.key] || 0, missing: !(counts[s.key] || 0) };
    });
    var missing = stages.filter(function (s) { return s.missing; }).map(function (s) { return s.label; });
    var branches = 0, flowNodes = 0, evidenceNodes = 0, p0 = 0, noBefore = 0, p0Bad = 0, p0Negative = 0;
    nodes.forEach(function (n) {
      var b = countBranches(n.flow);
      if (b) { branches += b; flowNodes++; }
      if (arr(n.evidence).length) evidenceNodes++;
      if (["modify", "delete"].indexOf(String(n.change || "")) >= 0 && !txt(n.before).trim()) noBefore++;
      if (n.phase === "P0") {
        p0++;
        var acc = arr(n.accept);
        if (!acc.length || acc.some(function (a) { return !/(command|browser|manual|negative)/.test(txt(a && a.type)) || !txt(a && a.expect).trim(); })) p0Bad++;
        if (acc.some(function (a) { return txt(a && a.type) === "negative"; })) p0Negative++;
      }
    });
    var verifyType = ["code","test","ui-func","fault","refactor","perf","data","contract","deploy","orchestration"].indexOf(txt(doc && doc.boardType)) >= 0;
    var unlabeled = edges.filter(function (e) { return (e.kind || "call") !== "contains" && !txt(e.label).trim(); }).length;
    return {
      boardType: txt(doc && doc.boardType),
      label: p.label, short: p.short, icon: p.icon, color: p.color,
      rule: p.rule, edgeHint: p.edgeHint,
      scale: txt(doc && doc.scale), scaleMissing: !txt(doc && doc.scale),
      nodes: nodes.length, edges: edges.length, stages: stages, missing: missing,
      branches: branches, flowNodes: flowNodes, evidenceNodes: evidenceNodes, p0: p0,
      noBefore: noBefore, p0Bad: p0Bad, p0Negative: p0Negative, verifyType: verifyType,
      unlabeledEdges: unlabeled,
      profile: p,
    };
  }

  // ---- composition(作业思路板)面板专用布局(2026-11):主题带 + 章节主列 + 属性卡区 ----
  // 「主题→章节顺序→章间关系」一眼可读:主题卡横贯章节主列宽度置顶成主题带;
  // 受众/结构/杂项收属性卡区(主题带右侧独立泳道,不占主列);章节按 label 序号排主列,
  // 无序号按章间 data 边拓扑序,再退声明序;孤立章节(无边无序号)不丢、殿后。
  // 产出与 BoardFlowLayout 同形(mode=flow):panel.ts 渲染层泳道框/编号/主线高亮/边标签零改动复用。
  // 纯函数零 IO 零随机幂等(全部 tie-breaker 退化到声明序)。
  var CP_MARGIN = 52, CP_NODE_W = 228, CP_NODE_H = 150, CP_THEME_H = 112, CP_ATTR_H = 100;
  var CP_COL_GAP = 56, CP_ROW_GAP = 26, CP_LANE_HEAD = 42, CP_LANE_PAD = 14, CP_LANE_TAIL = 12, CP_LANE_GAP = 46;
  var CP_CN = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "两": 2 };
  function cpCnNum(s) {
    if (s == null) return null;
    s = String(s);
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s === "十") return 10;
    var m = /^([一二三四五六七八九两]?)十([一二三四五六七八九两]?)$/.exec(s);
    if (m) return (m[1] ? CP_CN[m[1]] : 1) * 10 + (m[2] ? CP_CN[m[2]] : 0);
    return CP_CN[s] != null ? CP_CN[s] : null;
  }
  /** label 序号:「第X章/X章」/「01 xxx」/「1.」/「一、」等中英形态;识别不出返回 null。 */
  function cpOrdOf(label) {
    var s = String(label == null ? "" : label).trim();
    if (!s) return null;
    var m = /(?:^|[^0-9])第\s*(\d+|[一二三四五六七八九十两]{1,3})\s*(?:章|节|篇|部)/.exec(s)
      || /^\s*(\d+)\s*(?:[.、)]|\s|$)/.exec(s)
      || /^\s*([一二三四五六七八九十两]{1,3})\s*(?:章|节|篇|部|[、.])/.exec(s);
    if (!m) return null;
    var v = cpCnNum(m[1]);
    return v != null && isFinite(v) ? v : null;
  }
  function composeLayout(doc) {
    var nodes = arr(doc && doc.nodes), edges = arr(doc && doc.edges);
    var themes = [], attrs = [], chapters = [], byId = {}, declared = {};
    nodes.forEach(function (n, i) {
      if (!n || !n.id) return;
      byId[n.id] = n; declared[n.id] = i;
      var all = txt(n.label) + " " + txt(n.summary) + " " + txt(n.group);
      if (txt(n.kind) === "section") { chapters.push(n); return; }
      // 识别优先级与 stageOf COMPOSE 分支一致:section→章,受众/结构词→属性,主题词/note→主题,杂项→属性。
      if (/(受众|读者|面向|写给)/.test(all)) { attrs.push(n); return; }
      if (/(结构|总-分-总|问题-分析-结论|现状-方案-收益|时间线|对照)/.test(all)) { attrs.push(n); return; }
      if (/(主题|立意|题目)/.test(all) || txt(n.kind) === "note") { themes.push(n); return; }
      attrs.push(n); // 杂项节点也收属性卡区(不占章节主列)
    });
    // 章间推进边(章节↔章节的 data 边):主线高亮集合 + 无序号章节的拓扑依据
    var dataEdges = edges.filter(function (e) {
      return e && e.from && e.to && (e.kind || "call") === "data" && declared[e.from] != null && declared[e.to] != null;
    });
    // 章节排序:①label 序号升序(tie=声明序) ②无序号→章间 data 边拓扑序(Kahn,同级按入队序)
    // ③环/不可达残留按声明序补齐(不丢节点) ④孤立章节(无边无序号)按声明序殿后。
    var ordOf = {}; chapters.forEach(function (n) { ordOf[n.id] = cpOrdOf(n.label); });
    var withOrd = chapters.filter(function (n) { return ordOf[n.id] != null; })
      .sort(function (a, b) { return (ordOf[a.id] - ordOf[b.id]) || (declared[a.id] - declared[b.id]); });
    var noOrd = chapters.filter(function (n) { return ordOf[n.id] == null; });
    var deg = {}, adj = {};
    noOrd.forEach(function (n) { deg[n.id] = 0; adj[n.id] = []; });
    dataEdges.forEach(function (e) {
      if (deg[e.from] == null || deg[e.to] == null) return;
      adj[e.from].push(e.to); deg[e.to]++;
    });
    var linked = noOrd.filter(function (n) { return deg[n.id] > 0 || adj[n.id].length > 0; });
    var isolatedIds = noOrd.filter(function (n) { return deg[n.id] === 0 && !adj[n.id].length; })
      .map(function (n) { return n.id; }); // 声明序(filter 保序)
    var rest = deg, queue = linked.filter(function (n) { return rest[n.id] === 0; }).map(function (n) { return n.id; });
    var topo = [], seen = {}, qi = 0;
    while (qi < queue.length) {
      var id = queue[qi++];
      if (seen[id]) continue;
      seen[id] = true; topo.push(id);
      (adj[id] || []).forEach(function (t) { if (--rest[t] === 0) queue.push(t); });
    }
    linked.forEach(function (n) { if (!seen[n.id]) topo.push(n.id); }); // 环/不可达:声明序补齐
    var order = withOrd.map(function (n) { return n.id; }).concat(topo).concat(isolatedIds);

    // ---- 摆位(全部确定性) ----
    var pos = new Map(), size = new Map(), no = new Map(), laneOf = new Map(), lanes = [];
    var nCh = order.length;
    var chRowW = nCh > 1 ? nCh * CP_NODE_W + (nCh - 1) * CP_COL_GAP : CP_NODE_W;
    var themeY = CP_MARGIN;
    var chY = themeY + CP_THEME_H + CP_LANE_GAP + CP_LANE_HEAD;
    var bodyW = Math.max(chRowW + CP_LANE_PAD * 2, CP_NODE_W); // 主题带/章节列共用主列宽
    var laneNo = 0;
    if (themes.length) {
      // 主题带:横贯章节主列宽度的强调位(单主题=整条横幅,多主题均分),与主列同宽。
      var themeLaneW = bodyW;
      var tW = themes.length === 1
        ? themeLaneW - CP_LANE_PAD * 2
        : (themeLaneW - CP_LANE_PAD * 2 - (themes.length - 1) * CP_ROW_GAP) / themes.length;
      themes.forEach(function (n, i) {
        pos.set(n.id, { x: CP_MARGIN + CP_LANE_PAD + i * (tW + CP_ROW_GAP), y: themeY + CP_LANE_HEAD });
        size.set(n.id, { w: Math.round(tW), h: CP_THEME_H });
        laneOf.set(n.id, "theme");
      });
      laneNo++;
      lanes.push({ key: "theme", label: "主题", no: (laneNo < 10 ? "0" : "") + laneNo, x: CP_MARGIN, y: themeY, w: themeLaneW, h: CP_LANE_HEAD + CP_THEME_H + CP_LANE_TAIL, nodes: themes.map(function (n) { return n.id; }) });
    }
    if (nCh) {
      order.forEach(function (cid, i) {
        pos.set(cid, { x: CP_MARGIN + CP_LANE_PAD + i * (CP_NODE_W + CP_COL_GAP), y: chY });
        size.set(cid, { w: CP_NODE_W, h: CP_NODE_H });
        laneOf.set(cid, "chapters");
      });
      laneNo++;
      lanes.push({ key: "chapters", label: "章节主线", no: (laneNo < 10 ? "0" : "") + laneNo, x: CP_MARGIN, y: chY - CP_LANE_HEAD, w: bodyW, h: CP_LANE_HEAD + CP_NODE_H + CP_LANE_TAIL, nodes: order.slice() });
    }
    var maxX = CP_MARGIN + bodyW, maxY = chY - CP_LANE_HEAD + (nCh ? CP_LANE_HEAD + CP_NODE_H + CP_LANE_TAIL : 0);
    if (attrs.length) {
      // 属性卡区:主题带右侧(与主题带顶对齐),受纵向排;不占章节主列。
      var attrX = CP_MARGIN + bodyW + CP_LANE_GAP;
      attrs.forEach(function (n, i) {
        pos.set(n.id, { x: attrX + CP_LANE_PAD, y: themeY + CP_LANE_HEAD + i * (CP_ATTR_H + CP_ROW_GAP) });
        size.set(n.id, { w: CP_NODE_W, h: CP_ATTR_H });
        laneOf.set(n.id, "attrs");
      });
      var attrLaneW = CP_NODE_W + CP_LANE_PAD * 2;
      var attrLaneH = CP_LANE_HEAD + attrs.length * CP_ATTR_H + (attrs.length - 1) * CP_ROW_GAP + CP_LANE_TAIL;
      laneNo++;
      lanes.push({ key: "attrs", label: "受众·结构(属性)", no: (laneNo < 10 ? "0" : "") + laneNo, x: attrX, y: themeY, w: attrLaneW, h: attrLaneH, nodes: attrs.map(function (n) { return n.id; }) });
      maxX = Math.max(maxX, attrX + attrLaneW);
      maxY = Math.max(maxY, themeY + attrLaneH);
    }
    // 节点编号 01..N:主题→章节→属性(泳道顺序;无主题板的主题段自然跳过)
    var seq = 0;
    themes.concat(order.map(function (cid) { return byId[cid]; })).concat(attrs).forEach(function (n) {
      seq++;
      no.set(n.id, (seq < 10 ? "0" : "") + seq);
    });
    var mainEdges = new Set();
    dataEdges.forEach(function (e) { mainEdges.add(e.from + ">" + e.to); });
    var mainNodes = new Set(order.concat(themes.map(function (n) { return n.id; })));
    return {
      mode: "flow", pos: pos, size: size, lanes: lanes, laneOf: laneOf, no: no,
      mainNodes: mainNodes, mainEdges: mainEdges, backEdges: new Set(),
      mainPath: order.slice(), entry: order.length ? order[0] : null, exit: order.length ? order[order.length - 1] : null,
      isolated: isolatedIds.slice(), orphanCount: isolatedIds.length,
      bounds: { x: CP_MARGIN, y: CP_MARGIN, w: maxX - CP_MARGIN, h: maxY - CP_MARGIN },
    };
  }
  return {
    PROFILES: PROFILES, profileOf: profileOf, stageOf: stageOf,
    flowLines: flowLines, badgesOf: badgesOf, summaryOf: summaryOf,
    countBranches: countBranches, composeLayout: composeLayout,
  };
});
