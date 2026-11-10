/**
 * 虚拟组织协作开发流 e2e:temp 模式真跑一轮。
 * 全链路:seed 虚拟组织 → enrollRealMembers 真身份入册 → 4 名成员 relay 鉴权 → 派单 →
 * MR 提交 → 评审合入 → 评审意见 → 修订 → 经验回流 → 资产下线 → 角色变更 → 体检 →
 * 活动流可见性 → 周报聚合。真 git 仓 / 真 ed25519 签名验签 / 随机端口 relay / 真文件写入。
 * 断言纪律:每条 check 一例,ok=false 即失败(detail 里带现象与证据);不 skip、不 todo、不放宽。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { closeCollabScenario, runCollabScenario, type CollabContext, type CollabReport } from "./team-collab-scenario";

let ctx: CollabContext | undefined;
let report: CollabReport | undefined;
let failure: string | undefined;

beforeAll(async () => {
  try {
    const out = await runCollabScenario({ mode: "temp" });
    ctx = out.ctx;
    report = out.report;
  } catch (err) {
    failure = String((err as Error)?.message ?? err);
  }
}, 300_000);

afterAll(async () => {
  const root = ctx?.root;
  if (ctx) await closeCollabScenario(ctx);
  // 清理:临时根必须已删除(失败用例也不许在 os.tmpdir 留带 git 仓的目录)。
  if (root) expect(existsSync(root), `临时根未清理:${root}`).toBe(false);
}, 120_000);

/** 取某条 check;前置步骤崩了也给出可读原因,而不是 undefined。 */
function check(id: string) {
  if (failure) throw new Error(`场景初始化失败:${failure}`);
  const hit = report?.checks.find((c) => c.id === id);
  if (!hit) throw new Error(`缺 check「${id}」;已有:${(report?.checks ?? []).map((c) => c.id).join(", ")}`);
  return hit;
}

describe("虚拟组织协作开发流(temp 模式,真身份 + 真 relay + 真 git)", () => {
  it("1. setup:4 名演示成员以真 ed25519 身份通过 relay 鉴权,role/roleId 正确", () => {
    const c = check("setup");
    expect(c.ok, c.detail).toBe(true);
  });

  it("2. auth.negative:非 roster 身份连接被拒,code=not-on-roster", () => {
    const c = check("auth.negative");
    expect(c.ok, c.detail).toBe(true);
  });

  it("3. dispatch:owner 建 issue 并指派,4 名成员视角都 list 到,且推 task 活动", () => {
    const c = check("dispatch");
    expect(c.ok, c.detail).toBe(true);
  });

  it("4. dev.submit:skill/rule/doc 三条资产以 teamai/push/<user>/<ts> MR 分支落盘", () => {
    const c = check("dev.submit");
    expect(c.ok, c.detail).toBe(true);
  });

  it("5. review.merge:reviewer 合并三条分支进 main,skill/rule/doc 都在,4 人 digest 一致", () => {
    const c = check("review.merge");
    expect(c.ok, c.detail).toBe(true);
    expect(report?.visibility?.consistent, report?.visibility?.detail).toBe(true);
    expect(report?.visibility?.members.length).toBe(4);
  });

  it("6. review.comment:reviewer 留两条意见并把 issue 推到 doing,推 review 活动", () => {
    const c = check("review.comment");
    expect(c.ok, c.detail).toBe(true);
  });

  it("7. dev.revise:作者推同名 skill 第二版并合入,main 内容已是第二版", () => {
    const c = check("dev.revise");
    expect(c.ok, c.detail).toBe(true);
  });

  it("8. contribute:作者经验进 learnings,digest.learnings 含该标题", () => {
    const c = check("contribute");
    expect(c.ok, c.detail).toBe(true);
  });

  it("9. remove:作者下线自己的 rule,main 上消失且 skill/doc 无附带损伤", () => {
    const c = check("remove");
    expect(c.ok, c.detail).toBe(true);
  });

  it("10. roles:owner 新增 qa 角色,30s 内 4 条连接 digest.roles 都出现 qa", () => {
    const c = check("roles");
    expect(c.ok, c.detail).toBe(true);
  });

  it("11. inspect:teamaiList 与 main 实际资产一一对应,teamaiStatus 无差异,doctor.ok=true", () => {
    const c = check("inspect");
    expect(c.ok, c.detail).toBe(true);
  });

  it("12. activity.isolation:未登记项目事件仅本人可见,team 项目事件 4 人全可见", () => {
    const c = check("activity.isolation");
    expect(c.ok, c.detail).toBe(true);
  });

  it("13. weekly:teamActivityDigest 的 perMember/total 与本次实际事件数一致", () => {
    const c = check("weekly");
    expect(c.ok, c.detail).toBe(true);
    expect(report?.weekly?.total).toBeGreaterThan(0);
    expect(report?.weekly?.perMember.length).toBeGreaterThan(1);
  });
});
