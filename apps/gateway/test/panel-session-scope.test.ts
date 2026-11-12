/**
 * 看板绑会话 / 会话作用域(n6/n9)契约测试:
 *  ①openSession 内调用 onSessionChange(切会话=全部已激活卡重取数);
 *  ②cvActivated 键含 sid(切 session 对已激活卡全部 reload,不再是一次性门);
 *  ③PAGE 含 session.owner.get / session.owner.result 通道(会话→归属项目由服务端裁定);
 *  ④代码档案(Atlas)取数优先 ownerProjectId(会话归属项目),归属未知/为空时回退并标注;
 *  ⑤其余看板作用域标注(项目级/全局)在位。
 * 零反斜杠纪律:全部 includes 字面断言。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 纯静态:不接 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

describe("看板绑会话 · 会话作用域(n6/n9)", () => {
  it("①openSession 内调用 onSessionChange(统一出口),草稿态也走", async () => {
    await withPanel(7961, (html) => {
      const open = extractFn(html, "openSession");
      expect(open).toContain("onSessionChange(sid)");
      // 位置在会话上下文就位之后(currentSid 已赋值),否则重载会带上一会话的 id
      expect(open.indexOf("currentSid = sid")).toBeLessThan(open.indexOf("onSessionChange(sid)"));
      // 草稿态新建同样走统一出口(空会话作用域)
      expect(extractFn(html, "newDraft")).toContain('onSessionChange("")');
      // onSessionChange 职责:登记会话、问归属、按会话重载已激活卡
      const osc = extractFn(html, "onSessionChange");
      expect(osc).toContain("cvSessionSid = next");
      expect(osc).toContain('type: "session.owner.get"');
      expect(osc).toContain("loadViewData(view, next)");
      // 重载入参显式带上新 sid(不隐式读全局)
      expect(extractFn(html, "loadViewData")).toContain("const s = sid === undefined ? currentSid : sid;");
    });
  }, 30_000);

  it("②cvActivated 键含 sid:切 session 后已激活卡全部按新会话重载", async () => {
    await withPanel(7962, (html) => {
      // 键形态 sid|card
      const key = extractFn(html, "cvActKey");
      expect(key).toContain('(sid || "_") + "|" + card');
      // 属性名原文断言:一次性门按会话维度,不再是 Set<view>
      expect(html).toContain("const cvActivated = new Set();");
      expect(html).toContain("cvActivated.add(key)");
      // 卡片激活用 sid 组键
      expect(extractFn(html, "canvasActivateCard")).toContain("cvActKey(currentSid, view)");
      // onSessionChange 按新 sid 逐视图重载,已在场则幂等跳过
      const osc = extractFn(html, "onSessionChange");
      expect(osc).toContain("cvActKey(next, view)");
 // 画布新鲜度:白板目录按会话分片(board-store 的 boardDir(root,sid)),
 // board 卡切会话一律重取(旧一次性门会把上次离开该会话时的快照当本会话数据);
 // 其余会话维度视图仍按幂等门跳过。
      expect(osc).toContain('if (view === "board") bdViewDirty = false;');
      expect(osc).toContain('if (cvActivated.has(key) && view !== "board") continue;');
      expect(osc).not.toContain("if (cvActivated.has(key)) continue;");
      // 「曾激活过的视图」由任意会话键反推(lastIndexOf("|"))
      expect(osc).toContain('String(key).lastIndexOf("|")');
      // 行为:同视图不同会话 → 不同键;空会话统一 "_"
      const f = new Function('function cvActKey(sid, card) { return (sid || "_") + "|" + card; }' + String.fromCharCode(10) + "return cvActKey;")() as (s: string, c: string) => string;
      expect(f("s1", "board")).not.toBe(f("s2", "board"));
      expect(f("", "board")).toBe(f("_", "board"));
      expect(f("s1", "board")).toBe("s1|board");
    });
  }, 30_000);

  it("③PAGE 含 session.owner.get / session.owner.result 通道(契约收发 + 防御)", async () => {
    await withPanel(7963, (html) => {
      // 发:切会话即问归属;无会话不白发
      expect(html).toContain('type: "session.owner.get"');
      expect(html).toContain('if (next) wsSafeSend(JSON.stringify({ v: 1, type: "session.owner.get", sessionId: next }));');
      // 收:缓存 sid→projectId,null=明确无归属(与未查区分)
      expect(html).toContain('m.type === "session.owner.result"');
      expect(html).toContain("sessionOwnerMap.set(osid,");
      expect(html).toContain("m.projectId === null || m.projectId === undefined ? null : String(m.projectId)");
      // 三态查询状态机:known / unknown
      expect(extractFn(html, "sessionOwnerState")).toContain('sessionOwnerMap.has(sid) ? "known" : "unknown"');
      // 防御:畸形/缺 sessionId 回包不炸、不清缓存
      const res = html.slice(html.indexOf('m.type === "session.owner.result"'), html.indexOf('m.type === "session.owner.result"') + 700);
      expect(res).toContain("if (!osid) return;");
      // 补拉通道(档案卡头归属未知时)
      expect(extractFn(html, "ownerPull")).toContain('type: "session.owner.get"');
    });
  }, 30_000);

  it("④Atlas 优先 ownerProjectId:归属已知用归属项目,未知先当前项目+等回包,无归属回退并标注", async () => {
    await withPanel(7964, (html) => {
      // 取数决策函数:会话归属项目优先
      const op = extractFn(html, "ownerProjectId");
      expect(op).toContain("sessionOwnerMap.get(sid)");
      expect(op).toContain("if (pid) return pid;");
      expect(op).toContain('return activeProjectId || "__harness__"');
      // 入口:已知归属用 ownerProjectId;未知先 activeProjectId + arcOwnerPending + 补拉
      const entry = extractFn(html, "openProfileEntry");
      expect(entry).toContain('sessionOwnerState(sid) === "known"');
      expect(entry).toContain("ownerProjectId()");
      expect(entry).toContain("arcOwnerPending = true");
      expect(entry).toContain("ownerPull(sid)");
      // 回包到达:归属变了(或档案在等)→ 按归属项目重取
      expect(html).toContain("if (arcOwnerPending || (ppId && ppId !== wantPid)) { arcOwnerPending = false; openProfile(wantPid); }");
      // 卡头标注:会话归属项目 / 该会话无归属项目 · 显示当前项目
      const note = extractFn(html, "ppOwnerNote");
      expect(note).toContain("会话归属项目:");
      expect(note).toContain("无归属项目");
      expect(note).toContain("显示当前项目");
      expect(note).toContain("pp-own-warn");
      // 看板子标签同口径(session 维度锁定项目)
      expect(extractFn(html, "dashLockScope")).toContain("ownerProjectId()");
      // 行为:归属明确 → 用归属;归属 null → 回退当前项目;未查 → 回退当前项目
      const mk = (map: Map<string, string | null>, active: string) => {
        const fn = new Function("sessionOwnerMap", "activeProjectId",
          "let currentSid = 's1';" + String.fromCharCode(10) +
          extractFn(html, "ownerProjectId") + String.fromCharCode(10) + "return ownerProjectId();") as
          (m: Map<string, string | null>, a: string) => string;
        return fn(map, active);
      };
      expect(mk(new Map([["s1", "ownerP"]]), "projX")).toBe("ownerP");
      expect(mk(new Map([["s1", null]]), "projX")).toBe("projX");
      expect(mk(new Map(), "")).toBe("__harness__");
    });
  }, 30_000);

  it("⑤其余看板作用域标注在位(项目级 / 全局 / 当前会话)", async () => {
    await withPanel(7965, (html) => {
      // 作用域徽标样式 + 至少四处卡头标注
      expect(html).toContain(".vw-scope{");
      expect(html).toContain("作用域:项目级");
      expect(html).toContain("作用域:全局");
      expect(html).toContain("作用域:当前会话");
      // 追踪/用量卡原有标注不回退
      expect(html).toContain('title="本卡取数作用域:跟踪的是当前选中会话"');
      expect(html).toContain("作用域:当前会话(前端过滤)");
      // 用量卡按会话过滤(前端过滤口径写明)
      expect(extractFn(html, "usageRender")).toContain("usageScopeOnly && scopeSid");
    });
  }, 30_000);
});
