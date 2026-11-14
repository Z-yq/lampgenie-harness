/**
 * ask_user 对象选项归一化(经验证:[{key,text}] 被 String 成 [object Object])。
 * 钉住:router 广播/pending 是文本;工具回执是「用户答复:<选项文本>」,不再出现对象字面量。
 */
import { describe, expect, it } from "vitest";
import { AskUserRouter } from "../src/ask-user-router.js";
import { askUserTool } from "../src/agent-wiring.js";

function routerWithSink(): { router: AskUserRouter; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const router = new AskUserRouter((m) => sent.push(m));
  router.online = true;
  return { router, sent };
}

describe("ask_user options 归一化", () => {
  it("router:对象选项在广播/pending 中变成文本,answer 正常回传", async () => {
    const { router, sent } = routerWithSink();
    const pending = router.ask("s1", {
      question: "选哪个方案?",
      options: [{ key: "a", text: "方案 A" }, { key: "b", text: "方案 B" }] as unknown as string[],
    });
    const ask = sent.find((m) => m.type === "ask.user")!;
    expect(ask.options).toEqual(["方案 A", "方案 B"]);
    expect(JSON.stringify(ask.options)).not.toContain("[object Object]");
    expect(router.pending()[0]?.options).toEqual(["方案 A", "方案 B"]);
    expect(router.answer(String(ask.requestId), "方案 A")).toBe(true);
    await expect(pending).resolves.toBe("方案 A");
  });

  it("tool:对象选项 → 工具回执是「用户答复:<文本>」,不是 [object Object]", async () => {
    const { router, sent } = routerWithSink();
    const tool = askUserTool("s1", router);
    const call = tool.execute({ question: "选哪个方案?", options: [{ key: "a", text: "方案 A" }] });
    const ask = sent.find((m) => m.type === "ask.user")!;
    expect(ask.options).toEqual(["方案 A"]);
    router.answer(String(ask.requestId), "方案 A");
    await expect(call).resolves.toBe("用户答复:方案 A");
  });
});
