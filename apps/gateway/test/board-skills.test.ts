/** 板型分阶段技能 registry:13 类 + matrix,每类 collect/draw/audit 非空且含关键约束;
 * 索引/解析/全文读取纯函数零 IO。 */
import { describe, it, expect } from "vitest";
import {
  BOARD_SKILL_TYPES, BOARD_SKILL_STAGES, BOARD_TYPE_SKILLS,
  boardSkillBody, boardSkillIndex, boardSkillNames, parseBoardSkillName,
  DOC_GENRES, docGenreIndex,
} from "../src/board-skills.js";

describe("board-skills registry", () => {
  it("全部类型 × 三阶段都有非空正文", () => {
    for (const t of BOARD_SKILL_TYPES) {
      for (const s of BOARD_SKILL_STAGES) {
        const body = BOARD_TYPE_SKILLS[t].stages[s];
        expect(body.length, `${t}/${s}`).toBeGreaterThan(80);
        expect(body, `${t}/${s}`).toContain(t === "ui-func" ? "UI" : t);
      }
    }
    expect(boardSkillNames()).toHaveLength(BOARD_SKILL_TYPES.length * 3);
  });

  it("composition:三阶段可取,collect 含六问且禁代码字段,draw 教 section/关系词,audit 核对", () => {
    expect(BOARD_SKILL_TYPES).toContain("composition");
    const collect = boardSkillBody("composition", "collect")!;
    expect(collect).toBeTruthy();
    for (const q of ["主题是什么", "受众是谁", "表达结构是什么", "要几章", "每章主题是什么", "章与章之间是什么关系"]) {
      expect(collect, q).toContain(q);
    }
    expect(collect).toContain("不画执行步骤");
    expect(collect).toContain("targets/symbolRef/before");
    const draw = boardSkillBody("composition", "draw")!;
    expect(draw).toContain("node s1 section keep");
    expect(draw).toContain("edge s1 ->> s2");
    expect(draw).toContain("node t1 note keep");
    expect(draw).toContain("受众:");
    for (const rel of ["承接", "递进", "并列", "对照", "因果"]) expect(draw, rel).toContain(rel);
    const audit = boardSkillBody("composition", "audit")!;
    expect(audit).toContain("受众");
    expect(audit).toContain("章节 ≥2");
    expect(audit).toContain("关系词");
    expect(parseBoardSkillName("composition/draw")).toEqual({ type: "composition", stage: "draw" });
  });

  it("code:collect 先查 code_sense/impact;draw 有 before/flow;audit 有 linked/孤儿", () => {
    const collect = boardSkillBody("code", "collect")!;
    expect(collect).toContain("code_sense");
    expect(collect).toContain("impact");
    expect(collect).toContain("symbolRef");
    expect(collect).toContain("C4");
    expect(collect).toContain("Person");
    expect(collect).toContain("[Component");
    expect(collect).toContain("方法/阶段");
    expect(collect).toContain("代码级动作");
    const draw = boardSkillBody("code", "draw")!;
    expect(draw).toContain("before");
    expect(draw).toContain("flow");
    expect(draw).toContain("现状");
    expect(draw).toContain("C4");
    expect(draw).toContain("dataflow");
    expect(draw).toContain("decision");
    expect(draw).toContain("start/end");
    expect(draw).toContain("主图只画");
    expect(draw).toContain("验收/风险/测试/回滚/根因/非锚点现状细节不进主图");
 // 示例图口径:一条主线/方法分组/代码框/正交连线/是-否出口
    expect(draw).toContain("一条主线");
    expect(draw).toContain("group=方法/阶段容器");
    expect(draw).toContain("代码级动作");
    expect(draw).toContain("代码框");
    expect(draw).toContain("正交连线");
    expect(draw).toContain("是：");
    expect(draw).toContain("否：");
    expect(draw).toContain("恰好一对");
    expect(draw).toContain("每条分支边都要有 label");
    expect(draw).toContain("侧栏");
    expect(draw).toContain("反模式");
    const audit = boardSkillBody("code", "audit")!;
    expect(audit).toContain("linked");
    expect(audit).toContain("孤儿");
    expect(audit).toContain("typeIssues");
    expect(audit).toContain("可读性");
    expect(audit).toContain("验收/风险分离");
    expect(audit).toContain("flow 可读性");
    expect(audit).toContain("代码级动作");
    expect(audit).toContain("主线是否一条前向链");
    expect(audit).toContain("恰好一对");
    expect(audit).toContain("不落侧栏 note");
  });

  it("code:口径三修(行号现取/逐分支穷举/start 只写触发)", () => {
    const collect = boardSkillBody("code", "collect")!;
    const draw = boardSkillBody("code", "draw")!;
    const audit = boardSkillBody("code", "audit")!;
    // ① 行号必须现取(draw 硬要求 + audit 抽查 3 条)
    expect(draw).toContain("flow 行号必须现取");
    expect(draw).toContain("写之前必须当场");
    expect(draw).toContain("grep -n '<该行代码片段>' <file>");
    expect(draw).toContain("禁止凭记忆或凭上一轮勘察的值");
    expect(draw).toContain("取不到就不写行号,只写函数名");
    expect(audit).toContain("行号抽查");
    expect(audit).toContain("抽查 3 条带行号的 flow 行");
    expect(audit).toContain("重画");
    expect(audit).toContain("行号漂移说明整段没核对过");
    // ② 逐分支穷举(collect 采集 early-return / draw 出口边 / draw 自检算式 / audit 反向核对)
    expect(collect).toContain("逐分支穷举");
    expect(collect).toContain("action=branches");
    expect(collect).toContain("early-return");
    expect(collect).toContain("if/else if/switch/while/for");
    expect(draw).toContain("每一条 early-return 必须在板上有一条");
    expect(draw).toContain("就永远不上板");
    expect(draw).toContain("主要");
    expect(draw).toContain("return");
    expect(draw).toContain("≤ 板上出口边数");
    expect(audit).toContain("分支反向核对");
    expect(audit).toContain("grep -c 'return ' ");
    expect(audit).toContain("板上出口边数比对");
    // ③ start 只写触发,函数体动作下沉
    expect(draw).toContain("start 只写触发");
    expect(draw).toContain("谁在什么条件下调用它");
    expect(draw).toContain("下沉");
    expect(draw).toContain("不要把这些塞进 start");
    expect(audit).toContain("start 只写触发(反向查)");
    expect(audit).toContain("动态 import");
  });

  it("code:板画现有逻辑(逻辑为主,改动降级为节点徽标)", () => {
    // collect:真实控制流靠 code_sense flow/branches 拉,不凭想象编步骤
    const collect = boardSkillBody("code", "collect")!;
    expect(collect).toContain("action=flow");
    expect(collect).toContain("action=branches");
    expect(collect).toContain("先查清现有链路再画");
    expect(collect).toContain("真实控制流");
    // draw:keep 默认 + 待办反模式
    const draw = boardSkillBody("code", "draw")!;
    expect(draw).toContain("change=keep");
    expect(draw).toContain("默认值");
    expect(draw).toContain("改动是节点上的徽标,不是节点");
    expect(draw).toContain("待办");
    expect(draw).toContain("flow 行不是真实函数调用形");
    // audit:现状真实性追问
    const audit = boardSkillBody("code", "audit")!;
    expect(audit).toContain("现状真实性");
    expect(audit).toContain("现在真的在仓库代码里存在吗");
    expect(audit).toContain("keep 节点占绝大多数且免 accept");
  });

  it("关键类型的专用约束不丢", () => {
 // 测试任务画纯 code flow,不画用例卡/六段两张皮
    const tDraw = boardSkillBody("test", "draw")!;
    expect(tDraw).toContain("纯 code flow");
    expect(tDraw).toContain("boardType=code");
    expect(tDraw).toContain("用例卡");
    expect(tDraw).toContain("expect 原文");
    expect(tDraw).toContain("是：");
 // 被测链路逐函数展开(被测链路得画详细)
    expect(tDraw).toContain("被测链路必须逐函数展开");
    expect(tDraw).toContain("一个");
    expect(boardSkillBody("test", "audit")!).toContain("无用例卡层");
    expect(boardSkillBody("test", "audit")!).toContain("被测链路展开度");
    expect(boardSkillBody("test", "collect")).toContain("边界");
    expect(boardSkillBody("test", "collect")).toContain("异常");
    expect(tDraw).toContain("decision");
    expect(boardSkillBody("ui", "draw")).toContain("跳转");
    expect(boardSkillBody("ui", "draw")).toContain("浮层");
    expect(boardSkillBody("ui", "draw")).toContain("五态");
    expect(boardSkillBody("ui-func", "draw")).toContain("两张皮");
    expect(boardSkillBody("fault", "draw")).toContain("根因");
    expect(boardSkillBody("fault", "draw")).toContain("排除");
    expect(boardSkillBody("refactor", "draw")).toContain("现状");
    expect(boardSkillBody("refactor", "draw")).toContain("目标");
    expect(boardSkillBody("perf", "draw")).toContain("百分位");
    expect(boardSkillBody("data", "draw")).toContain("幂等");
    expect(boardSkillBody("data", "draw")).toContain("dry-run");
    expect(boardSkillBody("contract", "draw")).toContain("semver");
    expect(boardSkillBody("contract", "draw")).toContain("弃用");
    expect(boardSkillBody("deploy", "draw")).toContain("preflight");
    expect(boardSkillBody("deploy", "draw")).toContain("smoke");
    expect(boardSkillBody("research", "draw")).toContain("权重");
    expect(boardSkillBody("research", "draw")).toContain("未知");
    expect(boardSkillBody("orchestration", "draw")).toContain("fan-in");
    expect(boardSkillBody("orchestration", "draw")).toContain("timeout");
    expect(boardSkillBody("matrix", "draw")).toContain("权重");
  });

  it("perf(2026-10-29 「性能优化的 flow 还差点意思」):三阶段都是控制流程图口径", () => {
    for (const s of ["collect", "draw", "audit"] as const) {
      const body = boardSkillBody("perf", s)!;
      expect(body, `perf/${s}`).toContain("start");
      expect(body, `perf/${s}`).toContain("decision");
      expect(body, `perf/${s}`).toContain("是：");
      expect(body, `perf/${s}`).toContain("否：");
      expect(body, `perf/${s}`).toContain("反模式");
      expect(body, `perf/${s}`).toContain("百分位");
    }
    const draw = boardSkillBody("perf", "draw")!;
    expect(draw).toContain("百分比");
    expect(draw).toContain("2~4 行代码级动作");
    expect(draw).toContain("恰好一对");
    expect(draw).toContain("否：未达标");
    expect(draw).toContain("否：未达标」**必须回到"); // 否支回改动/定位,不是悬空
    expect(draw).toContain("2~5 个节点");
    expect(draw).toContain("3 张并列模块卡");
    expect(draw).toContain("0 条边");
    expect(draw).toContain("没有 start/end");
    const audit = boardSkillBody("perf", "audit")!;
    expect(audit).toContain("必须重画成流程");
    expect(audit).toContain("出现即重画");
    expect(boardSkillBody("perf", "collect")!).toContain("3 张并列模块卡");
  });

  it("文档体裁库:体裁=必答维度集,方案评审必须含定位/架构/流程(通用机制,新体裁加条目即生效)", () => {
    const keys = Object.keys(DOC_GENRES);
    for (const k of ["review-solution", "review-code", "research", "summary", "guide", "generic"]) {
      expect(keys, k).toContain(k);
      expect(DOC_GENRES[k].dimensions.length, k).toBeGreaterThanOrEqual(3);
      for (const d of DOC_GENRES[k].dimensions) {
        expect(d.question.length, `${k}.${d.key}`).toBeGreaterThanOrEqual(6);
        expect(d.aliases.length, `${k}.${d.key}`).toBeGreaterThanOrEqual(2);
      }
    }
 // 方案评审的必答维度:这是干什么的/架构/流程 pipeline 必须在场
    const rs = DOC_GENRES["review-solution"].dimensions.map((d) => d.key);
    expect(rs).toContain("positioning");
    expect(rs).toContain("architecture");
    expect(rs).toContain("pipeline");
    expect(DOC_GENRES["review-solution"].dimensions.find((d) => d.key === "architecture")!.aliases).toContain("架构");
    expect(DOC_GENRES["review-solution"].dimensions.find((d) => d.key === "pipeline")!.aliases).toContain("pipeline");
    // 索引可注入 collect
    expect(docGenreIndex()).toContain("review-solution=方案/设计评审");
    expect(docGenreIndex()).toContain("架构");
    // docs/collect 携带判体裁+对纲;draw 带 docGenre 落板指令
    expect(boardSkillBody("docs", "collect")).toContain("判体裁");
    expect(boardSkillBody("docs", "collect")).toContain("必答维度");
    expect(boardSkillBody("docs", "draw")).toContain("docGenre");
  });

  it("索引列出类型/触发词/三阶段；解析与非法输入", () => {
    const idx = boardSkillIndex();
    expect(idx).toContain('category="board"');
    expect(idx).toContain("code=代码开发");
    expect(idx).toContain("ui-func=UI+功能");
    expect(idx).toContain("matrix=决策矩阵");
    expect(idx).toContain("collect(收集必备信息)");
    expect(idx).toContain("draw(画法与结构)");
    expect(idx).toContain("audit(交板自检)");
    expect(parseBoardSkillName("code/collect")).toEqual({ type: "code", stage: "collect" });
    expect(parseBoardSkillName("ui-func:audit")).toEqual({ type: "ui-func", stage: "audit" });
    expect(parseBoardSkillName("nope/draw")).toBeNull();
    expect(parseBoardSkillName("code/nope")).toBeNull();
    expect(boardSkillBody("nope", "draw")).toBeNull();
    expect(boardSkillBody("code", "nope")).toBeNull();
  });
});
