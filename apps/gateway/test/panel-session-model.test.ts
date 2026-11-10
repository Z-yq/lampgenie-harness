import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** per-session 主模型 pill(白板「per-session 主模型」前端半边)的结构回归。
 * 真 UI 在 panel.ts 模板字符串内(浏览器侧),这里锁关键面不丢:currentSid 分支双语义
 * (session.model.set / cfg.set)、renderModelPill 覆盖优先回退全局、session.model.result
 * 回包校正缓存、切会话按初始化态决定拉取(session.model.get)或用缓存刷新、删除会话清缓存。
 * 零反斜杠纪律:全部 includes 字面断言,不用正则。 */
describe("per-session 主模型 pill", () => {
  const fetchHtml = async (port: number) => {
    const panel = servePanel(port, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      return await res.text();
    } finally {
      await panel.close();
    }
  };

  /** 从面板模板里抽出顶层函数源码(浏览器侧不可 import;panel.ts 是单文件模板+内嵌脚本,
   * 嵌套闭括号均有缩进,列 0 的 "}" 即函数尾)。 */
  const sliceTopFn = (html: string, header: string) => {
    const i = html.indexOf(header);
    expect(i, "找不到函数:" + header).toBeGreaterThan(0);
    const j = html.indexOf("\n}\n", i);
    expect(j, header + " 未闭合").toBeGreaterThan(i);
    return html.slice(i, j + 2);
  };

  it("pillPickModel:currentSid 与草稿态都发 session.model.set;草稿态永不发 cfg.set(2026-10-29 预设 sid)", async () => {
    const html = await fetchHtml(7911);
    const src = sliceTopFn(html, "function pillPickModel(v, providerId) {");
    // 已进入会话→只改本会话(session.model.set + staged 态:回包确认才落 sessionModelOverride)
    expect(src).toContain("const targetSid = currentSid || draftSidOf();");
    expect(src).toContain('type: "session.model.set"');
    // n8(2026-10-22):乐观直写缓存改为 staged——sessionModelOverride 只在 session.model.result 确认后写,
    // 选择瞬间只落 sessionModelStaged(pill 显新值+转轮,失败回滚)。原断言「乐观直写」由此条替代(非放宽)。
    expect(src).toContain("sessionModelStaged.set(targetSid,");
    expect(src).not.toContain("sessionModelOverride.set(targetSid,");
    // 2026-10-29 用户口径「模型切换只跟 session 走」:草稿态绑定预设会话 id 走同一 per-session 通道,
    // cfg.set(改全局 coding.llm)从快切路径整体退役——其余会话不再被一个草稿态切换殃及。
    expect(src).not.toContain('type: "cfg.set"');
    // 草稿预设 sid 帮手真实在场(按项目隔离键 zh:draft-sid:<pid>)
    expect(html).toContain("function draftSidOf() {");
    expect(html).toContain("zh:draft-sid:");
  });

  it("renderModelPill:先读 sessionModelOverride 覆盖,未命中回退 coding.llm.model", async () => {
    const html = await fetchHtml(7912);
    const src = sliceTopFn(html, "function renderModelPill(cfgView_) {");
    // 2026-10-29:覆盖读取键认会话与草稿预设 sid(currentSid || draftSid)
    expect(src).toContain("sessionModelOverride.get(currentSid || draftSid)");
    expect(src).toContain("cfg.coding.llm.model");
    // 覆盖命中分支带「·会话」尾标,且在全局回退分支之前
    expect(src.indexOf("sessionModelOverride.get(currentSid || draftSid)")).toBeGreaterThan(-1);
    expect(src.indexOf("·会话")).toBeGreaterThan(-1);
  });

  it("onmessage 注册含 session.model.result(校正缓存+当前会话刷新 pill)", async () => {
    const html = await fetchHtml(7913);
    expect(html).toContain('m.type === "session.model.result"');
    // null=服务端确认无覆盖;undefined=未初始化——回包统一落到 Map 与该语义区分
    expect(html).toContain("sessionModelOverride.set(m.sessionId, m.modelOverride || null)");
    // 刷新判定认会话与草稿预设 sid(2026-10-29)
    expect(html).toContain("if (m.sessionId === currentSid || (draftSidStored() && m.sessionId === draftSidStored())) { renderModelPill(cfgView); renderModelSwitch(); }");
  });

  it("切 session:未初始化发 session.model.get;已初始化(含 null)不重发只刷 pill;删会话清缓存", async () => {
    const html = await fetchHtml(7914);
    const src = sliceTopFn(html, "function openSession(sid) {");
    // Map 无条目(=undefined 未初始化)→拉取;有条目(含 null)→直接用缓存刷 pill
    expect(src).toContain("sessionModelOverride.has(sid)");
    expect(src).toContain('type: "session.model.get"');
    expect(src).toContain("if (sessionModelOverride.has(sid)) renderModelPill(cfgView)");
    // deleteSession 菜单确认回调内清掉该会话缓存(防跨会话串显)
    expect(html).toContain("sessionModelOverride.delete(t.sessionId)");
  });

  /** n8/n9(2026-10-22):失败可见 + 清除覆盖 + 草稿首发补发。以下三条是白板 per-session 主模型闭环的
   * 仲裁条件:routeError 不能停在新模型上、model:null 必须能回到全局、草稿态所选模型必须真的用上。 */
  it("n8 routeError / ok:false → toast 报错 + pill 回滚到 effective(不停在新模型上);warning → 轻提示", async () => {
    const html = await fetchHtml(7915);
    // 回包处理必须消费 effective / routeError / warning / revision 四字段
    const i = html.indexOf('if (m.type === "session.model.result") {');
    expect(i).toBeGreaterThan(0);
    const src = html.slice(i, html.indexOf('if (m.type === "session.owner.result")', i));
    expect(src).toContain("m.ok === false");
    expect(src).toContain("m.routeError");
    expect(src).toContain("m.warning");
    expect(src).toContain("m.revision");
    expect(src).toContain("m.effective");
    // 失败路径:清 staged → toast(错误色)→ modelPillRollback(回滚到 effective 或上次已确认值)
    expect(src).toContain("sessionModelStaged.delete(m.sessionId)");
    expect(src).toContain("会话模型切换失败:");
    expect(src).toContain("modelPillRollback(m.sessionId, eff || null)");
    expect(src.indexOf("modelPillRollback(m.sessionId")).toBeLessThan(src.indexOf("sessionModelOverride.set(m.sessionId, m.modelOverride || null)"));
    // 回滚实现:清 staged + 用 effective 覆盖 + 标红一拍后恢复(renderModelPill 重画)
    const rb = sliceTopFn(html, "function modelPillRollback(sid, effectiveModel) {");
    expect(rb).toContain("sessionModelStaged.delete(sid || \"_draft\")");
    expect(rb).toContain("if (effectiveModel) sessionModelOverride.set(sid, { model: String(effectiveModel) })");
    expect(rb).toContain("renderModelPill(cfgView)");
    expect(rb).toContain("staged-err");
    // 失败绝不写 sessionModelOverride=新模型:失败分支只写 null 或服务端回的真值
    expect(src).not.toContain("sessionModelStaged.get");
    // 成功但 warning → 黄色轻提示(warning 分支存在且带「已落盘,但可能未生效」)
    expect(src).toContain("已落盘,但可能未生效");
    // 「轻提示」不能冒充失败:warning 走 toast 的 warn 语气(.toast.warn 黄条),不是 err 红条
    expect(src).toContain('(已落盘,但可能未生效)", "warn")');
    expect(html).toContain(".toast.warn{");
    expect(sliceTopFn(html, "function toast(text, isErr) {")).toContain('isErr === "warn" ? " warn"');
    // staged 兜底:回包丢失时不得把 pill 永久钉在「切换中」(TTL 超时回落已确认值)
    expect(html).toContain("const MODEL_STAGED_TTL = 15000;");
    expect(sliceTopFn(html, "function renderModelPill(cfgView_) {")).toContain("MODEL_STAGED_TTL");
  });

  it("n8 模型菜单含「跟随全局(清除会话覆盖)」→ 发 session.model.set {model: null}", async () => {
    const html = await fetchHtml(7916);
    // 菜单项在位(pm-follow 行,文案与 title 写明清除会话覆盖)
    expect(html).toContain("跟随全局(清除会话覆盖)");
    expect(html).toContain("pm-follow");
    expect(html).toContain("清除本会话的模型覆盖,回到全局主模型");
    // 点击/键盘都走 pillPickModel(null) → 发 model: null
    const bind = sliceTopFn(html, "function modelMenuBind(el, groups, current, subKey) {");
    expect(bind).toContain('act === "follow"');
    expect(bind).toContain("pillPickModel(null");
    // pillPickModel 的 null 分支:发 set{model:null}(协议已支持 null=清除覆盖;键=targetSid)
    const pick = sliceTopFn(html, "function pillPickModel(v, providerId) {");
    expect(pick).toContain("sessionId: targetSid, model: v");
    // 成功后 modelOverride=null 落缓存 → renderModelPill 回退全局 coding.llm.model
    const pill = sliceTopFn(html, "function renderModelPill(cfgView_) {");
    expect(pill).toContain("ov && ov.model");
    expect(pill).toContain("(未配)");
  });

  it("n9 草稿提交消费预设 sid:模型覆盖已在 pillPickModel 绑定,staged 在飞才暂存等回包(2026-10-29)", async () => {
    const html = await fetchHtml(7917);
    const src = sliceTopFn(html, "function submit(overrideText, projectOverride) {");
    // 2026-10-29:草稿不再新建一次性 sid,直接消费当前项目预设会话 id(与模型覆盖绑定同一 sid)
    expect(src).toContain("const sid = currentSid || draftSidOf();");
    // pending 判定=该预设会话的 staged 还在等回包(覆盖已确认则直发 task.submit,不再补发 set)
    const atPending = src.indexOf("if (wasDraftPending) {");
    expect(atPending).toBeGreaterThan(0);
    expect(src).toContain("const wasDraftPending = wasDraft && sessionModelStaged.has(sid);");
    const atSubmit = src.indexOf('type: "task.submit", sessionId: sid');
    expect(atSubmit).toBeGreaterThan(0);
    expect(atPending).toBeLessThan(atSubmit);
    const patch = src.slice(atPending, atSubmit);
    expect(patch).toContain("draftSubmitPending = { sid, text, atts, projectId: submitProjectId");
    expect(patch).not.toContain('type: "session.model.set"'); // set 已在 pillPickModel 发过,submit 不再补发
  });

  /** m4/m9/m7-front(2026-10-22)本轮补齐的三面:草稿首发等回包(pending 链)、跨会话 toast 隔离 + staged 防连点、
   *  effort 字段透传。断言一律走「源码位置关系 + 字面片段」,不跑真 UI(浏览器侧不可 import)。 */
  it("m4 草稿首发 pending:任务体暂存等回包;task.submit 只在 result ok 后才发(两条路径唯一)", async () => {
    const html = await fetchHtml(7921);
    // ① pending 容器与超时兜底存在(8s)
    expect(html).toContain("let draftSubmitPending = null;");
    expect(html).toContain("const DRAFT_MODEL_ACK_TIMEOUT = 8000;");
    // ② submit 草稿分支(2026-10-29):staged 在飞(wasDraftPending)→ 挂 pending(暂存任务体+定时器)
    //    → return,不再往下直发 submit;session.model.set 已在 pillPickModel 发过,submit 不再补发
    const sub = sliceTopFn(html, "function submit(overrideText, projectOverride) {");
    const atPending = sub.indexOf("draftSubmitPending = { sid, text, atts, projectId: submitProjectId");
    const atGuard = sub.indexOf("if (wasDraftPending) {");
    const atReturn = sub.indexOf("return;", atGuard);
    const atDirectSubmit = sub.indexOf('type: "task.submit", sessionId: sid');
    expect(atPending).toBeGreaterThan(0);
    expect(atGuard).toBeGreaterThan(0);
    expect(atPending).toBeGreaterThan(atGuard); // 判定在前,挂 pending 在后
    expect(atReturn).toBeGreaterThan(atPending); // 挂完立即 return
    expect(sub.slice(atReturn, atDirectSubmit)).toContain("}"); // 直发 submit 在 return 之后(=只在非 pending 分支可达)
    expect(sub.slice(atGuard, atReturn)).not.toContain('type: "task.submit"');
    expect(sub, "超时兜底走 abort,不是静默放行").toContain('draftModelAbort("模型切换确认超时(服务端未回包)"');
    // ③ 派发点只在 draftSubmitFire 内(回包 ok 分支调用),且摘链在前=同一 pending 只发一次
    const fire = sliceTopFn(html, "function draftSubmitFire() {");
    expect(fire).toContain('type: "task.submit"');
    expect(fire.indexOf("draftSubmitPending = null")).toBeLessThan(fire.indexOf('type: "task.submit"'));
    expect(fire).toContain("if (!p) return;");
    expect(html).toContain("if (pend && !failed) draftSubmitFire();");
    // ④ result 块里派发发生在成功判定之后(failed 分支绝不派单)
    const i = html.indexOf('if (m.type === "session.model.result") {');
    const resSrc = html.slice(i, html.indexOf('if (m.type === "session.owner.result")', i));
    expect(resSrc.indexOf("if (pend && !failed) draftSubmitFire();")).toBeGreaterThan(resSrc.indexOf("} else {"));
    // ⑤ 防重复:submit 入口在 pending 在飞时直接 return
    expect(sub.indexOf("if (draftSubmitPending) {")).toBeGreaterThan(0);
    expect(sub.indexOf("if (draftSubmitPending) {")).toBeLessThan(sub.indexOf("lastSubmitAt = Date.now();") + 1000);
    expect(sub).toContain("首轮消息正在等模型切换确认");
    // ⑥ 收尾逻辑单一来源(两路都走 finishSubmit),且同视图才动输入框
    expect(sub).toContain("finishSubmit(sid, text, atts, wasDraft);");
    expect(fire).toContain("finishSubmit(p.sid, p.text, p.atts || [], true, sameView);");
    const fin = sliceTopFn(html, "function finishSubmit(sid, text, atts, wasDraft, sameView) {");
    expect(fin).toContain("if (sameView === false) { renderSendBtn(); return; }");
  });

  it("m4 routeError/ok:false/超时:不发 task.submit,回滚 pill,保留草稿与 draftModelRetry", async () => {
    const html = await fetchHtml(7922);
    const abort = sliceTopFn(html, "function draftModelAbort(why, effModel) {");
    // 绝不派单:abort 内没有任何 task.submit
    expect(abort).not.toContain('type: "task.submit"');
    // 回滚 + 保留重试料 + 解除 3s 同文本防重复(2026-10-29:重试料从 staged 在飞值捞取)
    expect(abort).toContain("const pickInFlight = sessionModelStaged.get(p.sid)");
    expect(abort).toContain("sessionModelStaged.delete(p.sid)");
    expect(abort).toContain("modelPillRollback(p.sid, effModel ? String(effModel) : null)");
    expect(abort).toContain("draftModelRetry = pickInFlight && pickInFlight.model");
    expect(abort).toContain('lastSubmitText = "";');
    // 失败 toast 带原因(routeError/message/code 汇总的 why)
    expect(abort).toContain("会话模型未确认,任务未发送:");
    expect(abort).toContain('String(why).slice(0, 80)');
    // 失败分支接线:pend 命中走 abort(不派单),无 pending 才是旧 modelPillRollback 分支
    const i = html.indexOf('if (m.type === "session.model.result") {');
    const resSrc = html.slice(i, html.indexOf('if (m.type === "session.owner.result")', i));
    const atAbort = resSrc.indexOf("if (pend) draftModelAbort(String(why), eff);");
    expect(atAbort).toBeGreaterThan(0);
    expect(resSrc.slice(atAbort)).toContain("modelPillRollback(m.sessionId, eff || null);"); // 无 pending 的原有分支保留(不回归)
    // pending 命中时避免双份红 toast(失败提示只由 abort 出)
    expect(resSrc.indexOf("draftModelAbort(String(why), eff);")).toBeLessThan(resSrc.indexOf('toast("会话模型切换失败:'));
  });

  it("m9 回包是广播:失败/warn toast 只对本标签会话或命中本标签 pending 弹,其它会话仅静默更新缓存", async () => {
    const html = await fetchHtml(7923);
    const i = html.indexOf('if (m.type === "session.model.result") {');
    const resSrc = html.slice(i, html.indexOf('if (m.type === "session.owner.result")', i));
    // 门槛值:本标签当前会话 or 命中本标签 pending or 本标签草稿预设会话(2026-10-29)
    expect(resSrc).toContain("const pend = draftSubmitPending && draftSubmitPending.sid === m.sessionId ? draftSubmitPending : null;");
    expect(resSrc).toContain("const loud = m.sessionId === currentSid || !!pend || (draftSidStored() === m.sessionId && !!m.sessionId);");
    // 失败 toast 与 warn toast 都被 loud 约束(不再裸 toast)
    expect(resSrc).toContain('if (loud) toast("会话模型切换失败:');
    expect(resSrc).toContain('if (loud && m.warning) toast("会话模型: ');
    expect(resSrc).toContain("else if (loud && m.effective && m.effective.model");
    // 缓存更新不受 loud 约束(别会话回包仍然静默对齐,避免切过去看到旧值)
    expect(resSrc).toContain("sessionModelOverride.set(m.sessionId, m.modelOverride || null)");
    expect(resSrc).toContain("sessionModelRev.set(m.sessionId, Number(m.revision))");
    // 广播回包只在当前会话或草稿预设会话才重画 pill(2026-10-29)
    expect(resSrc).toContain("if (m.sessionId === currentSid || (draftSidStored() && m.sessionId === draftSidStored())) { renderModelPill(cfgView); renderModelSwitch(); }");
  });

  it("m9 pillPickModel staged 有效期内直接 return(防连点撞 revision-mismatch);过期才放行", async () => {
    const html = await fetchHtml(7924);
    const pick = sliceTopFn(html, "function pillPickModel(v, providerId) {");
    const atGuard = pick.indexOf("const prev = sessionModelStaged.get(m9Sid);");
    expect(atGuard).toBeGreaterThan(0);
    const guard = pick.slice(atGuard, pick.indexOf('type: "session.model.set"'));
    // TTL 过期才放行;未过期:同值静默、异值一次黄色轻提示,两条路径都 return(不发 set)
    expect(guard).toContain("if (Date.now() - prev.at > MODEL_STAGED_TTL) sessionModelStaged.delete(m9Sid);");
    expect(guard).toContain("if (prev.model !== v) toast(\"模型切换中(等待服务端确认),请稍候再选\", \"warn\");");
    expect(guard).toContain("return;");
    // 判重发生在发 set 之前(否则连点已经发出去了)
    expect(pick.indexOf("const prev = sessionModelStaged.get(m9Sid);")).toBeLessThan(pick.indexOf('type: "session.model.set"'));
    // 轻提示走 warn 语气,不冒充失败(红条)
    expect(guard).toContain('"warn"');
    // staged 登记仍带 at(判重/TTL 依赖同一时间戳)
    expect(pick).toContain("sessionModelStaged.set(targetSid, { model: v,");
  });

  it("m7-front effort:session.model.set 带 effort(string|null),缓存 effort 进 pill 文案", async () => {
    const html = await fetchHtml(7925);
    // 取值源=composer 思考力度(effortV),""=关→null(可选字段,不带也不影响后端旧语义)
    const ef = sliceTopFn(html, "function sessionModelEffort() {");
    expect(ef).toContain("return effortV ? String(effortV) : null;");
    const pick = sliceTopFn(html, "function pillPickModel(v, providerId) {");
    expect(pick).toContain("const eff = sessionModelEffort();");
    expect(pick).toContain("effort: eff,"); // 与会话 set 一起透传(会话态与草稿态同一通道)
    // 2026-10-29:草稿态同一 set 带 effort;不再有「草稿 draftModelPick 补发」的第二条 set
    expect(pick).toContain('type: "session.model.set", sessionId: targetSid');
    expect(pick).toContain("effort: eff, ...(rev !== undefined");
    // pill 读取缓存 effort:staged 与已确认覆盖都显示「model · effort」
    const pill = sliceTopFn(html, "function renderModelPill(cfgView_) {");
    expect(pill).toContain("staged.effort");
    expect(pill).toContain('(staged.effort ? " · " + staged.effort : "")');
    expect(pill).toContain("const ovEff = ov.effort ? String(ov.effort) : \"\";");
    expect(pill).toContain('(ovEff ? " · " + ovEff : "")');
    // 回包侧落地:session.model.result 的 effort(顶层优先,其次 modelOverride.effort)写进缓存,缺字段不写空值
    expect(html).toContain("const ackedEffort = m.effort !== undefined ? m.effort : (m.modelOverride && m.modelOverride.effort !== undefined ? m.modelOverride.effort : undefined);");
    expect(html).toContain("effort: ackedEffort === null ? null : String(ackedEffort)");
    // 只透传不新增 UI:模型菜单 HTML 不因 effort 多出条目
    const menu = sliceTopFn(html, "function modelMenuHtml(groups, current, subKey) {");
    expect(menu).not.toContain("effort");
  });
});
